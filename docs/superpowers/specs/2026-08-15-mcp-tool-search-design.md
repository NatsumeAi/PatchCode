# MCP tool_search Design (W8c)

> Locked. Plan: `docs/superpowers/plans/2026-08-15-mcp-tool-search.md`.

**Goal:** When MCP dumps dozens of tools into the prompt, advertise **search + use** instead of every schema. Codex `tool_search` / Grok `search_tool`+`use_tool`.

**Proven:** `DynamicTools.Host` re-registers every MCP tool into V2 `ToolRegistry` (`dynamic-tools.ts`). `materialize()` advertises all. No search entry.

## Rejected

- Hiding MCP completely.
- A second settle path that skips Hooks/Permission/W1.
- Threshold 0 always-search (hurts 1–2 tool servers). Default threshold **8** advertised MCP tools.

## Product

If `mcpToolCount > 8` (config `mcp.deferAfter`, default 8):

- Do **not** put individual MCP tools in `materialize().definitions`.
- Advertise:
  - `search_tool({ query })` → `{ name, description, server }[]` (BM25/FTS or substring on name+description, cap 10)
  - `use_tool({ name, input })` → `ToolRegistry.settle` of that tool (must be a registered MCP/dynamic identity)

If count ≤ 8: current behavior (all definitions).

`use_tool` of an unknown name → error listing search_tool. `use_tool` still runs PreToolUse with **the real tool name** (not `use_tool`) so W5 matchers work.

Optional: after successful search in a session, those names may be advertised next turn (session cache). Not required for v1 of this spec — search every time is honest.

## Anti-fake

1. 9 dummy MCP tools → definitions include `search_tool`/`use_tool`, not `dummy_8`.
2. 2 dummy tools → both advertised, no search_tool required.
3. `use_tool` name=`mcp_ping` increments that tool’s execute counter; Hooks see `toolName=mcp_ping`.
4. `use_tool` does not call MCP SDK bypassing `settle`.
5. `rg "use_tool" packages/core/src/tool/registry.ts` or a dedicated `use-tool.ts` that calls `settle`.
