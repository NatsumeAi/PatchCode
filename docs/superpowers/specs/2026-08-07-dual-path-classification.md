# Dual-path classification lock (2026-08-07)

> **2026-08-14 audit:** several rows below are stale. Authority for current live/parallel/keep-list is `docs/superpowers/specs/2026-08-07-v1-runtime-inventory.md` (rewritten as dual-path + feature keep-list). Do not execute Wave D from this 08-07 table.

| 08-07 row | 2026-08-14 status |
|---|---|
| revert/unrevert HTTP still SessionRevert V1 | **Done.** HTTP uses `SessionV2.revert.stage/clear/commit`. `SessionRevert.node` is dead-reg. Semantics below still apply. |
| SessionPrompt still registered | Drain **dead for HTTP**. **Node unregistered** from `httpapi/server.ts` and never on app-runtime (2026-08-14). `runLoop` still exists for `prompt.test.ts`. Task shim already collapsed. |
| Persona deferred | **Stale.** Persona inject is on SessionRunner origin + Task Host. Keep-list item. |
| Compaction v3 | Still true that v3 is implemented; **two modules** remain (core live, opencode file for old tests). Opencode compaction **node unregistered** from production graphs. |
| subtask parts dropped | Unchanged product lock: do not invent V2 mapping in a delete PR. |

Wave D / parallel-path cleanup **must not** run until the keep-list in the inventory doc is proven on the live path. Features we added (PromptTape, loop/subagent, memory, revert tape, hardening) are not optional.

---

> Locked after re-review (08-07): facts were largely correct; severity/labels were not.
> Rule: one live path per capability. V1-only OK. V2-only OK. Dual live = converge. Dead registration ≠ dual. Compat retention ≠ plan failure. **Shim (`Host ? V2 : runLoop`) = dual live.**

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
| `lastHeartbeatAt` (progress-only) | Last time child **progress** counters grew (turns / tools / tokens) |
| Observer poll loop | Reads child messages and calls `touchHeartbeat` — **does not** refresh progress unless counters grow |
| `SessionV2.active` / `execution.active` | Session **drain busy** membership only (UI / busy checks) |

Watcher rule: mark `lost` when status is `active` AND `now - lastProgressAt > 180s`. Drain membership does **not** exempt stall — a hung drain with frozen progress must interrupt and notify the parent (same pipeline as cancel / HeartbeatLost).
