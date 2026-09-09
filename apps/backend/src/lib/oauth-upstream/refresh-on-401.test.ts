import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories", () => ({
  oauthSessionsRepository: {
    findByMcpServerUuid: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../metamcp/server-error-tracker", () => ({
  serverErrorTracker: { markServerNeedsReauth: vi.fn() },
}));

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("tryRefreshUpstreamTokens", () => {
  const SERVER = {
    uuid: "00000000-0000-0000-0000-0000000000aa",
    name: "test-server",
    url: "https://api.example.com/mcp",
  };

  const loadModule = async () => {
    const repos = await import("../../db/repositories");
    const mod = await import("./refresh-on-401");
    return {
      tryRefreshUpstreamTokens: mod.tryRefreshUpstreamTokens,
      findByMcpServerUuid: repos.oauthSessionsRepository
        .findByMcpServerUuid as ReturnType<typeof vi.fn>,
      upsert: repos.oauthSessionsRepository.upsert as ReturnType<typeof vi.fn>,
      isReauthRequired: mod.isReauthRequired,
      resetReauthState: mod._resetReauthState,
    };
  };

  const sessionWithRefreshToken = (refreshToken: string) => ({
    mcp_server_uuid: SERVER.uuid,
    client_information: {
      client_id: "c1",
      token_endpoint: "https://upstream/token",
    },
    tokens: {
      access_token: "OLD",
      token_type: "Bearer",
      refresh_token: refreshToken,
    },
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetReauthState } = await loadModule();
    resetReauthState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns refreshed and persists new tokens on upstream 200", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();

    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_old",
      },
      code_verifier: null,
    });
    upsert.mockResolvedValue({});

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      return jsonResponse(200, {
        access_token: "NEW",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });

    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("refreshed");
    expect(result.tokens?.access_token).toBe("NEW");
    // Refresh token preserved per RFC 6749 §6.
    expect(result.tokens?.refresh_token).toBe("RT_old");
    expect(upsert).toHaveBeenCalledWith({
      mcp_server_uuid: SERVER.uuid,
      tokens: expect.objectContaining({
        access_token: "NEW",
        refresh_token: "RT_old",
      }),
    });
  });

  it("returns no_session when no oauth_sessions row exists", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue(undefined);
    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("no_session");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns no_refresh_token when session has tokens but no refresh_token", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: { client_id: "c1" },
      tokens: { access_token: "x", token_type: "Bearer" },
    });
    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("no_refresh_token");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("collapses concurrent refresh calls into a single upstream POST (mutex)", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();

    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_rotating",
      },
      code_verifier: null,
    });
    upsert.mockResolvedValue({});

    // The upstream is intentionally slow so both refresh calls overlap.
    // It is a rotating-refresh-token provider: the FIRST call sees
    // RT_rotating in the request and returns a new RT; the SECOND call
    // would normally see RT_rotating (stale) and 400 invalid_grant.
    // With the mutex, only ONE upstream POST happens, both callers share
    // its result.
    let postCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      postCount += 1;
      // 50ms delay so concurrent callers overlap deterministically.
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse(200, {
        access_token: "AT_new",
        token_type: "Bearer",
        refresh_token: "RT_rotated",
      });
    });

    const [a, b] = await Promise.all([
      tryRefreshUpstreamTokens(SERVER),
      tryRefreshUpstreamTokens(SERVER),
    ]);

    expect(a.status).toBe("refreshed");
    expect(b.status).toBe("refreshed");
    // Both callers observed the SAME tokens — they shared the in-flight
    // promise, so the upstream was hit exactly once.
    expect(a.tokens?.access_token).toBe("AT_new");
    expect(b.tokens?.access_token).toBe("AT_new");
    expect(postCount).toBe(1);
    // And we upsert exactly once.
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("allows a second refresh after the first completes (mutex releases)", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();

    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_one",
      },
      code_verifier: null,
    });
    upsert.mockResolvedValue({});

    let postCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      postCount += 1;
      return jsonResponse(200, {
        access_token: `AT_${postCount}`,
        token_type: "Bearer",
      });
    });

    await tryRefreshUpstreamTokens(SERVER);
    await tryRefreshUpstreamTokens(SERVER);
    expect(postCount).toBe(2);
  });

  it("releases the mutex even if the upstream throws (no permanent pinning)", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid } =
      await loadModule();

    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_one",
      },
      code_verifier: null,
    });

    // Deliberately a TRANSIENT upstream error: `invalid_grant` is permanent and
    // trips the reauth circuit breaker, which would short-circuit the second
    // call and mask what this test is actually about (mutex release).
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : (url as URL).toString();
        if (urlStr.includes("/.well-known/"))
          return new Response("nope", { status: 404 });
        return jsonResponse(503, { error: "temporarily_unavailable" });
      });

    const first = await tryRefreshUpstreamTokens(SERVER);
    expect(first.status).toBe("failed");
    const callsAfterFirst = fetchSpy.mock.calls.length;

    // If the mutex pinned, the second call would resolve to first's result
    // without touching the network. With the finally{} release it re-runs.
    const second = await tryRefreshUpstreamTokens(SERVER);
    expect(second.status).toBe("failed");
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("returns failed with upstream details when upstream rejects refresh", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_revoked",
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      return jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Refresh token revoked",
      });
    });

    const result = await tryRefreshUpstreamTokens(SERVER);
    // invalid_grant is permanent, so it is reported as needing re-auth rather
    // than as a generic (retryable) failure.
    expect(result.status).toBe("reauth_required");
    expect(result.error).toBe("invalid_grant");
    expect(result.upstreamStatus).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("reports a NON-permanent upstream error as retryable failed", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, isReauthRequired } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue(sessionWithRefreshToken("RT_live"));

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      return jsonResponse(503, { error: "temporarily_unavailable" });
    });

    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("failed");
    // A transient error must NOT trip the breaker.
    expect(isReauthRequired(SERVER.uuid)).toBe(false);
  });
});

describe("invalid_grant circuit breaker", () => {
  const SERVER = {
    uuid: "00000000-0000-0000-0000-0000000000bb",
    name: "dead-cred-server",
    url: "https://api.example.com/mcp",
  };

  const loadModule = async () => {
    const repos = await import("../../db/repositories");
    const mod = await import("./refresh-on-401");
    return {
      tryRefreshUpstreamTokens: mod.tryRefreshUpstreamTokens,
      isReauthRequired: mod.isReauthRequired,
      resetReauthState: mod._resetReauthState,
      findByMcpServerUuid: repos.oauthSessionsRepository
        .findByMcpServerUuid as ReturnType<typeof vi.fn>,
    };
  };

  const session = (refreshToken: string) => ({
    mcp_server_uuid: SERVER.uuid,
    client_information: {
      client_id: "c1",
      token_endpoint: "https://upstream/token",
    },
    tokens: {
      access_token: "OLD",
      token_type: "Bearer",
      refresh_token: refreshToken,
    },
  });

  const rejectWith = (error: string) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      return jsonResponse(400, { error });
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetReauthState } = await loadModule();
    resetReauthState();
  });
  afterEach(() => vi.restoreAllMocks());

  it("stops hitting the network after the first invalid_grant", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, isReauthRequired } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue(session("RT_dead"));
    const fetchSpy = rejectWith("invalid_grant");

    const first = await tryRefreshUpstreamTokens(SERVER);
    expect(first.status).toBe("reauth_required");
    expect(isReauthRequired(SERVER.uuid)).toBe(true);
    const callsAfterFirst = fetchSpy.mock.calls.length;

    // The storm: many more attempts, none of which should reach the upstream.
    for (let i = 0; i < 20; i++) {
      const again = await tryRefreshUpstreamTokens(SERVER);
      expect(again.status).toBe("reauth_required");
    }
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("flags the server so it shows red in the UI", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid } =
      await loadModule();
    const { serverErrorTracker } =
      await import("../metamcp/server-error-tracker");
    findByMcpServerUuid.mockResolvedValue(session("RT_dead"));
    rejectWith("invalid_grant");

    await tryRefreshUpstreamTokens(SERVER);
    expect(serverErrorTracker.markServerNeedsReauth).toHaveBeenCalledWith(
      SERVER.uuid,
    );
  });

  it("re-opens automatically once the stored refresh token changes (re-auth)", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, isReauthRequired } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue(session("RT_dead"));
    rejectWith("invalid_grant");

    await tryRefreshUpstreamTokens(SERVER);
    expect(isReauthRequired(SERVER.uuid)).toBe(true);

    // Ray re-authorizes: a different refresh_token is now stored.
    findByMcpServerUuid.mockResolvedValue(session("RT_fresh_after_reauth"));
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      return jsonResponse(200, {
        access_token: "NEW",
        token_type: "Bearer",
        refresh_token: "RT_rotated",
      });
    });

    const after = await tryRefreshUpstreamTokens(SERVER);
    expect(after.status).toBe("refreshed");
    expect(isReauthRequired(SERVER.uuid)).toBe(false);
  });

  it("keeps the breaker per-server — one dead credential does not gag others", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, isReauthRequired } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue(session("RT_dead"));
    rejectWith("invalid_grant");

    await tryRefreshUpstreamTokens(SERVER);
    expect(isReauthRequired(SERVER.uuid)).toBe(true);
    expect(isReauthRequired("00000000-0000-0000-0000-0000000000cc")).toBe(
      false,
    );
  });
});
