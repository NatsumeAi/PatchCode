# Subtask → AgentAttachment product decision (2026-08-07)

## Current behavior

Instance HTTP `toV2Prompt` (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`) maps:

- `text` parts → `prompt.text`
- `file` parts → `prompt.files`
- `agent` parts → `prompt.agents` (`AgentAttachment`)
- `subtask` parts → **dropped** with `Effect.logInfo("subtask parts dropped on v2 prompt")`

V2 `Prompt` schema (`packages/schema/src/prompt.ts`) has no SubtaskAttachment today.

## Decision (this pass)

**Stop-and-record — do not invent a silent mapping.**

| Option | Meaning | Chosen? |
|---|---|---|
| A. Extend Prompt with subtask spawn fields and teach runner to spawn | Full V2 parity | Deferred — needs product + schema/SDK |
| B. Map subtask → `agents: [{ name }]` only | Loses prompt/description/command | Rejected — too lossy |
| C. Keep drop + log; document unsupported on Instance V2 path | Honest contract | **Yes (interim)** |

## Exit criteria for a later PR

1. Spec `AgentAttachment` or new `SubtaskAttachment` fields needed for spawn.
2. Runner/admit path consumes them without silent drop.
3. Tests cover Instance payload with `type: "subtask"`.
4. Until then, clients must not rely on SubtaskPart on the V2 Instance prompt path.
