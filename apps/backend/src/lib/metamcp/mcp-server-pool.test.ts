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
  pendingConnections: Record<string, number>;
  cleanupSession(sessionId: string): Promise<void>;
  countConnectionsForServer(serverUuid: string): number;
  getTotalConnectionCount(): number;
  canCreateConnectionForServer(serverUuid: string): boolean;
  reserveConnectionSlot(serverUuid: string): void;
  releaseConnectionSlot(serverUuid: string): void;
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

describe("connection counting", () => {
  // Regression: counts used to be session REFERENCES, not distinct clients.
  // The at-cap reuse path shares one client across many sessions, so counts
  // grew with session volume and eventually starved the global ceiling —
  // observed live as "76/4" for servers holding a handful of real connections,
  // which refused every new connection namespace-wide.
  it("counts one shared client once, not once per session holding it", () => {
    const pool = makePool();
    const shared = fakeClient();
    for (let i = 0; i < 40; i++) {
      addSession(pool, `session-${i}`, "srv-1", shared);
    }

    expect(pool.countConnectionsForServer("srv-1")).toBe(1);
    expect(pool.getTotalConnectionCount()).toBe(1);
  });

  it("counts genuinely distinct clients separately", () => {
    const pool = makePool();
    const a = fakeClient();
    const b = fakeClient();
    addSession(pool, "session-a", "srv-1", a);
    addSession(pool, "session-b", "srv-1", b);
    addSession(pool, "session-c", "srv-1", a); // shares a

    expect(pool.countConnectionsForServer("srv-1")).toBe(2);
  });

  it("counts an idle client and does not double-count it once active", () => {
    const pool = makePool();
    const client = fakeClient();
    pool.idleSessions["srv-1"] = client;
    expect(pool.countConnectionsForServer("srv-1")).toBe(1);

    addSession(pool, "session-a", "srv-1", client);
    expect(pool.countConnectionsForServer("srv-1")).toBe(1);
  });

  it("totals distinct clients across servers, not session x server pairs", () => {
    const pool = makePool();
    const s1 = fakeClient();
    const s2 = fakeClient();
    // 30 sessions each referencing both servers = 60 references, 2 connections.
    for (let i = 0; i < 30; i++) {
      addSession(pool, `session-${i}`, "srv-1", s1);
      addSession(pool, `session-${i}`, "srv-2", s2);
    }

    expect(pool.getTotalConnectionCount()).toBe(2);
  });

  it("includes reserved in-flight slots so concurrent spawns see each other", () => {
    const pool = makePool();
    expect(pool.countConnectionsForServer("srv-1")).toBe(0);

    pool.reserveConnectionSlot("srv-1");
    pool.reserveConnectionSlot("srv-1");
    expect(pool.countConnectionsForServer("srv-1")).toBe(2);
    expect(pool.getTotalConnectionCount()).toBe(2);

    pool.releaseConnectionSlot("srv-1");
    expect(pool.countConnectionsForServer("srv-1")).toBe(1);

    pool.releaseConnectionSlot("srv-1");
    expect(pool.countConnectionsForServer("srv-1")).toBe(0);
    expect(pool.pendingConnections["srv-1"]).toBeUndefined();
  });

  it("stops reporting a server as at-cap once shared references are deduped", () => {
    const pool = makePool(); // stdio cap 3
    const shared = fakeClient();
    for (let i = 0; i < 50; i++) {
      addSession(pool, `session-${i}`, "srv-1", shared);
    }
    // 50 references, 1 real connection — must still be under a cap of 3.
    expect(pool.canCreateConnectionForServer("srv-1")).toBe(true);
  });
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
