# Spec: Hybrid Facade Tool Loading

Status: **Design decided** · Owner: Ray · Target: fork `ai-dev`

**Decisions locked (2026-09-01):**
- New tools in a facade-enabled namespace default to **`FACADE`** (manifest
  never grows on server add; promote the few you want to `DIRECT`).
- `search_tools` / `get_tool_schema` read from the **existing `toolsTable`
  sync** (no new sync path, always current via the hash-diff refresh).

**Amendments from review (2026-09-01, Fable):**
- In facade mode, the client-facing `tools/list` is served **entirely from
  `toolsTable`** — not by trimming the live backend fan-out (§4.1a). Live
  enumeration fluctuates (observed 671 → 789 → 642 tools across probes as
  slow/crashed servers dropped out of individual responses); a DB-served
  manifest is a pure function of DB state — deterministic across restarts,
  crashes, and slow spawns — which removes the very instability that poisons
  connector caches. It also means the client-facing list path no longer
  requires a full backend fan-out at all (enumeration becomes a background
  sync concern).
- Single **`exposure_mode`** column; `status` becomes derived/read-compat only
  (§5). Two writable columns permitting `FACADE`+`INACTIVE` contradictions is
  a foot-gun, and the inner filter middleware must not reject `execute_tool`
  dispatches for `FACADE` tools.
- Diagnosis evidence captured before the connector re-add: MetaMCP logs show
  **zero "Unknown tool" errors server-side** and the enumeration loop is
  closure-safe/name-keyed — confirming the mis-route and "Unknown tool" were
  manufactured at the client connector layer. Server-side routing exonerated.

## 1. Problem

A single MetaMCP namespace exposes **every tool of every server** as a flat
`tools/list`. RayLocal is at **642 tools**. Two consequences, both measured:

- **Oversized names.** The client prepends `mcp__<36-char-connector-UUID>__`
  (43 chars) to MetaMCP's own `<server>__<tool>`. **557 of 642** RayLocal tools
  exceed 64 chars once prefixed (up to 97). This crowds the client-side tool
  namespace against its limits.
- **Fragile manifest.** claude.ai / Desktop connectors cache the flat tool
  manifest. When the tool set changes — e.g. adding the 2nd n8n server
  (`i9labs-n8n`, ~40 tools) — the cached manifest desyncs, and a *soft*
  reconnect does not fully rebuild it. Reproduced: calling
  `i9labs-kanban__list_projects` through the connector returned a
  **contractor-tshirts** job (wrong backend); other tools return
  "Unknown tool". A direct `tools/call` against the endpoint with a fresh
  session routes correctly — so the fault is the client manifest, not MetaMCP
  routing (`toolToClient[name]` is exact-name keyed and deterministic,
  `metamcp-proxy.ts:452`).

The current workaround is splitting into more namespaces/connectors (i9-hub /
i9-infra split at ~1,655 tools). That is treating the symptom: each new
connector re-hits the same ceiling and adds reauth + management overhead.

## 2. Goals / Non-goals

**Goals**
- Cap the number of tools a connector advertises to a small, **stable** set,
  regardless of how many servers/tools are installed.
- Preserve **full capability**: every underlying tool remains callable.
- Keep the daily-driver tools **directly** callable (no indirection tax).
- Zero behavior change unless a namespace opts in (safe default).

**Non-goals**
- Changing backend server routing/pooling (reuse as-is).
- Solving the client's 64-char/manifest behavior itself (client-side; we make
  it irrelevant by shrinking the manifest).
- Replacing the existing per-tool ACTIVE/INACTIVE filter (we extend it).

## 3. Design overview

A **hybrid facade**: each tool in a namespace has one of three exposure modes.

| Mode | In `tools/list`? | How Claude calls it |
|---|---|---|
| `DIRECT` | yes, as a first-class tool | directly, exactly as today |
| `FACADE` | no | via the `execute_tool` meta-tool |
| `HIDDEN` | no | not callable (== today's INACTIVE) |

When a namespace has any `FACADE` tools, MetaMCP injects a handful of
**meta-tools** into `tools/list`:

- `search_tools` — find FACADE tools by keyword/server; returns name +
  one-line description (+ optional schema).
- `get_tool_schema` — full input schema for one or more FACADE tool names.
- `execute_tool` — invoke a FACADE tool by name with arguments.

Net manifest for a namespace = `DIRECT` tools + 3 meta-tools. A namespace with
30 direct hot tools advertises **33 tools**, never desyncs on install of new
servers (their tools default to `FACADE` and are searched, not listed).

This is the pattern `unifi-network` already uses per-server (`unifi_tool_index`
→ `unifi_execute`); here it is generalized at the namespace layer so it works
for **all** servers without each server implementing it.

## 4. Where it plugs in

MetaMCP already composes Express-style middleware around the list/call handlers
(`metamcp-proxy.ts:705-726`):

```
listToolsWithMiddleware = compose(
  createFacadeListToolsMiddleware(cfg),      // NEW — outermost
  createToolOverridesListToolsMiddleware(...),
  createFilterListToolsMiddleware(...),      // ACTIVE/INACTIVE
)(originalListToolsHandler)

callToolWithMiddleware = compose(
  createFacadeCallToolMiddleware(cfg),       // NEW — outermost
  createAuditCallToolMiddleware(...),
  createFilterCallToolMiddleware(...),
  createToolOverridesCallToolMiddleware(...),
)(originalCallToolHandler)
```

Both new middlewares are **outermost** so they see the fully-resolved tool list
(after overrides/filter) and can intercept meta-tool calls before routing.

### 4.1 `createFacadeListToolsMiddleware`
1. Call the inner handler → full `ListToolsResult` (already filtered to ACTIVE).
2. Look up each tool's exposure mode for this `namespaceUuid` (§5).
3. Keep `DIRECT` tools. Drop `FACADE`/`HIDDEN`.
4. If ≥1 `FACADE` tool exists, append the 3 meta-tool definitions.
5. Return the trimmed list.

### 4.1a Amendment: serve the facade list from the DB, not live enumeration

Steps 1–3 above describe the trim-the-live-list shape. **Do not ship that.**
In facade mode, build the `tools/list` response for `DIRECT` tools directly
from `toolsTable` (name, description, inputSchema — the same synced defs
search uses), skipping the inner handler's backend fan-out entirely:

- **Determinism.** Live enumeration is unstable: probes on RayLocal returned
  671, 789, and 642 tools depending on which backends were slow or mid-crash
  at that moment. A `DIRECT` tool on a flaky server blinks in and out of the
  manifest — the exact churn that desyncs connector caches. DB-served output
  is byte-stable for a given DB state.
- **Cost.** The client-facing list path stops fanning out to ~28 backends
  (and spawning stdio sessions) per cold `tools/list`. Enumeration/sync moves
  to a background refresh (existing sync triggered on non-facade paths, a
  timer, or server-config change), turning per-client cost into per-refresh
  cost.
- **Staleness window.** A renamed/removed backend tool can be advertised
  until the next sync; `execute_tool`/direct dispatch then fails with a clear
  error and the recovery path re-syncs. Acceptable — the flat design has the
  same window in the connector's own cache today, with worse failure modes.

### 4.2 `createFacadeCallToolMiddleware`
- If `request.params.name` is a meta-tool (`search_tools` / `get_tool_schema` /
  `execute_tool`): handle it here, do **not** call the inner handler for the
  meta-tool itself.
  - `execute_tool(name, arguments)` → rewrite the request to
    `{ name, arguments }` and call the **inner** handler. The existing
    `toolToClient` map + dynamic fallback (`metamcp-proxy.ts:455`) route it to
    the right backend. Enforce that `name` resolves to a `FACADE` **or**
    `DIRECT` tool in this namespace (never `HIDDEN`) before dispatch.
  - `search_tools` / `get_tool_schema` → served from the tool index (§6); never
    hit a backend.
- Otherwise (a `DIRECT` tool): pass through unchanged.

Because `execute_tool` re-enters the same inner handler, **all existing routing,
recovery (401 refresh, session-lost retry), header-forwarding, and audit logic
apply unchanged** to facade calls.

## 5. Data model

Extend the existing per-namespace tool mapping (the table behind ACTIVE/INACTIVE,
`namespaceToolMappingsTable`). Today it carries `status: ACTIVE | INACTIVE`.

Add exposure, keeping status for backward compat:

```
ALTER TYPE ... ADD exposure_mode ENUM('DIRECT','FACADE','HIDDEN')
namespace_tool_mappings.exposure_mode  default 'DIRECT'
```

Mapping from current state (migration): `status=INACTIVE → HIDDEN`,
`status=ACTIVE → DIRECT`. Result: **identical behavior to today** until a tool
is explicitly set to `FACADE`.

**Decided:** single writable `exposure_mode` column; `status` becomes a
derived read-compat view (`HIDDEN → INACTIVE`, else `ACTIVE`) for the existing
UI/API until they migrate. Two independently-writable columns would permit
contradictions (`FACADE` + `INACTIVE`), and the inner filter middleware must
treat `FACADE` as active or it would reject `execute_tool` dispatches.
Migration must preserve today's visible set exactly.

Namespace-level switch: `namespaces.facade_enabled boolean default false`. When
false, the facade middlewares are no-ops (fast path, zero risk). When true and
there are FACADE tools, meta-tools are injected.

## 6. Tool index (search/get_schema source)

MetaMCP already syncs each server's tool defs into `toolsTable` (name,
description, input schema) — see the tools-sync path in the list handler
(`metamcp-proxy.ts:372-404`). `search_tools`/`get_tool_schema` read from there,
scoped to the namespace's `FACADE` tools:

- **search**: case-insensitive substring/token match over `name` +
  `description`; optional `server` filter; rank exact-name > name-prefix >
  description; return `{name, description, server}` (schema omitted unless
  `include_schema`). Cap results (default 25) + report truncation.
- **get_tool_schema**: exact lookup of one or more names → full input schema.
- Index is refreshed by the existing tool-sync (hash-diff at
  `metamcp-proxy.ts:372`); no new sync path. Cache with the same TTL pattern as
  `filter-tools` (`ToolStatusCache`).

## 7. Meta-tool contracts

```jsonc
// search_tools
{ "query": "string",           // required; keywords
  "server": "string?",          // optional server-name filter
  "include_schema": "boolean?", // default false
  "limit": "number?" }          // default 25
// -> [{ name, description, server }] (+ inputSchema if include_schema)

// get_tool_schema
{ "names": "string[]" }         // 1..N fully-qualified <server>__<tool>
// -> [{ name, description, inputSchema }]

// execute_tool
{ "name": "string",             // fully-qualified <server>__<tool>
  "arguments": "object" }       // the tool's own args
// -> the tool's CallToolResult, verbatim
```

Naming: prefix meta-tools per-namespace-safe (e.g. `mcp_search_tools`) to avoid
colliding with any real tool named `search_tools`. Validate at startup that no
FACADE tool shares a meta-tool name; if so, auto-suffix.

## 8. Configuration & UX

- **Namespace settings** (existing namespace edit UI): a "Facade mode" toggle
  (`facade_enabled`) + a default for newly-discovered tools
  (`DIRECT` | `FACADE`; recommend `FACADE` so new servers never bloat the
  manifest).
- **Per-tool exposure**: extend the existing ACTIVE/INACTIVE tool table in the
  namespace view to a three-way `DIRECT / FACADE / HIDDEN` control.
- **Suggested RayLocal preset**: mark ~20–30 daily-driver tools `DIRECT`
  (kanban core, resend send/list, gsc core, i9labs-n8n core); everything else
  `FACADE`. Manifest drops 642 → ~33.

## 9. Backward compatibility & rollout

1. Ship with `facade_enabled=false` everywhere + all tools `DIRECT`
   → byte-identical `tools/list` to today. Middlewares early-return.
2. Enable on RayLocal only; set the hot set DIRECT, rest FACADE.
3. Reconnect the i9-hub connector once (hard re-add) to pick up the small
   manifest. Thereafter, adding servers = their tools land as FACADE = **no
   manifest change, no desync**.
4. i9-infra can adopt later or stay flat.

Feature is namespace-scoped, so blast radius is one namespace at a time.

**Honest trade-offs (from review):**
- The facade primarily benefits **claude.ai / Desktop connectors** (flat
  manifests, fragile caches). **Claude Code** already lazy-loads via deferred
  tools + ToolSearch; post-facade it loses exact-name `select:` for FACADE
  tools and goes through `search_tools`/`execute_tool` instead — one extra
  hop, and no client-side schema validation on `execute_tool` args. Pick the
  `DIRECT` hot set to include Claude Code's daily drivers to offset this.
- Without §4.1a, the facade would **not** reduce backend enumeration cost
  (the stdio-process story) — only bound the advertised list. With §4.1a the
  client-facing list path stops fanning out entirely; enumeration is a
  background sync concern.

## 10. Edge cases

- **execute_tool → HIDDEN/unknown**: reject with a clear error, never dispatch.
- **DIRECT tool also matched by search**: fine; search covers FACADE only (a
  DIRECT tool is already in the list). Optionally include DIRECT in search for
  discoverability, flagged.
- **forward_headers servers**: unchanged — `execute_tool` re-enters the inner
  handler which already applies header-forwarding per server.
- **tool-overrides**: facade list middleware runs outside overrides, so it sees
  final (possibly renamed) names; index + execute must use the same post-override
  names. Reuse `parseToolName` / `resolveToolIdentity`.
- **Admin tools context** (`getAdminToolsContext`, `metamcp-proxy.ts:731`):
  keep admin tools DIRECT (never facade them).
- **Tool sync churn**: index reads live `toolsTable`; on hash-diff refresh the
  cache TTL (≤1s) picks up changes, same as filter middleware.
- **Result size**: `search_tools` must bound output and state truncation so a
  broad query can't blow the context.

## 11. Testing

- **Unit** (mirror `filter-tools.functional.test.ts`): list middleware trims
  FACADE/HIDDEN + injects meta-tools iff FACADE present; call middleware routes
  `execute_tool` to inner handler, blocks HIDDEN, passes through DIRECT.
- **Search**: ranking, server filter, limit/truncation, include_schema.
- **Integration**: namespace with mixed modes → `tools/list` = DIRECT + 3;
  `execute_tool` returns same result as a direct call; parity test with
  `facade_enabled=false` == current output.
- **Regression**: default-DIRECT migration preserves today's visible set.

## 12. Effort & phasing

- **P1 — core (mid, ~1–1.5 days):** schema/migration + two middlewares +
  meta-tool handlers + index reads + unit/integration tests. Gets it working
  end-to-end behind the namespace flag.
- **P2 — UX (low–mid, ~0.5 day):** three-way exposure control + namespace
  toggle + "default new tools to FACADE".
- **P3 — polish (low):** search ranking tuning, result caps, docs, RayLocal
  preset. 

Total ~2–2.5 days. Delivers the "manifest never grows" property that ends
namespace sprawl.

## 13. Files to touch

- `packages/zod-types/src/namespaces.zod.ts` — exposure enum, namespace flag.
- `apps/backend/src/db/schema.ts` + a drizzle migration — `exposure_mode`,
  `facade_enabled`.
- `apps/backend/src/lib/metamcp/metamcp-middleware/facade.functional.ts` — NEW
  (both middlewares + meta-tool handlers + index queries).
- `apps/backend/src/lib/metamcp/metamcp-proxy.ts` — add the two middlewares to
  the `compose(...)` chains (`:705`, `:716`); guard on `facade_enabled`.
- `apps/frontend/...` namespace tool table — three-way control + toggle.
- Tests alongside the middleware.
```
