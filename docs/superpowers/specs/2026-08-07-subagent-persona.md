# Subagent persona — design spec (2026-08-07)

> Status: **spec only**. Do not implement schema/SDK/runtime until this document is reviewed and accepted.
> Depends on: dual-path classification lock, V2 system-context injection point stability, Task discovery line format freeze.

## Principle

Persona is a **named, inheritable, resolvable, verifiable runtime identity layer**.

It is **not**:

- a bare `AgentV2.Info.persona: string`
- text pasted only into a normal user `admitPrompt` message

## Layer 1 — Config registry

Named persona registry (reuse agent config inheritance + `source` marking).

Minimum fields:

| Field | Purpose |
|---|---|
| `instructions` | Inline identity instructions |
| `instructions_file` | External file body |
| `description` | Parent-facing catalog blurb |
| `inputs` / `outputs` | Orchestration / discovery only — **not permissions** |

Suggested load paths: `.opencode/personas/*` and/or agent frontmatter reference.

## Layer 2 — Task spawn

`TaskTool.Input` gains optional `persona?: string` (spawn-time override).

Precedence (hard):

1. Explicit task override
2. Agent/role default persona
3. Parent inheritance

Agent default persona and spawn override must remain distinct.

## Layer 3 — Runtime: `EffectiveSubagentConfig`

Persist more than a string. At least:

- persona name
- resolved instructions
- source / path / fingerprint
- IO contract
- optional model / reasoning / isolation defaults (with explicit precedence; no silent override of child model inheritance)

Required for resume, error handling, and prompt rebuild.

## Layer 4 — Prompt injection boundary

Persona is trusted config identity → child **system/context assembly**.

Primary hook: [`packages/core/src/session/runner/llm.ts`](../../packages/core/src/session/runner/llm.ts) after `agent.info?.system` system parts — typed `SystemPart` (or equivalent context part).

Forbidden as sole implementation: concatenating persona body into user `admitPrompt` text.

First-spawn reminders must also use typed system/context parts, not XML-only string boundaries.

## Layer 5 — `instructions_file` safety

Source priority: workspace → user → bundled.

Path resolution: canonical path + symlink containment (not bare `path.resolve`).

Spawn: snapshot/fingerprint instructions. Resume: detect drift to prevent identity shift.

Phase-1 default: **soft-fail** missing/unreadable file (log + continue). Fail-closed is a later flag.

## Layer 6 — Permissions and overrides

- Persona capability/isolation may **only tighten**; cannot exceed parent permission ceiling.
- Model/reasoning overrides must follow explicit precedence tables; never silent.
- `inputs`/`outputs` affect task description and orchestration only.

## Layer 7 — Resume identity

- Validate persona name; prefer also storing instructions fingerprint.
- Sessions without persona remain resumable.
- Resume without explicit persona inherits the child session’s prior persona (no false mismatch).

## Relationship to Grok

Adopt: Agent vs Persona split; IO summary in task discovery; resume pin.

Defer: full TOML surface; pushing reasoning_effort / default_isolation onto persona in v1.

## Implementation order (after acceptance)

1. Loader/registry
2. `EffectiveSubagentConfig`
3. Runner SystemPart inject
4. Discovery line / IO summary
5. Spawn `persona` param
6. Resume checks
7. Soft file policy tests

## Out of scope for first coding PR

- Replacing AgentV2 with persona-only types
- Fail-closed file mode as default
- Encoding before this spec is approved
