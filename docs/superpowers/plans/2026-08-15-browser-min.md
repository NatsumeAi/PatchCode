# Minimal Browser Implementation Plan (W8g)

> REQUIRED: subagent-driven-development or executing-plans.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-browser-min-design.md`.

## Files

- `packages/core/src/tool/browser.ts` + `Browser.Host` context
- `packages/opencode/src/tool/browser-host.ts` (optional playwright/MCP adapter)
- `packages/core/test/tool-browser.test.ts`
- config: `browser.enabled`

### Task 1: core + fake host

- [ ] Disabled → not in definitions.
- [ ] Fake host provided + enabled → navigate/snapshot/click.
- [ ] Metadata URL denied via `Net.denyHost` before Host.

### Task 2: opencode host

- [ ] If playwright import fails, do not provide Host (definitions stay off).
- [ ] No live Chromium test in default CI.

### Task 3

- [ ] `cd packages/core && bun test --timeout 60000 test/tool-browser.test.ts`

## Done

Spec 1–5. Reviewer: no Chromium required for green; metadata URL never hits Host.

## Out

- Hermes Camofox/CDP suite
- OpenClaw desktop node
- Advertising tools when host missing
