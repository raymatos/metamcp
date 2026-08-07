import { ServerParameters } from "@repo/zod-types";

import logger from "@/utils/logger";

import { tryRefreshUpstreamTokens } from "../oauth-upstream/refresh-on-401";
import { isUpstreamUnauthorizedError } from "../oauth-upstream/token-exchange";
import { ConnectedClient } from "./client";
import { isRecoverableBackendError } from "./session-error";

/**
 * Minimal slice of McpServerPool the recovery wrapper needs. Structural
 * so tests can drive the wrapper with a fake pool.
 */
export interface RecoverySessionPool {
  invalidateServerConnection(
    sessionId: string,
    serverUuid: string,
  ): Promise<void>;
  getSession(
    sessionId: string,
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<ConnectedClient | undefined>;
}

export interface RequestWithSessionRecoveryOptions<T> {
  pool: RecoverySessionPool;
  sessionId: string;
  serverUuid: string;
  params: ServerParameters;
  namespaceUuid?: string;
  /** Operation label for log lines, e.g. "tools/list". */
  operation: string;
  /** Human-readable server name for log lines. */
  serverName: string;
  /** The (possibly stale) pooled session the caller already holds. */
  session: ConnectedClient;
  /**
   * The actual backend request(s). Re-invoked exactly once on a fresh
   * session if the first invocation fails with a recoverable backend
   * error (session-lost / transport-lost envelope).
   */
  attempt: (session: ConnectedClient) => Promise<T>;
  /**
   * Called when recovery swapped in a fresh session — lets the caller
   * repoint tool/prompt/resource maps to the new client.
   */
  onFreshSession?: (session: ConnectedClient) => void;
}

/**
 * Invalidate-and-retry-once recovery cascade for the per-server fetch
 * inside the aggregate list handlers (tools/list, prompts/list,
 * resources/list, resources/templates/list).
 *
 * The aggregate list handlers previously logged-and-continued in their
 * catch blocks, so a dead pooled session (e.g. after a restart of the
 * backend container) made the namespace return a "successful" 0-tool
 * response on every request, forever — the swallowed error meant the
 * zombie connection was never invalidated.
 *
 * Throws when the error is non-recoverable, when no fresh session could
 * be established, or when the retry on the fresh session fails — the
 * caller decides whether that excludes one server from an aggregate
 * response (and tracks it as degraded) or fails the request.
 */
export async function requestWithSessionRecovery<T>(
  opts: RequestWithSessionRecoveryOptions<T>,
): Promise<T> {
  try {
    return await opts.attempt(opts.session);
  } catch (error) {
    // A pooled session can outlive its upstream OAuth access token (most
    // providers issue 1h tokens; the pool holds connections indefinitely).
    // Requests on such a session fail with an upstream 401 that is neither
    // session-lost nor transport-lost, so without this branch the dead
    // session was never invalidated and the server stayed excluded from
    // every aggregate response until a manual backend restart. Recovery is
    // only worth attempting when a refresh_token is on file — the
    // invalidate + reconnect below routes through connectMetaMcpClient's
    // refresh-on-401 cascade, which needs it. Without one, reconnecting
    // would just retry the same dead token through the connect backoff and
    // stall the aggregate response for nothing.
    const authExpired =
      Boolean(opts.params.oauth_tokens?.refresh_token) &&
      isUpstreamUnauthorizedError(error);

    if (!isRecoverableBackendError(error) && !authExpired) {
      throw error;
    }

    logger.warn(
      `Backend ${authExpired ? "auth expired" : "connection lost"} for server ${opts.serverUuid} (${opts.serverName}) on ${opts.operation}; invalidating pool and retrying once. (envelope: ${
        error instanceof Error ? error.message : String(error)
      })`,
    );

    // Auth-expired sessions need the token refreshed BEFORE the reconnect,
    // not just a fresh transport. Providers that validate the JWT only on
    // real API calls (Resend) accept `initialize` with an expired
    // access_token, so the reconnect below succeeds without ever tripping
    // connectMetaMcpClient's refresh-on-401 — and the retried request fails
    // with the same expired token, forever. Refresh here, then hand the
    // rotated token to getSession via the mutated params. On refresh
    // failure fall through: the reconnect still gives providers that DO
    // 401 the initialize (the common case) their connect-time refresh path.
    if (authExpired) {
      try {
        const refresh = await tryRefreshUpstreamTokens(opts.params);
        if (refresh.status === "refreshed" && refresh.tokens) {
          opts.params.oauth_tokens = {
            access_token: refresh.tokens.access_token,
            token_type: refresh.tokens.token_type,
            expires_in: refresh.tokens.expires_in,
            scope:
              typeof refresh.tokens.scope === "string"
                ? refresh.tokens.scope
                : undefined,
            refresh_token:
              typeof refresh.tokens.refresh_token === "string"
                ? refresh.tokens.refresh_token
                : undefined,
          };
          logger.info(
            `[oauth] pre-reconnect refresh succeeded for ${opts.serverName} (${opts.serverUuid}) on ${opts.operation}`,
          );
        } else {
          logger.warn(
            `[oauth] pre-reconnect refresh did not rotate tokens for ${opts.serverName} (${opts.serverUuid}): ${refresh.status}`,
          );
        }
      } catch (refreshError) {
        logger.error(
          `[oauth] pre-reconnect refresh threw for ${opts.serverName} (${opts.serverUuid}):`,
          refreshError,
        );
      }
    }

    await opts.pool.invalidateServerConnection(opts.sessionId, opts.serverUuid);

    const fresh = await opts.pool.getSession(
      opts.sessionId,
      opts.serverUuid,
      opts.params,
      opts.namespaceUuid,
    );
    if (!fresh) {
      throw new Error(
        `Failed to re-initialize session for server ${opts.serverUuid} after backend session loss during ${opts.operation}`,
      );
    }

    opts.onFreshSession?.(fresh);
    return await opts.attempt(fresh);
  }
}
