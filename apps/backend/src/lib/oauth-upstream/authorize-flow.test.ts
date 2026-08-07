import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  discoverAuthServerMetadata,
  discoverProtectedResourceMetadata,
  discoverUpstreamAuthMetadata,
  DynamicRegistrationError,
  generatePkcePair,
  generateState,
  registerDynamicClient,
} from "./authorize-flow";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// A fetch fake that maps exact URL strings to responses; anything else 404s.
const fetchByUrl = (routes: Record<string, () => Response>) =>
  vi.fn(async (input: string | URL | Request) => {
    const url =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url;
    const handler = routes[url];
    if (!handler) return new Response("not found", { status: 404 });
    return handler();
  }) as unknown as typeof fetch;

describe("generatePkcePair", () => {
  it("produces a base64url verifier whose S256 hash is the challenge", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("generates unique values per call", () => {
    expect(generatePkcePair().verifier).not.toBe(generatePkcePair().verifier);
    expect(generateState()).not.toBe(generateState());
  });
});

describe("discoverProtectedResourceMetadata", () => {
  it("prefers the path-aware form when the server URL has a path", async () => {
    const fetchImpl = fetchByUrl({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        jsonResponse({ resource: "path-aware" }),
      "https://mcp.example.com/.well-known/oauth-protected-resource": () =>
        jsonResponse({ resource: "root" }),
    });

    const result = await discoverProtectedResourceMetadata(
      "https://mcp.example.com/mcp",
      fetchImpl,
    );
    expect(result?.resource).toBe("path-aware");
  });

  it("falls back to the root form when the path-aware form 404s (Resend shape)", async () => {
    const fetchImpl = fetchByUrl({
      "https://mcp.example.com/.well-known/oauth-protected-resource": () =>
        jsonResponse({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        }),
    });

    const result = await discoverProtectedResourceMetadata(
      "https://mcp.example.com/mcp",
      fetchImpl,
    );
    expect(result?.authorization_servers).toEqual(["https://auth.example.com"]);
  });

  it("returns null when nothing is published", async () => {
    const result = await discoverProtectedResourceMetadata(
      "https://mcp.example.com/mcp",
      fetchByUrl({}),
    );
    expect(result).toBeNull();
  });
});

describe("discoverAuthServerMetadata", () => {
  it("falls through oauth-authorization-server to openid-configuration", async () => {
    const fetchImpl = fetchByUrl({
      "https://auth.example.com/.well-known/openid-configuration": () =>
        jsonResponse({
          authorization_endpoint: "https://auth.example.com/oidc/authorize",
          token_endpoint: "https://auth.example.com/oidc/token",
        }),
    });

    const result = await discoverAuthServerMetadata(
      "https://auth.example.com",
      fetchImpl,
    );
    expect(result?.authorization_endpoint).toBe(
      "https://auth.example.com/oidc/authorize",
    );
  });
});

describe("discoverUpstreamAuthMetadata", () => {
  it("follows the protected-resource indirection to the declared authorization server", async () => {
    // The Resend topology: PR metadata only at the origin root, AS metadata
    // only at the indirected auth host — nothing discoverable at the MCP
    // server's own well-known paths.
    const fetchImpl = fetchByUrl({
      "https://mcp.example.com/.well-known/oauth-protected-resource": () =>
        jsonResponse({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["mcp.read", "mcp.write"],
        }),
      "https://auth.example.com/.well-known/oauth-authorization-server": () =>
        jsonResponse({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        }),
    });

    const result = await discoverUpstreamAuthMetadata(
      "https://mcp.example.com/mcp",
      fetchImpl,
    );

    expect(result.authorizationServerBase).toBe("https://auth.example.com");
    expect(result.metadata?.token_endpoint).toBe(
      "https://auth.example.com/token",
    );
    expect(result.protectedResource?.scopes_supported).toEqual([
      "mcp.read",
      "mcp.write",
    ]);
  });

  it("uses the server URL itself when no protected-resource metadata exists", async () => {
    const fetchImpl = fetchByUrl({
      "https://mcp.example.com/.well-known/oauth-authorization-server": () =>
        jsonResponse({
          authorization_endpoint: "https://mcp.example.com/authorize",
        }),
    });

    const result = await discoverUpstreamAuthMetadata(
      "https://mcp.example.com/mcp",
      fetchImpl,
    );

    expect(result.protectedResource).toBeNull();
    expect(result.authorizationServerBase).toBe("https://mcp.example.com/mcp");
    expect(result.metadata?.authorization_endpoint).toBe(
      "https://mcp.example.com/authorize",
    );
  });

  it("returns null metadata (never throws) when discovery finds nothing", async () => {
    const result = await discoverUpstreamAuthMetadata(
      "https://mcp.example.com/mcp",
      fetchByUrl({}),
    );
    expect(result.metadata).toBeNull();
    expect(result.authorizationServerBase).toBe("https://mcp.example.com/mcp");
  });
});

describe("registerDynamicClient", () => {
  const clientMetadata = {
    redirect_uris: ["https://metamcp.example.com/fe-oauth/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "MetaMCP",
  };

  it("POSTs the metadata and returns the registration response", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_name: "MetaMCP",
        });
        return jsonResponse(
          { client_id: "client-123", client_secret: "s3cret" },
          201,
        );
      },
    ) as unknown as typeof fetch;

    const result = await registerDynamicClient({
      registrationEndpoint: "https://auth.example.com/register",
      clientMetadata,
      fetchImpl,
    });

    expect(result.client_id).toBe("client-123");
    expect(result.client_secret).toBe("s3cret");
  });

  it("throws a typed error carrying the upstream status and description", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: "invalid_client_metadata", error_description: "bad redirect" },
        400,
      ),
    ) as unknown as typeof fetch;

    await expect(
      registerDynamicClient({
        registrationEndpoint: "https://auth.example.com/register",
        clientMetadata,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "DynamicRegistrationError",
      status: 400,
      message: expect.stringContaining("bad redirect"),
    });
  });

  it("rejects a 2xx response without a client_id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ unexpected: true }),
    ) as unknown as typeof fetch;

    await expect(
      registerDynamicClient({
        registrationEndpoint: "https://auth.example.com/register",
        clientMetadata,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicRegistrationError);
  });
});
