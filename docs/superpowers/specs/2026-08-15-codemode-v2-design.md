# CodeMode on V2 Drain Design (W8d)

> Locked. Plan: `docs/superpowers/plans/2026-08-15-codemode-v2.md`.

**Goal:** Confined JS orchestration (`packages/codemode`) is a **core builtin** on SessionRunner settle, not an experimental V1 registry tool.

**Proven:**

| Fact | Where |
|---|---|
| Interpreter exists | `packages/codemode` |
| Tool `execute` in opencode V1 registry | `packages/opencode/src/tool/code-mode.ts` |
| Flag `OPENCODE_EXPERIMENTAL_CODE_MODE` | `runtime-flags.ts` |
| Nested MCP used to call `tool.execute.before` | code-mode.ts + tests |
| Not in `BuiltInTools` | `builtins.ts` TODO “Rune/code mode” |

## Rejected

- Leaving it V1-only.
- Giving the sandbox `fs`/`child_process` (codemode README forbids this).
- Nested tool calls that skip `ToolRegistry.settle` (would skip W5/W1/W2).

## Product

- Core tool name: `execute` (keep trained name) in `packages/core/src/tool/execute.ts`.
- `BuiltInTools` always registers it; if no MCP/tools tree, it still runs with empty `tools` and can only compute.
- Nested `tools.x.y()` implementations **must** `registry.settle({ name, input, sessionID, … })` so Hooks/Permission apply.
- Model output: final JSON + list of inner call names; intermediate values **not** appended to PromptTape (only the `execute` tool result).
- Remove experimental flag as the **only** gate. Optional config `tools.execute: false` to hide.
- Opencode V1 `code-mode.ts` is **deleted from the V1 registry** once core is live. No wrapper, no second advertiser.

Limits: same as current CodeMode (timeout, instruction size) — copy constants, don’t invent a second limiter.

## Anti-fake

1. `BuiltInTools` materialize includes `execute` without setting `OPENCODE_EXPERIMENTAL_CODE_MODE`.
2. Script calling an inner dummy tool increments that tool’s counter via **settle**.
3. Inner deny hook (W5) or permission deny aborts the script; outer result is error.
4. Tape/settle output is one `execute` result, not one message per inner call.
5. `rg "code-mode" packages/opencode/src/tool/registry.ts` has **no** execute registration. Core builtins is the only advertiser.
