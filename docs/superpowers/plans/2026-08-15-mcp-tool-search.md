# MCP tool_search Implementation Plan (W8c)

> REQUIRED: subagent-driven-development or executing-plans.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-mcp-tool-search-design.md`.

## Files

- `packages/core/src/tool/search-tool.ts`, `use-tool.ts`
- `packages/core/src/tool/registry.ts` materialize filter
- `packages/opencode/src/tool/dynamic-tools.ts` (count only; still **register** all for settle)
- `packages/core/test/mcp-defer/*.test.ts`

**Important:** Tools stay **registered** (settle by name). Only **definitions** advertised to the model are filtered.

### Task 1: search_tool

- [ ] Register N>8 fakes; materialize definitions names = builtins + search_tool + use_tool.
- [ ] search query matches description.

### Task 2: use_tool → settle

- [ ] use_tool execute calls `registry.settle` with inner name; hook spy sees inner name.
- [ ] Unknown name errors.

### Task 3: threshold

- [ ] N=2: both visible; search_tool absent (or present but unused — locked: **absent** when ≤8).
- [ ] Config `mcp.deferAfter`.

### Task 4

- [ ] `cd packages/core && bun test --timeout 60000 test/mcp-defer/`

## Done

Spec 1–5. Reviewer: 9 tools not in prompt definitions; use_tool hits settle.

## Out

- Rewriting MCP OAuth
- Per-turn schema injection cache
