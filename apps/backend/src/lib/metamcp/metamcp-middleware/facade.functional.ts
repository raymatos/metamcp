import { CallToolRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";

import { db } from "../../../db/index";
import logger from "../../../utils/logger";
import {
  mcpServersTable,
  namespaceServerMappingsTable,
  namespaceToolMappingsTable,
  toolsTable,
} from "../../../db/schema";
import { sanitizeName } from "../utils";
import {
  CallToolMiddleware,
  ListToolsMiddleware,
} from "./functional-middleware";

export type ExposureMode = "DIRECT" | "FACADE" | "HIDDEN";

export interface FacadeToolRecord {
  name: string;
  originalName: string;
  server: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  exposureMode: ExposureMode;
  title?: string;
  annotations?: Tool["annotations"];
}

export interface FacadeConfig {
  enabled: boolean;
  loadTools?: (namespaceUuid: string) => Promise<FacadeToolRecord[]>;
}

const META_TOOL_BASE_NAMES = {
  search: "mcp_search_tools",
  schema: "mcp_get_tool_schema",
  execute: "mcp_execute_tool",
} as const;

const facadeToolCache = new Map<
  string,
  { expiresAt: number; tools: FacadeToolRecord[] }
>();
const facadeRefreshThrottle = new Map<string, number>();
const FACADE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function clearFacadeRefreshThrottle(): void {
  facadeRefreshThrottle.clear();
}

function triggerBackgroundRefresh(
  namespaceUuid: string,
  refresh: () => Promise<unknown>,
): void {
  const now = Date.now();
  const lastRefresh = facadeRefreshThrottle.get(namespaceUuid);
  if (
    lastRefresh !== undefined &&
    now - lastRefresh < FACADE_REFRESH_INTERVAL_MS
  ) {
    return;
  }

  facadeRefreshThrottle.set(namespaceUuid, now);
  void Promise.resolve()
    .then(refresh)
    .catch((error) => {
      logger.error(
        `Facade background tool refresh failed for namespace ${namespaceUuid}:`,
        error,
      );
    });
}

async function loadFacadeTools(
  namespaceUuid: string,
): Promise<FacadeToolRecord[]> {
  const cached = facadeToolCache.get(namespaceUuid);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;

  const rows = await db
    .select({
      name: toolsTable.name,
      description: toolsTable.description,
      inputSchema: toolsTable.toolSchema,
      server: mcpServersTable.name,
      exposureMode: namespaceToolMappingsTable.exposure_mode,
      overrideName: namespaceToolMappingsTable.override_name,
      overrideTitle: namespaceToolMappingsTable.override_title,
      overrideDescription: namespaceToolMappingsTable.override_description,
      overrideAnnotations: namespaceToolMappingsTable.override_annotations,
    })
    .from(namespaceToolMappingsTable)
    .innerJoin(
      toolsTable,
      eq(toolsTable.uuid, namespaceToolMappingsTable.tool_uuid),
    )
    .innerJoin(
      mcpServersTable,
      eq(mcpServersTable.uuid, namespaceToolMappingsTable.mcp_server_uuid),
    )
    .innerJoin(
      namespaceServerMappingsTable,
      and(
        eq(
          namespaceServerMappingsTable.namespace_uuid,
          namespaceToolMappingsTable.namespace_uuid,
        ),
        eq(
          namespaceServerMappingsTable.mcp_server_uuid,
          namespaceToolMappingsTable.mcp_server_uuid,
        ),
      ),
    )
    .where(
      and(
        eq(namespaceToolMappingsTable.namespace_uuid, namespaceUuid),
        eq(namespaceServerMappingsTable.status, "ACTIVE"),
      ),
    );

  const tools = rows.map((row) => {
    const server = sanitizeName(row.server);
    return {
      name: `${server}__${row.overrideName?.trim() || row.name}`,
      originalName: `${server}__${row.name}`,
      server,
      description: row.overrideDescription ?? row.description ?? undefined,
      inputSchema: row.inputSchema,
      exposureMode: row.exposureMode,
      title: row.overrideTitle ?? undefined,
      annotations: (row.overrideAnnotations ??
        undefined) as Tool["annotations"],
    };
  });
  facadeToolCache.set(namespaceUuid, {
    expiresAt: Date.now() + 1000,
    tools,
  });
  return tools;
}

function resolveMetaToolNames(tools: FacadeToolRecord[]) {
  const occupied = new Set(tools.map((tool) => tool.name));
  const unique = (base: string) => {
    let name = base;
    let suffix = 2;
    while (occupied.has(name)) name = `${base}_${suffix++}`;
    occupied.add(name);
    return name;
  };
  return {
    search: unique(META_TOOL_BASE_NAMES.search),
    schema: unique(META_TOOL_BASE_NAMES.schema),
    execute: unique(META_TOOL_BASE_NAMES.execute),
  };
}

function metaTools(names: ReturnType<typeof resolveMetaToolNames>): Tool[] {
  return [
    {
      name: names.search,
      description:
        "IMPORTANT: this connector lists only a curated subset of its tools directly — hundreds more across all connected servers exist but are unlisted. Before concluding a capability is unavailable, search here by keyword (matches tool names and descriptions; optional server filter), then invoke results via the execute meta-tool.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          server: { type: "string" },
          include_schema: { type: "boolean", default: false },
          limit: { type: "number", default: 25 },
        },
        required: ["query"],
      },
    },
    {
      name: names.schema,
      description:
        "Get the full input schema for unlisted tools found via the search meta-tool (exact fully-qualified <server>__<tool> names), before invoking them with the execute meta-tool.",
      inputSchema: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["names"],
      },
    },
    {
      name: names.execute,
      description:
        "Invoke any unlisted tool by the fully-qualified <server>__<tool> name returned by the search meta-tool. Pass the tool's own arguments as a JSON OBJECT in 'arguments' (get the schema from the schema meta-tool when unsure). A JSON-encoded string is tolerated and parsed; string-typed numbers/booleans are coerced to the tool's declared types.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object", additionalProperties: true },
        },
        required: ["name", "arguments"],
      },
    },
  ];
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The nested `arguments` of execute_tool is opaque to the CLIENT: unlike a
 * first-class tool call, no client-side schema validation or type coercion
 * happens before it reaches us. Models routinely (a) pass the whole object as
 * a JSON-encoded string and (b) pass numbers/booleans as strings. Both used
 * to land raw on the backend — (a) was silently forwarded as {} ("required
 * arg missing" on every facade tool), (b) failed strict backends with
 * "Expected number, received string". Be liberal here: parse stringified
 * objects and coerce string primitives against the target tool's own schema.
 */
function parseExecuteArguments(
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw === "string") {
    try {
      let parsed: unknown = JSON.parse(raw);
      // Tolerate one extra level of encoding: some clients double-stringify,
      // so the first parse yields the JSON text rather than the object.
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
      return {
        ok: false,
        error: `'arguments' must be a JSON object; the provided string parsed to ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
      };
    } catch {
      return {
        ok: false,
        error:
          "'arguments' must be a JSON object; got a string that is not valid JSON",
      };
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, value: raw as Record<string, unknown> };
  }
  return {
    ok: false,
    error: `'arguments' must be a JSON object; got ${Array.isArray(raw) ? "an array" : typeof raw}`,
  };
}

type JsonSchemaLike = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
};

function schemaType(schema: JsonSchemaLike | undefined): string | undefined {
  if (!schema?.type) return undefined;
  if (typeof schema.type === "string") return schema.type;
  // ["number","null"] and friends: coerce toward the first non-null type.
  return schema.type.find((t) => t !== "null");
}

function coerceBySchema(value: unknown, schema: JsonSchemaLike | undefined): unknown {
  if (!schema) return value;
  const type = schemaType(schema);

  if (typeof value === "string") {
    if (type === "integer" || type === "number") {
      const trimmed = value.trim();
      if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n) && (type !== "integer" || Number.isInteger(n))) {
          return n;
        }
      }
      return value;
    }
    if (type === "boolean") {
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    }
    if (type === "object" || type === "array") {
      try {
        const parsed = JSON.parse(value);
        if (
          (type === "object" &&
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)) ||
          (type === "array" && Array.isArray(parsed))
        ) {
          return coerceBySchema(parsed, schema);
        }
      } catch {
        /* leave as-is; backend reports the real error */
      }
      return value;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return schema.items
      ? value.map((item) => coerceBySchema(item, schema.items))
      : value;
  }

  if (value && typeof value === "object" && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = coerceBySchema(v, schema.properties[key]);
    }
    return out;
  }

  return value;
}

export function createFacadeListToolsMiddleware(
  config: FacadeConfig,
): ListToolsMiddleware {
  const loader = config.loadTools ?? loadFacadeTools;
  return (handler) => async (request, context) => {
    if (!config.enabled) return handler(request, context);

    const tools = await loader(context.namespaceUuid);
    const direct: Tool[] = tools
      .filter((tool) => tool.exposureMode === "DIRECT")
      .map(({ name, description, inputSchema, title, annotations }) => ({
        name,
        description,
        inputSchema,
        title,
        annotations,
      }));
    if (tools.some((tool) => tool.exposureMode === "FACADE")) {
      direct.push(...metaTools(resolveMetaToolNames(tools)));
    }
    triggerBackgroundRefresh(context.namespaceUuid, () =>
      handler(request, context),
    );
    return { tools: direct };
  };
}

export function createFacadeCallToolMiddleware(
  config: FacadeConfig,
): CallToolMiddleware {
  const loader = config.loadTools ?? loadFacadeTools;
  return (handler) => async (request, context) => {
    if (!config.enabled) return handler(request, context);

    const tools = await loader(context.namespaceUuid);
    const names = resolveMetaToolNames(tools);
    const requestedMetaTool = request.params.name;
    if (!Object.values(names).includes(requestedMetaTool)) {
      return handler(request, context);
    }
    const args = request.params.arguments ?? {};

    if (requestedMetaTool === names.execute) {
      const name = typeof args.name === "string" ? args.name : "";
      const target = tools.find((tool) => tool.name === name);
      if (!target || target.exposureMode === "HIDDEN") {
        return textResult(
          { error: `Tool is hidden or unknown in this namespace: ${name}` },
          true,
        );
      }
      const parsed = parseExecuteArguments(args.arguments);
      if (!parsed.ok) {
        return textResult({ error: parsed.error }, true);
      }
      const coerced = coerceBySchema(
        parsed.value,
        target.inputSchema as JsonSchemaLike,
      ) as Record<string, unknown>;
      const rewritten: CallToolRequest = {
        ...request,
        params: {
          ...request.params,
          name: target.name,
          arguments: coerced,
        },
      };
      return handler(rewritten, context);
    }

    const facadeTools = tools.filter((tool) => tool.exposureMode === "FACADE");
    if (requestedMetaTool === names.schema) {
      const requestedNames = Array.isArray(args.names)
        ? args.names.filter((name): name is string => typeof name === "string")
        : [];
      return textResult(
        requestedNames.flatMap((name) => {
          const tool = facadeTools.find((candidate) => candidate.name === name);
          return tool
            ? [
                {
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                },
              ]
            : [];
        }),
      );
    }

    const query =
      typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const queryTokens = query.split(/\s+/).filter(Boolean);
    const server =
      typeof args.server === "string" ? args.server.toLowerCase() : undefined;
    const requestedLimit =
      typeof args.limit === "number" ? Math.floor(args.limit) : 25;
    const limit = Math.max(1, Math.min(requestedLimit, 100));
    const includeSchema = args.include_schema === true;
    const matches = facadeTools
      .filter((tool) => !server || tool.server.toLowerCase() === server)
      .filter((tool) => {
        const searchable =
          `${tool.name} ${tool.description ?? ""}`.toLowerCase();
        return queryTokens.every((token) => searchable.includes(token));
      })
      .sort((a, b) => {
        const score = (tool: FacadeToolRecord) =>
          tool.name.toLowerCase() === query
            ? 0
            : tool.name.toLowerCase().startsWith(query)
              ? 1
              : 2;
        return score(a) - score(b) || a.name.localeCompare(b.name);
      });
    return textResult({
      results: matches.slice(0, limit).map((tool) => ({
        name: tool.name,
        description: tool.description,
        server: tool.server,
        ...(includeSchema ? { inputSchema: tool.inputSchema } : {}),
      })),
      truncated: matches.length > limit,
    });
  };
}
