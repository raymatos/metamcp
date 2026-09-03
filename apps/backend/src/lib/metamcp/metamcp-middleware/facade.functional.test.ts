import {
  CallToolRequest,
  ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../db/index", () => ({ db: {} }));

import {
  clearFacadeRefreshThrottle,
  createFacadeCallToolMiddleware,
  createFacadeListToolsMiddleware,
  FacadeToolRecord,
} from "./facade.functional";
import { MetaMCPHandlerContext } from "./functional-middleware";

const context: MetaMCPHandlerContext = {
  namespaceUuid: "namespace",
  sessionId: "session",
  endpointName: "endpoint",
};
const listRequest: ListToolsRequest = { method: "tools/list", params: {} };
const schema = {
  type: "object" as const,
  properties: { value: { type: "string" } },
};
const records: FacadeToolRecord[] = [
  {
    name: "alpha__direct",
    originalName: "alpha__direct",
    server: "alpha",
    inputSchema: schema,
    exposureMode: "DIRECT",
    description: "direct tool",
  },
  {
    name: "alpha__find",
    originalName: "alpha__find",
    server: "alpha",
    inputSchema: schema,
    exposureMode: "FACADE",
    description: "find records",
  },
  {
    name: "beta__find",
    originalName: "beta__find",
    server: "beta",
    inputSchema: schema,
    exposureMode: "FACADE",
    description: "find other records",
  },
  {
    name: "alpha__hidden",
    originalName: "alpha__hidden",
    server: "alpha",
    inputSchema: schema,
    exposureMode: "HIDDEN",
  },
];

describe("facade middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFacadeRefreshThrottle();
  });

  it("is a byte-for-byte no-op when disabled", async () => {
    const response = {
      tools: [{ name: "live__tool", inputSchema: schema }],
      nextCursor: "cursor",
    };
    const inner = vi.fn().mockResolvedValue(response);
    const result = await createFacadeListToolsMiddleware({
      enabled: false,
      loadTools: vi.fn(),
    })(inner)(listRequest, context);
    expect(result).toBe(response);
    expect(JSON.stringify(result)).toBe(JSON.stringify(response));
    expect(inner).toHaveBeenCalledOnce();
  });

  it("serves DIRECT tools and meta-tools from the DB loader", async () => {
    const inner = vi.fn();
    const result = await createFacadeListToolsMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(records),
    })(inner)(listRequest, context);
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "alpha__direct",
      "mcp_search_tools",
      "mcp_get_tool_schema",
      "mcp_execute_tool",
    ]);
    await Promise.resolve();
    expect(inner).toHaveBeenCalledOnce();
  });

  it("fires one non-blocking background refresh and throttles subsequent lists", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const neverResolves = new Promise(() => undefined);
    const inner = vi.fn().mockReturnValue(neverResolves);
    const middleware = createFacadeListToolsMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(records),
    })(inner);

    const first = await middleware(listRequest, context);
    const second = await middleware(listRequest, context);
    const expectedNames = [
      "alpha__direct",
      "mcp_search_tools",
      "mcp_get_tool_schema",
      "mcp_execute_tool",
    ];
    expect(first.tools.map((tool) => tool.name)).toEqual(expectedNames);
    expect(second).toEqual(first);
    await Promise.resolve();
    expect(inner).toHaveBeenCalledOnce();
    now.mockRestore();
  });

  it("does not inject meta-tools when no FACADE tool exists", async () => {
    const result = await createFacadeListToolsMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue([records[0]]),
    })(vi.fn())(listRequest, context);
    expect(result.tools.map((tool) => tool.name)).toEqual(["alpha__direct"]);
  });

  it("rewrites execute_tool and returns the inner result verbatim", async () => {
    const expected = { content: [{ type: "text" as const, text: "ok" }] };
    const inner = vi.fn().mockResolvedValue(expected);
    const request: CallToolRequest = {
      method: "tools/call",
      params: {
        name: "mcp_execute_tool",
        arguments: { name: "alpha__find", arguments: { value: "x" } },
      },
    };
    const result = await createFacadeCallToolMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(records),
    })(inner)(request, context);
    expect(result).toBe(expected);
    expect(inner.mock.calls[0]?.[0].params).toMatchObject({
      name: "alpha__find",
      arguments: { value: "x" },
    });
  });

  it("parses a JSON-string 'arguments' payload instead of forwarding {}", async () => {
    const inner = vi.fn().mockResolvedValue({ content: [] });
    const request: CallToolRequest = {
      method: "tools/call",
      params: {
        name: "mcp_execute_tool",
        arguments: {
          name: "alpha__find",
          arguments: JSON.stringify({ value: "x" }),
        },
      },
    };
    await createFacadeCallToolMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(records),
    })(inner)(request, context);
    expect(inner.mock.calls[0]?.[0].params.arguments).toEqual({ value: "x" });
  });

  it("rejects an unparseable string 'arguments' loudly without calling the backend", async () => {
    const inner = vi.fn();
    const request: CallToolRequest = {
      method: "tools/call",
      params: {
        name: "mcp_execute_tool",
        arguments: { name: "alpha__find", arguments: "not json {" },
      },
    };
    const result = await createFacadeCallToolMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(records),
    })(inner)(request, context);
    expect(result.isError).toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });

  it("coerces string-typed primitives to the target tool's declared types", async () => {
    const typedRecords: FacadeToolRecord[] = [
      {
        name: "alpha__typed",
        originalName: "alpha__typed",
        server: "alpha",
        exposureMode: "FACADE",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: { type: "integer" },
            ratio: { type: "number" },
            active: { type: "boolean" },
            label: { type: "string" },
            nested: {
              type: "object",
              properties: { count: { type: "integer" } },
            },
            ids: { type: "array", items: { type: "integer" } },
          },
        },
      },
    ];
    const inner = vi.fn().mockResolvedValue({ content: [] });
    const request: CallToolRequest = {
      method: "tools/call",
      params: {
        name: "mcp_execute_tool",
        arguments: {
          name: "alpha__typed",
          arguments: {
            limit: "5",
            ratio: "0.5",
            active: "true",
            label: "7", // string-typed prop must NOT be coerced
            nested: JSON.stringify({ count: "3" }), // stringified object + inner coercion
            ids: ["1", "2"],
          },
        },
      },
    };
    await createFacadeCallToolMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(typedRecords),
    })(inner)(request, context);
    expect(inner.mock.calls[0]?.[0].params.arguments).toEqual({
      limit: 5,
      ratio: 0.5,
      active: true,
      label: "7",
      nested: { count: 3 },
      ids: [1, 2],
    });
  });

  it("blocks HIDDEN and unknown execute targets", async () => {
    const inner = vi.fn();
    const request: CallToolRequest = {
      method: "tools/call",
      params: {
        name: "mcp_execute_tool",
        arguments: { name: "alpha__hidden", arguments: {} },
      },
    };
    const result = await createFacadeCallToolMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(records),
    })(inner)(request, context);
    expect(result.isError).toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });

  it("searches only FACADE tools with server, schema, rank, and truncation controls", async () => {
    const request: CallToolRequest = {
      method: "tools/call",
      params: {
        name: "mcp_search_tools",
        arguments: {
          query: "find",
          server: "alpha",
          include_schema: true,
          limit: 1,
        },
      },
    };
    const result = await createFacadeCallToolMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(records),
    })(vi.fn())(request, context);
    const payload = JSON.parse(
      result.content[0]?.type === "text" ? result.content[0].text : "",
    );
    expect(payload).toMatchObject({
      truncated: false,
      results: [{ name: "alpha__find", server: "alpha", inputSchema: schema }],
    });
  });

  it("gets exact schemas for FACADE tools only", async () => {
    const request: CallToolRequest = {
      method: "tools/call",
      params: {
        name: "mcp_get_tool_schema",
        arguments: { names: ["alpha__find", "alpha__direct"] },
      },
    };
    const result = await createFacadeCallToolMiddleware({
      enabled: true,
      loadTools: vi.fn().mockResolvedValue(records),
    })(vi.fn())(request, context);
    const payload = JSON.parse(
      result.content[0]?.type === "text" ? result.content[0].text : "",
    );
    expect(payload).toEqual([
      { name: "alpha__find", description: "find records", inputSchema: schema },
    ]);
  });
});
