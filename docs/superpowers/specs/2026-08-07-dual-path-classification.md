# Dual-path classification lock (2026-08-07)

> Locked after re-review: facts were largely correct; severity/labels were not.
> Test baseline at lock: ~682 pass / 1 skip / 0 fail on related packages.
> Rule: one live path per capability. V1-only OK. V2-only OK. Dual live = converge. Dead registration ≠ dual. Compat retention ≠ plan failure.

## Classification table

| Item | Classification | Treatment |
|---|---|---|
| Compaction v3 | Implemented | Not a gap; compaction fold is a separate track |
| `permission.respond` still V1 / deprecated | Compat path | Inventory consumers; keep deprecated Instance surface unless decision says forward to V2 |
| revert/unrevert HTTP still `SessionRevert` V1 | V2 graduation gap | Prefer: Instance HTTP → `SessionV2.revert.stage/clear/commit` |
| SessionPrompt etc. still registered | Architecture retire unfinished | Inventory consumers before delete; main prompt path is already V2 |
| subtask parts dropped | Stop-and-decide | Product decision required; not silent omission |
| Heartbeat vs `execution.active` | Plan deviation | Document authority; tighten watcher with tests |
| Task structured `turns`/`usage` | Partial gap | Host must fill; separate from SessionTable usage |
| SessionIdle | Low-priority real gap | Hook type exists; no producer yet |
| Persona | Deferred capability | Independent spec first; do not treat as plan failure |
| list/execute descriptors | Plan hygiene | No runtime tools; generic fallback OK — drop from DoD or add descriptors |
| groupToolVerbs / reasoning streaming | Intentional product | Revision log only |
| fold h/l/e default `none` | Intentional | Separate from j/k |
| j/k navigation | Interaction gap | Selection API exists; default keybind wiring incomplete |
| Sidebar 34/20/2 vs 42/28/1 | Spec drift | Design note; handle=2 is intentional hit target |

## Revert semantic map (locked)

| User action | V1 | V2 |
|---|---|---|
| Undo | `SessionRevert.revert({ messageID })` | `SessionV2.revert.stage` → `RevertEvent.Staged` |
| Redo (no later user) | `unrevert` | `clear` |
| Redo (jump to later user) | `revert` again | `stage` again |
| Next prompt / summarize / shell | `cleanup` (hard-delete tail) | `commit` → `RevertEvent.Committed` |

- **Unknown `messageID`:** V1 returned the session unchanged (200 no-op). Instance adapter preserves that; do not map to 400.
- **`partID`:** V1 mid-message trim is not in V2 stage. Instance adapter **rejects** `partID` with 400 (no silent widen to full-message revert). TUI undo only sends `messageID`.
- **Commit boundary:** V2 deletes messages with `seq > boundary.seq` (**exclusive** boundary — boundary message kept). This differs from V1 cleanup which removed the boundary message itself; intentional V2 design, document in UI as possible dangling user turn after undo+commit.
- **Missing boundary on commit:** projector clears `SessionTable.revert` (recoverable) instead of dying. Deleting the staged boundary message also clears staging first.
- Adapter keeps Instance HTTP paths and `Session.Info` response shape; implementation calls V2.
- Busy check: `SessionV2.active`, not `SessionRunState`.
- Snapshot failures on stage/clear map to declared `BadRequest` (endpoint has no `InternalServerError` channel).

## Permission decision (locked for this pass)

- **Sole live ask/reply for TUI/tools:** PermissionV2 / QuestionV2.
- **Instance `permissionRespond` / legacy permission reply:** retain as **deprecated compat** calling shared V1 `Permission.Service` (matches original deprecate-plan “verify shared HTTP/V1 Permission.Service”).
- No silent dual-write. No merge of permission + question endpoints. Full V1 permission stack removal only after consumer inventory proves zero readers.

## Subtask decision (locked for this pass)

- Continue logging drops on V2 prompt path.
- **Do not** silently invent AgentAttachment mapping in this pass.
- Product follow-up: either extend Prompt attachments for subtask spawn fields, or formally drop SubtaskPart from the supported Instance contract.

## Heartbeat authority (locked)

| Signal | Role |
|---|---|
| `lastHeartbeatAt` / registry watcher | Subagent **liveness** signal |
| `SessionV2.active` / `execution.active` | Session **drain busy** membership |

Watcher rule after this pass: mark `lost` when status is `active` AND heartbeat is stale AND child is **not** in `execution.active` (orphan: drain no longer owns the child). If `SessionExecution` is unavailable in the watcher scope, fall back to heartbeat-only (legacy). While the child remains in an active drain, stale heartbeat alone does not mark lost (avoids false orphans during brief beat gaps).
