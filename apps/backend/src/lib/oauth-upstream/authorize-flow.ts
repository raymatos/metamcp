// Server-side OAuth authorize-flow preparation: discovery, dynamic client
// registration, and PKCE material — everything the browser used to do via
// the MCP SDK's `auth()` before redirecting to the upstream's /authorize.
//
// Why server-side: the SDK's browser path fetches the upstream's
// `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
// and POSTs `/register` cross-origin. Providers that don't set CORS headers
// on those endpoints (Resend, most enterprise IdPs) make the browser block
// every response, so the flow dies before the user ever sees an authorize
// page. All of these are plain server-to-server GETs/POSTs with no CORS
// constraint when MetaMCP's backend performs them — same rationale as the
// existing server-side token exchange in ./token-exchange.ts.
//
// This module is discovery + registration only. PKCE/state persistence and
// the final URL assembly live in the `prepareAuthorize` implementation in
// apps/backend/src/trpc/oauth.impl.ts, next to its exchangeToken sibling.

import crypto from "node:crypto";

import logger from "../../utils/logger";
import { OAuthAuthorizationServerMetadata } from "./token-exchange";

// RFC 9728 protected-resource metadata (the slice we consume).
export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  [key: string]: unknown;
}

export interface UpstreamAuthDiscovery {
  protectedResource: ProtectedResourceMetadata | null;
  // Base URL of the authorization server the metadata was found at (or the
  // MCP server URL itself when no protected-resource indirection exists).
  authorizationServerBase: string;
  metadata: OAuthAuthorizationServerMetadata | null;
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

// RFC 7636 §4.1-4.2: 32 random bytes base64url-encoded gives a 43-char
// verifier; the challenge is the base64url SHA-256 of the verifier's ASCII.
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

// GET a well-known JSON document. Returns null on any absence condition
// (network error, non-2xx) and throws on a malformed 2xx — matching the
// convention set by discoverAuthorizationServerMetadata in
// ./token-exchange.ts: silently dropping a misconfigured provider's
// metadata would mask real upstream bugs.
async function fetchWellKnownJson(
  url: URL,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    logger.warn(
      `OAuth discovery failed at ${url.href}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
  if (!response.ok) return null;

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(
      `OAuth discovery at ${url.href} returned 2xx but body was not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!data || typeof data !== "object") {
    throw new Error(
      `OAuth discovery at ${url.href} returned 2xx but body was not a JSON object`,
    );
  }
  return data as Record<string, unknown>;
}

// Candidate well-known URLs for a base URL that may carry a path component.
// RFC 8414 §3 / RFC 9728 §3: when the identifier has a path, the well-known
// suffix is inserted BETWEEN the origin and the path
// (`https://host/.well-known/<suffix>/path`); the root form is the fallback
// for providers that only publish metadata at the origin (Resend serves
// `/.well-known/oauth-protected-resource` but 404s the path-aware form).
function wellKnownCandidates(baseUrl: string, suffix: string): URL[] {
  const base = new URL(baseUrl);
  const candidates: URL[] = [];
  const path = base.pathname.replace(/\/+$/, "");
  if (path && path !== "") {
    candidates.push(new URL(`/.well-known/${suffix}${path}`, base.origin));
  }
  candidates.push(new URL(`/.well-known/${suffix}`, base.origin));
  return candidates;
}

export async function discoverProtectedResourceMetadata(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProtectedResourceMetadata | null> {
  for (const candidate of wellKnownCandidates(
    serverUrl,
    "oauth-protected-resource",
  )) {
    const data = await fetchWellKnownJson(candidate, fetchImpl);
    if (data) return data as ProtectedResourceMetadata;
  }
  return null;
}

// Authorization-server metadata discovery with the full candidate chain:
// path-aware and root forms of both the OAuth AS metadata document
// (RFC 8414) and the OIDC discovery document. First hit wins.
export async function discoverAuthServerMetadata(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthAuthorizationServerMetadata | null> {
  const candidates = [
    ...wellKnownCandidates(baseUrl, "oauth-authorization-server"),
    ...wellKnownCandidates(baseUrl, "openid-configuration"),
  ];
  for (const candidate of candidates) {
    const data = await fetchWellKnownJson(candidate, fetchImpl);
    if (data) return data as OAuthAuthorizationServerMetadata;
  }
  return null;
}

// Full discovery chain for an MCP server URL:
//   1. RFC 9728 protected-resource metadata at the server URL (path-aware,
//      then root).
//   2. The AS base is `authorization_servers[0..n]` from that metadata when
//      present, else the server URL itself.
//   3. RFC 8414 / OIDC metadata at the AS base (path-aware, then root).
//
// Never throws on absence — a fully-null result means the caller must fall
// back to convention endpoints (`<serverUrl>/authorize`, `<serverUrl>/token`),
// which matches the MCP SDK's default behavior.
export async function discoverUpstreamAuthMetadata(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamAuthDiscovery> {
  const protectedResource = await discoverProtectedResourceMetadata(
    serverUrl,
    fetchImpl,
  );

  const declaredServers = (protectedResource?.authorization_servers ?? [])
    .filter((s): s is string => typeof s === "string")
    .filter((s) => /^https?:\/\//i.test(s));
  const authServerBases = declaredServers.length
    ? declaredServers
    : [serverUrl];

  for (const base of authServerBases) {
    const metadata = await discoverAuthServerMetadata(base, fetchImpl);
    if (metadata) {
      return { protectedResource, authorizationServerBase: base, metadata };
    }
  }

  return {
    protectedResource,
    authorizationServerBase: authServerBases[0],
    metadata: null,
  };
}

export class DynamicRegistrationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DynamicRegistrationError";
    this.status = status;
  }
}

export interface RegisterDynamicClientInput {
  registrationEndpoint: string;
  clientMetadata: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

// RFC 7591 dynamic client registration, server-to-server. Returns the full
// registration response (client_id plus whatever else the provider issued —
// client_secret, registration_access_token, scope, ...) so the caller can
// persist it verbatim as `oauth_sessions.client_information`.
export async function registerDynamicClient({
  registrationEndpoint,
  clientMetadata,
  fetchImpl,
}: RegisterDynamicClientInput): Promise<Record<string, unknown>> {
  const doFetch = fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(clientMetadata),
    });
  } catch (error) {
    throw new DynamicRegistrationError(
      0,
      `Could not reach registration endpoint ${registrationEndpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON body; the status check below produces the error.
  }

  if (!response.ok) {
    const description =
      payload && typeof payload === "object"
        ? ((payload as { error_description?: string; error?: string })
            .error_description ??
          (payload as { error?: string }).error ??
          "registration rejected")
        : "registration rejected";
    throw new DynamicRegistrationError(
      response.status,
      `Dynamic client registration failed (HTTP ${response.status}): ${description}`,
    );
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { client_id?: unknown }).client_id !== "string"
  ) {
    throw new DynamicRegistrationError(
      response.status,
      "Registration endpoint returned 2xx but no client_id",
    );
  }

  return payload as Record<string, unknown>;
}
