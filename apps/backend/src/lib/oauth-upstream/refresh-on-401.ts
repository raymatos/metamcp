// Server-side refresh-on-401 helper for the upstream proxy path.
//
// The backend's MCP client (`apps/backend/src/lib/metamcp/client.ts`) does
// not pass an OAuthClientProvider into the SDK transports, so the SDK has
// no built-in path to refresh tokens when the upstream returns 401. This
// helper closes that gap: it reads the persisted oauth_sessions row,
// POSTs `grant_type=refresh_token` to the upstream's token endpoint, and
// persists the new tokens back into the DB so the next connection attempt
// picks them up.
//
// Concurrency: an in-process per-server mutex (`inFlightRefreshes`)
// collapses simultaneous refresh attempts for the same MCP server into
// one upstream POST. Without this, providers that rotate refresh tokens
// (Google, Microsoft, Okta with rotation enabled) would consume the
// refresh_token on the first attempt and reject the second with
// `invalid_grant`, leaving one of the two connections stranded. The
// mutex is in-process only; multi-instance deployments still race across
// processes (acceptable cost for now — a DB-level CAS would be the
// follow-up).
//
// Acceptance criterion #3 from the OAuth-CORS-fix PR.

import { ServerParameters } from "@repo/zod-types";

import { oauthSessionsRepository } from "../../db/repositories";
import logger from "../../utils/logger";
import {
  discoverAuthorizationServerMetadataDetailed,
  OAuthTokens,
  redactToken,
  refreshAccessToken,
  resolveTokenEndpoint,
  resolveTokenEndpointAuthMethod,
  UpstreamTokenError,
} from "./token-exchange";

export interface RefreshResult {
  status:
    | "refreshed"
    | "no_refresh_token"
    | "no_session"
    | "no_client_id"
    | "reauth_required"
    | "failed";
  tokens?: OAuthTokens;
  error?: string;
  errorDescription?: string;
  upstreamStatus?: number;
}

// Per-server in-flight refresh promises. Concurrent callers for the same
// MCP server share the same upstream POST instead of racing on rotating
// refresh tokens. The map is cleared in a `finally` so a refresh failure
// doesn't permanently pin the server. Exposed for tests; do not depend on
// it from production code.
// Servers whose refresh_token the upstream has permanently rejected.
//
// OAuth 2.0 (RFC 6749 §5.2) defines `invalid_grant` on a refresh grant as the
// token being expired, revoked, or otherwise invalid — a PERMANENT condition
// that no amount of retrying fixes; only a human re-authorizing does. Without
// this breaker every 401 re-attempted the refresh, so a single dead credential
// produced a request every few seconds indefinitely (observed: 261 identical
// failures in under an hour for `cloudflare`, and the same for `i9labs-kanban`
// before it), burying the one fact that mattered — that a human needed to
// re-auth — in noise.
//
// Keyed by server uuid, holding a fingerprint of the refresh_token that was
// rejected. A different stored refresh_token means someone re-authorized, so
// the breaker opens automatically with no restart or manual reset.
const reauthRequired = new Map<string, { tokenFingerprint: string }>();

// Cheap, non-reversible fingerprint — never log or store the token itself.
function fingerprint(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 31 + token.charCodeAt(i)) | 0;
  }
  return `${token.length}:${hash}`;
}

/** True when this server is known to need a human re-authorization. */
export function isReauthRequired(serverUuid: string): boolean {
  return reauthRequired.has(serverUuid);
}

/** Clear the breaker — call after tokens are replaced by a re-authorization. */
export function clearReauthRequired(serverUuid: string): void {
  reauthRequired.delete(serverUuid);
}

/** Test seam. */
export function _resetReauthState(): void {
  reauthRequired.clear();
}

export const inFlightRefreshes = new Map<string, Promise<RefreshResult>>();

// Attempt to refresh upstream OAuth tokens for an MCP server. Returns a
// status describing what happened. Persists new tokens on success.
//
// NOTE: This is intentionally safe to call repeatedly — it short-circuits
// when there is no refresh_token or no client_id to use.
export async function tryRefreshUpstreamTokens(
  serverParams: Pick<ServerParameters, "uuid" | "name" | "url">,
): Promise<RefreshResult> {
  const inFlight = inFlightRefreshes.get(serverParams.uuid);
  if (inFlight) {
    logger.info(
      `[oauth] refresh already in flight for ${serverParams.uuid}; joining`,
    );
    return inFlight;
  }
  const promise = (async () => {
    try {
      return await doRefresh(serverParams);
    } finally {
      inFlightRefreshes.delete(serverParams.uuid);
    }
  })();
  inFlightRefreshes.set(serverParams.uuid, promise);
  return promise;
}

async function doRefresh(
  serverParams: Pick<ServerParameters, "uuid" | "name" | "url">,
): Promise<RefreshResult> {
  if (!serverParams.url) {
    return { status: "no_session" };
  }

  const session = await oauthSessionsRepository.findByMcpServerUuid(
    serverParams.uuid,
  );
  if (!session) {
    return { status: "no_session" };
  }

  const currentTokens = session.tokens as
    | (OAuthTokens & { refresh_token?: string })
    | null;
  if (!currentTokens?.refresh_token) {
    return { status: "no_refresh_token" };
  }

  // Circuit breaker: the upstream already rejected THIS refresh_token as
  // permanently invalid. Fail fast without a network call until the stored
  // token changes (i.e. someone re-authorized).
  const currentFingerprint = fingerprint(currentTokens.refresh_token);
  const known = reauthRequired.get(serverParams.uuid);
  if (known) {
    if (known.tokenFingerprint === currentFingerprint) {
      return {
        status: "reauth_required",
        error: "invalid_grant",
        errorDescription:
          "Refresh token was permanently rejected; re-authorize this server.",
      };
    }
    // Stored token differs — a re-authorization happened. Try again.
    reauthRequired.delete(serverParams.uuid);
    logger.info(
      `[oauth] ${serverParams.name} (${serverParams.uuid}) has new tokens; clearing reauth-required state`,
    );
  }

  const clientInformation = session.client_information as Record<
    string,
    unknown
  > | null;
  const clientId =
    clientInformation && typeof clientInformation.client_id === "string"
      ? (clientInformation.client_id as string)
      : null;
  if (!clientId) {
    return { status: "no_client_id" };
  }
  const clientSecret =
    typeof clientInformation?.client_secret === "string"
      ? (clientInformation.client_secret as string)
      : undefined;

  const { metadata: discovered, attempt: discoveryAttempt } =
    await discoverAuthorizationServerMetadataDetailed(serverParams.url);
  const resolution = resolveTokenEndpoint({
    clientInformation,
    discovered,
    serverName: serverParams.name,
    discoveryAttempt,
  });
  if (!resolution.ok) {
    // No endpoint could be resolved. Previously this fabricated
    // <origin>/token and POSTed into the dark; now it fails with the reason.
    logger.error(`[oauth] ${resolution.message} (server=${serverParams.uuid})`);
    return {
      status: "failed",
      error: "no_token_endpoint",
      errorDescription: resolution.message,
    };
  }
  const tokenEndpoint = resolution.tokenEndpoint;
  const authMethod = resolveTokenEndpointAuthMethod({
    clientInformation,
    discovered,
    hasSecret: Boolean(clientSecret),
  });

  logger.info(
    `[oauth] proxy 401 → refreshing tokens — server=${serverParams.uuid} ` +
      `(${serverParams.name}) token_endpoint=${tokenEndpoint} ` +
      `auth_method=${authMethod} ` +
      `refresh_token=${redactToken(currentTokens.refresh_token)}`,
  );

  let newTokens: OAuthTokens;
  try {
    newTokens = await refreshAccessToken({
      tokenEndpoint,
      refreshToken: currentTokens.refresh_token,
      clientId,
      clientSecret,
      authMethod,
      scope:
        typeof currentTokens.scope === "string"
          ? currentTokens.scope
          : undefined,
    });
  } catch (error) {
    if (error instanceof UpstreamTokenError) {
      const oauthError = error.oauthError?.error ?? "unknown";

      // `invalid_grant` is permanent: the refresh token is expired or revoked
      // and will never work again. Trip the breaker, say so ONCE and loudly,
      // and stop retrying until a human re-authorizes.
      if (oauthError === "invalid_grant") {
        reauthRequired.set(serverParams.uuid, {
          tokenFingerprint: currentFingerprint,
        });
        logger.error(
          `[oauth] RE-AUTHORIZATION REQUIRED — "${serverParams.name}" ` +
            `(${serverParams.uuid}) refresh token was permanently rejected ` +
            `(invalid_grant). This server's tools will keep failing until it ` +
            `is re-authorized in the MetaMCP UI. Suppressing further refresh ` +
            `attempts for it until its stored tokens change.`,
        );
        await flagServerNeedsReauth(serverParams);
        return {
          status: "reauth_required",
          error: oauthError,
          errorDescription:
            error.oauthError?.error_description ?? error.message,
          upstreamStatus: error.status,
        };
      }

      // Include WHERE the request went and WHAT came back. Without the URL,
      // a misrouted token request (HTML 404 from the upstream's web app, no
      // OAuth envelope, so error=unknown) is indistinguishable from the
      // upstream being down — the log has to carry it, because the line that
      // did name the endpoint is an INFO and production runs above INFO.
      // A body with no OAuth envelope means this response did not come from
      // an OAuth token endpoint at all. Name both plausible causes rather
      // than suppressing retries: it is either the wrong URL (permanent) or
      // the upstream mid-deploy with its edge serving an error page
      // (transient, and observed — STAGEAPH's 404s all landed within seconds
      // of a stage deploy finishing). Because the transient case is real,
      // this deliberately does NOT trip the reauth breaker; doing so would
      // lock out a healthy server on every deploy.
      const looksNonOAuth = Boolean(error.bodySnippet);
      const detail = [
        `token_endpoint=${tokenEndpoint}`,
        `source=${resolution.source}`,
        error.contentType ? `content_type=${error.contentType}` : null,
        error.bodySnippet ? `body="${error.bodySnippet}"` : null,
        looksNonOAuth
          ? "hint=non-OAuth response body; check the token endpoint is correct, or whether the upstream was mid-deploy"
          : null,
      ]
        .filter(Boolean)
        .join(" ");
      logger.warn(
        `[oauth] proxy refresh failed — server=${serverParams.uuid} ` +
          `status=${error.status} error=${oauthError} ${detail}`,
      );
      return {
        status: "failed",
        error: oauthError,
        errorDescription: error.oauthError?.error_description ?? error.message,
        upstreamStatus: error.status,
      };
    }
    logger.error(
      `[oauth] proxy refresh threw — server=${serverParams.uuid}:`,
      error,
    );
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "internal_error",
    };
  }

  await oauthSessionsRepository.upsert({
    mcp_server_uuid: serverParams.uuid,
    tokens: newTokens,
  });

  reauthRequired.delete(serverParams.uuid);

  logger.info(
    `[oauth] proxy refresh succeeded — server=${serverParams.uuid} ` +
      `access_token=${redactToken(newTokens.access_token)}`,
  );

  return { status: "refreshed", tokens: newTokens };
}

// Surface the dead credential where a human will actually see it: the server
// goes red in the MetaMCP UI, the same signal used for crashed servers. Best
// effort — a failure here must never mask the refresh outcome.
async function flagServerNeedsReauth(
  serverParams: Pick<ServerParameters, "uuid" | "name">,
): Promise<void> {
  try {
    const { serverErrorTracker } =
      await import("../metamcp/server-error-tracker");
    await serverErrorTracker.markServerNeedsReauth(serverParams.uuid);
  } catch (error) {
    logger.warn(
      `[oauth] could not flag ${serverParams.name} (${serverParams.uuid}) as needing reauth:`,
      error,
    );
  }
}
