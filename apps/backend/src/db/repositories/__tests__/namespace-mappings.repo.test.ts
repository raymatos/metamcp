import { describe, expect, it, vi } from "vitest";

vi.mock("../../index", () => ({ db: {} }));

import { resolveActiveExposureMode } from "../namespace-mappings.repo";

describe("resolveActiveExposureMode", () => {
  it("preserves FACADE when the legacy UI writes ACTIVE", () => {
    expect(resolveActiveExposureMode("FACADE", false)).toBe("FACADE");
    expect(resolveActiveExposureMode("FACADE", true)).toBe("FACADE");
  });

  it("restores the namespace default when un-hiding", () => {
    expect(resolveActiveExposureMode("HIDDEN", true)).toBe("FACADE");
    expect(resolveActiveExposureMode("HIDDEN", false)).toBe("DIRECT");
  });
});
