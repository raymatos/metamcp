import { afterEach, describe, expect, it, vi } from "vitest";

// The pool's import chain reaches the live DB (config.service -> config.repo
// -> db/index throws without DATABASE_URL). These tests exercise pure
// in-memory session bookkeeping, so stub the DB-touching modules out.
vi.mock("../config.service", () => ({
  configService: {},
}));
vi.mock("./client", () => ({
  connectMetaMcpClient: vi.fn(),
}));
vi.mock("./server-error-tracker", () => ({
  serverErrorTracker: {
    recordServerError: vi.fn(),
    resetServerErrorStatus: vi.fn(),
  },
}));

import { McpServerPool } from "./mcp-server-pool";

/**
 * Focused tests for cleanupSession's shared-client handling.
 *
 * The at-cap reuse paths hand the SAME ConnectedClient instance to multiple
 * sessionIds. Reaping one of those sessions must not recycle or destroy the
 * client while another live session still holds it (doing so killed the
 * surviving session's transport — observed as "Backend connection lost ...
 * retrying once" floods after the idle reaper fired).
 *
 * The constructor is private (compile-time only), so tests instantiate via an
 * `any` cast and poke internal maps directly; the timers it starts are cleared
 * in teardown.
 */

type AnyPool = {
  activeSessions: Record<string, Record<string, unknown>>;
  idleSessions: Record<string, unknown>;
  sessionToServers: Record<string, Set<string>>;
  sessionTimestamps: Record<string, number>;
  cleanupTimer: NodeJS.Timeout | null;
  healthCheckTimer: NodeJS.Timeout | null;
  cleanupSession(sessionId: string): Promise<void>;
};

const pools: AnyPool[] = [];

function makePool(): AnyPool {
  const PoolCtor = McpServerPool as unknown as new (
    defaultIdleCount?: number,
    maxTotalConnections?: number,
    maxStdioConnectionsPerServer?: number,
    maxHttpConnectionsPerServer?: number,
  ) => AnyPool;
  const pool = new PoolCtor(1, 100, 3, 15);
  pools.push(pool);
  return pool;
}

function fakeClient() {
  return { cleanup: vi.fn(async () => {}) };
}

function addSession(
  pool: AnyPool,
  sessionId: string,
  serverUuid: string,
  client: unknown,
) {
  pool.activeSessions[sessionId] = {
    ...(pool.activeSessions[sessionId] ?? {}),
    [serverUuid]: client,
  };
  pool.sessionToServers[sessionId] = new Set([
    ...(pool.sessionToServers[sessionId] ?? []),
    serverUuid,
  ]);
  pool.sessionTimestamps[sessionId] = Date.now();
}

afterEach(() => {
  for (const pool of pools) {
    if (pool.cleanupTimer) clearInterval(pool.cleanupTimer);
    if (pool.healthCheckTimer) clearInterval(pool.healthCheckTimer);
  }
  pools.length = 0;
});

describe("cleanupSession shared-client handling", () => {
  it("does not recycle or destroy a client another session still holds", async () => {
    const pool = makePool();
    const shared = fakeClient();
    addSession(pool, "session-a", "srv-1", shared);
    addSession(pool, "session-b", "srv-1", shared);

    await pool.cleanupSession("session-a");

    // A's bookkeeping is gone, but the client survives untouched for B.
    expect(pool.activeSessions["session-a"]).toBeUndefined();
    expect(pool.activeSessions["session-b"]["srv-1"]).toBe(shared);
    expect(shared.cleanup).not.toHaveBeenCalled();
    expect(pool.idleSessions["srv-1"]).toBeUndefined();
  });

  it("last holder recycles the shared client to the idle pool", async () => {
    const pool = makePool();
    const shared = fakeClient();
    addSession(pool, "session-a", "srv-1", shared);
    addSession(pool, "session-b", "srv-1", shared);

    await pool.cleanupSession("session-a");
    await pool.cleanupSession("session-b");

    // No idle existed, so the final release recycles instead of destroying.
    expect(shared.cleanup).not.toHaveBeenCalled();
    expect(pool.idleSessions["srv-1"]).toBe(shared);
  });

  it("still destroys an unshared client when an idle already exists", async () => {
    const pool = makePool();
    const idle = fakeClient();
    const extra = fakeClient();
    pool.idleSessions["srv-1"] = idle;
    addSession(pool, "session-a", "srv-1", extra);

    await pool.cleanupSession("session-a");

    expect(extra.cleanup).toHaveBeenCalledTimes(1);
    expect(pool.idleSessions["srv-1"]).toBe(idle);
  });

  it("still recycles an unshared client when no idle exists", async () => {
    const pool = makePool();
    const only = fakeClient();
    addSession(pool, "session-a", "srv-1", only);

    await pool.cleanupSession("session-a");

    expect(only.cleanup).not.toHaveBeenCalled();
    expect(pool.idleSessions["srv-1"]).toBe(only);
  });

  it("handles a session sharing one server but owning another", async () => {
    const pool = makePool();
    const shared = fakeClient();
    const owned = fakeClient();
    addSession(pool, "session-a", "srv-shared", shared);
    addSession(pool, "session-a", "srv-owned", owned);
    addSession(pool, "session-b", "srv-shared", shared);

    await pool.cleanupSession("session-a");

    // Shared client untouched; owned client recycled normally.
    expect(shared.cleanup).not.toHaveBeenCalled();
    expect(pool.activeSessions["session-b"]["srv-shared"]).toBe(shared);
    expect(pool.idleSessions["srv-shared"]).toBeUndefined();
    expect(pool.idleSessions["srv-owned"]).toBe(owned);
  });
});
