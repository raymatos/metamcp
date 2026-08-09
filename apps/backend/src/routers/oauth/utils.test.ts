import { afterEach, describe, expect, it, vi } from "vitest";

import { validateRedirectUri } from "./utils";

describe("validateRedirectUri", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts https URIs in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(validateRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(
      true,
    );
  });

  it("accepts http loopback redirects with ephemeral ports in production (RFC 8252 §7.3)", () => {
    vi.stubEnv("NODE_ENV", "production");
    // The exact shape Claude Code's /mcp OAuth flow registers.
    expect(validateRedirectUri("http://localhost:63348/callback")).toBe(true);
    expect(validateRedirectUri("http://127.0.0.1:8976/callback")).toBe(true);
    expect(validateRedirectUri("http://[::1]:5000/cb")).toBe(true);
  });

  it("rejects non-loopback http in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(validateRedirectUri("http://example.com/callback")).toBe(false);
  });

  it("rejects private-range IPs in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(validateRedirectUri("http://192.168.1.10/callback")).toBe(false);
    expect(validateRedirectUri("https://10.0.0.5/callback")).toBe(false);
  });

  it("rejects custom schemes everywhere", () => {
    expect(validateRedirectUri("myapp://callback")).toBe(false);
  });

  it("rejects malformed URIs", () => {
    expect(validateRedirectUri("not a url")).toBe(false);
  });
});
