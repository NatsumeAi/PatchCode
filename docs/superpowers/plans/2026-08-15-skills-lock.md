# Skills Lockfile Implementation Plan (W8h)

> REQUIRED: subagent-driven-development or executing-plans.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-skills-lock-design.md`.

## Files

- `packages/core/src/skill/lock.ts`
- `packages/core/src/tool/skill-install.ts`, `skill-trust.ts`
- `packages/core/src/skill.ts` filter quarantine
- `packages/core/test/skill-lock/*.test.ts`

### Task 1: lock IO

- [ ] read/write `skills-lock.json`; add/update rows.

### Task 2: install + quarantine

- [ ] Fixture directory as uri `file:` **rejected** (https only) — use mock HttpClient for https fixture. `Net.denyHost` on loopback.
- [ ] After install, list omits; tool load fails.

### Task 3: trust + scan

- [ ] Clean fixture → active + listed.
- [ ] Threat fixture → trust fails, stays quarantine.

### Task 4

- [ ] `cd packages/core && bun test --timeout 60000 test/skill-lock/ test/skill.test.ts test/skill-discovery.test.ts`

## Done

Spec 1–6. Reviewer: quarantined skill not in guidance; threat cannot activate.

## Out

- Skills Hub / ClawHub
- `/learn` authoring
- Running skill scripts at install
