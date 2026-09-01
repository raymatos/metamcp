import {
  CallToolRequest,
  ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../db/index", () => ({ db: {} }));

import {
  createFacadeCallToolMiddleware,
  createFacadeListToolsMiddleware,
  FacadeToolRecord,
} from "./facade.functional";
import { compose, MetaMCPHandlerContext } from "./functional-middleware";

const context: MetaMCPHandlerContext = {
  namespaceUuid: "namespace",
  sessionId: "session",
  endpointName: "endpoint",
};
const inputSchema = { type: "object" as const, properties: {} };
const indexedTools: FacadeToolRecord[] = [
  {
    name: "server__hot",
    originalName: "server__hot",
    server: "server",
    inputSchema,
    exposureMode: "DIRECT",
  },
  {
    name: "server__cold",
    originalName: "server__cold",
    server: "server",
    inputSchema,
    exposureMode: "FACADE",
  },
  {
    name: "server__off",
    originalName: "server__off",
    server: "server",
    inputSchema,
    exposureMode: "HIDDEN",
  },
];

describe("facade middleware integration", () => {
  it("keeps the disabled composed list path byte-identical", async () => {
    const liveResult = {
      tools: [{ name: "server__live", inputSchema }],
      nextCursor: "same",
    };
    const live = vi.fn().mockResolvedValue(liveResult);
    const handler = compose(
      createFacadeListToolsMiddleware({ enabled: false, loadTools: vi.fn() }),
    )(live);
    const result = await handler(
      { method: "tools/list", params: {} } as ListToolsRequest,
      context,
    );
    expect(JSON.stringify(result)).toBe(JSON.stringify(liveResult));
  });

  it("lists the stable DB manifest and executes a facade tool through the inner chain", async () => {
    const loadTools = vi.fn().mockResolvedValue(indexedTools);
    const listInner = vi.fn().mockResolvedValue({ tools: [] });
    const list = compose(
      createFacadeListToolsMiddleware({ enabled: true, loadTools }),
    )(listInner);
    const listed = await list(
      { method: "tools/list", params: {} } as ListToolsRequest,
      context,
    );
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "server__hot",
      "mcp_search_tools",
      "mcp_get_tool_schema",
      "mcp_execute_tool",
    ]);
    await Promise.resolve();
    expect(listInner).toHaveBeenCalledOnce();

    const backendResult = {
      content: [{ type: "text" as const, text: "backend result" }],
    };
    const routedBackend = vi.fn().mockResolvedValue(backendResult);
    const call = compose(
      createFacadeCallToolMiddleware({ enabled: true, loadTools }),
    )(routedBackend);
    const result = await call(
      {
        method: "tools/call",
        params: {
          name: "mcp_execute_tool",
          arguments: { name: "server__cold", arguments: { id: 7 } },
        },
      } as CallToolRequest,
      context,
    );
    expect(result).toBe(backendResult);
    expect(routedBackend.mock.calls[0]?.[0].params).toEqual({
      name: "server__cold",
      arguments: { id: 7 },
    });
  });
});
