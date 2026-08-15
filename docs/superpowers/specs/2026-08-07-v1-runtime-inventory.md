# Dual-path inventory + feature keep-list (updated 2026-08-14)

> Replaces the 2026-08-07 consumer-only table. **This is an audit, not a delete list.**
> Rule: one live path per capability. Do not delete by the name V1/V2.
> Our added features must survive. Parallel shells may be retired only after every keep-list item is proven on the live path (symbol + test). Wave D must not run from an empty `rg` alone.

Main HTTP `prompt` / `prompt_async` / `command` / `shell` / `compact` / `revert` already use `SessionV2` → `SessionRunner`. Do not claim “the main path is still V1.”

## Labels

| Tag | Meaning |
|---|---|
| **live** | Production `src/` callers (HTTP / TUI / CLI / Task host) |
| **dead-reg** | Still in the runtime graph, **no** `src/` caller of the drain/API. Tests may still construct it. Not dual-live. Unregister only after keep-list + test migration. |
| **shim** | `serviceOption(V2) ? V2 : V1`. This **is** dual-live. Forbidden as an end state. |
| **compat** | Deprecated Instance surface; keep until consumer inventory is empty |
| **migrate-then-delete** | Unique behavior still on the old object. Move it to the live path first. |
| **keep** | Do not touch this wave |

`rg` scope for “production caller”: `packages/opencode/src`, `packages/core/src`, `packages/tui/src`, `packages/app/src`. Tests prove features; they do not keep a second drain alive.

---

## Keep-list (must remain reachable from the live path)

Each row: feature → live symbol → proof test. Missing test = gap, not permission to delete.

| Feature | Live path | Proof |
|---|---|---|
| PromptTape origin once; append-only; `compiled` on the wire | `session/runner/llm.ts` | `session-runner.test.ts` prefix / compiled tests; `prompt-tape*.ts` |
| No per-step `toLLMMessages`; no rematerialize after origin | `runner/llm.ts` | runner suite (request `messages: []`, compiled tools frozen) |
| Last-step keeps tools; MAX_STEPS ephemeral | `runner/llm.ts` | `forces a text response on an agent's configured final step` |
| Verifier / timer / recall as user tail, not `messages[0]` | `runner/llm.ts` | verifier-reject test; recall test; `compiled.messages[0]` has no Goal/timer dump |
| Persona frozen at origin | `runner/llm.ts` + `persona/inject.ts` | sampled-agent freeze tests; tape `messages[0]` |
| Prewarm system-only | `runner/prewarm.ts` | `prewarm.test.ts` |
| `tape_json` persist / restore | `context-epoch.ts` + store | `clearAll then loadTape restores…` |
| Revert truncate + unrevert restore tape | `session.ts` revert + `PromptTapeStore` | revert commit / unrevert tests |
| Idle model/agent switch → new tape | `session.ts` switch* | `switchModel drops the tape…` |
| Compact → drop tape (new epoch) | runner compact + `session.ts` compact | `manual compact clears the session tape` |
| 429 retry identical `compiled` | `runner/llm.ts` | `429 RateLimit retries once…` |
| Iteration budget / grace / breaker HalfOpen / doom-loop | `loop-control-host.ts` | `loop-control-host-layerreal.test.ts` |
| ForkMode parent trace = **child** first user | `tool-host-bridges.ts` + `fork-mode.ts` | task host tests (not V1 `runTask`) |
| `task_id` resumes **child** session/tape | `tool-host-bridges.ts` + `subagent-identity.ts` | task host resume tests |
| SubagentFailed stops parent | loop-control-host | host-layerreal SubagentFailed test |
| Memory recall user-append; flush on compact | `runner/llm.ts` + `MemoryFlush` | recall test; `flushes memory when automatic compaction triggers` |
| Revert HTTP: stage/clear/commit; busy=`active`; unknown messageID no-op; `partID` 400; commit keeps boundary | HTTP handler + `SessionV2.revert` | `2026-08-07-revert-adapter-smoke.md` + runner tape revert tests |
| Bounded stream retry; untrusted tool framing | `runner/llm.ts` | transient failure / tool-result tests |

If a later delete would make any row unprovable on the live path, **stop**.

---

## Capability pairs (2026-08-14 `rg`)

### 1. Session drain

| | |
|---|---|
| **Live** | `SessionV2.prompt` → `SessionExecution` → `SessionRunner` / `runner/llm.ts` + PromptTape. HTTP prompt/command/init/shell/summarize use `v2Svc.*`. `SessionPrompt` is a thin adapter: admit/stamp/subtask/shell occupancy (`SessionRunState`) then `v2.resume`. **`runLoop` is deleted** in the working tree. |
| **Parallel** | **Gone.** No second drain. Adapter does not call `SessionProcessor` / `MessageV2.toModelMessages` / `applyCaching`. |
| **src callers of `SessionPrompt.prompt(` / `runLoop(`** | `runLoop` has no callers (deleted). `SessionPrompt.Service` is still constructed by `prompt.test.ts` as the V1-shaped façade over the live drain. |
| **Still registered** | **No.** `SessionPrompt.node` / Processor / Compaction / Revert unregistered from `httpapi/server.ts` and `app-runtime.ts` (2026-08-14). Tests still construct `SessionPrompt`. |
| **Keep-list** | All tape + loop-control features live **only** on SessionRunner. Adapter join/cancel uses `SessionRunState` (same occupancy as V1 `ensureRunning` / `startShell`), work is `v2.resume` not `runLoop`. |
| **Behavior only on adapter** | `handlePendingSubtasks`, file-part resolution, agent variant, slash-command expand — V1 façade over live drain. Proof: `cd packages/opencode && bun test test/session/prompt.test.ts` (2026-08-15: 59 pass / 1 skip / 0 fail). |
| **Conclusion** | Duplicate compile (`runLoop`) is **already-safe-to-unreg / deleted**. Live drain covers loop occupancy, shell follow-up, subtask/task metadata, prompt-during-run, and interrupt-bash truncation via `ToolOutputStore.bound`. Do **not** port PromptTape onto a leftover V1 loop. |

### 2. Task spawn — Host only (shim collapsed 2026-08-14)

| | |
|---|---|
| **Live** | `packages/core/src/tool/task.ts` + `ToolHostBridges` (`admit` + `wake`). HTTP/app graph provides Host. Parent abort interrupts Host; Host `onInterrupt` cancels child drain + background job. |
| **Adapter** | `packages/opencode/src/tool/task.ts` still in opencode `ToolRegistry`. Gates (depth, experiment flag, `ctx.ask`) then **requires** `HostService`. Maps Host result to V1 `<task>` XML + `metadata.sessionId` / `background`. No `ops.prompt` / `runLoop`. |
| **Shim** | **Removed.** No Host → error (`Task host is not available`). Proof: `task-v2-host-prefer.test.ts`, `task.test.ts`. |
| **Keep-list** | ForkMode, `task_id`, persona, budget/concurrency, parent notify on **Host**. Child permissions: `deriveSubagentPermission` (core) + Host. |
| **Conclusion** | Adapter stays until opencode `ToolRegistry` is unused. |

### 3. Session writes that change model context

| | |
|---|---|
| **Live** | prompt / revert / compact / switchModel / switchAgent / shell / **fork / removeMessage / removePart / updatePart** on `packages/core/src/session.ts` + tape rules. HTTP handlers call `v2Svc.*`. Copier: `session/clone-prefix.ts` (V1 `Session.fork` tests use the same helper). |
| **Test-only parallel** | V1 `removeMessage` / `removePart` / `updatePart` still exist for `SessionPrompt` / processor / compaction tests. HTTP does **not** call them. |
| **Keep-list** | Fork = new session, new tape, exclusive `messageID` prefix, metadata/agent/model copied. Middle-delete / deletePart / updatePart → `dropTape`. Tail-delete → `truncateToSeq`. Busy → `SessionBusyError`, tape unchanged. Proof: `session-runner.test.ts` fork/delete rows; HTTP `serves lifecycle mutation routes` / `serves message mutation routes`. |
| **Conclusion** | **done** (2026-08-14). CLI/ACP `sdk.session.fork` still hits HTTP (same drain). |

### 4. Compaction

| | |
|---|---|
| **Live** | `core/src/session/compaction.ts` via SessionRunner / `v2Svc.compact`. HTTP `summarize` = `switchModel` + `v2Svc.compact`. |
| **Parallel** | `opencode/src/session/compaction.ts` remains on disk for `SessionPrompt` + `compaction.test.ts`. **Not** registered on HTTP or app-runtime (2026-08-14). |
| **Keep-list** | Overflow recovery, memory flush, drop tape — on core/runner. |
| **Conclusion** | **dead-reg done** for production graphs. Do not delete the module until v3 selection/survival tests are mirrored or the test file is retargeted. |

### 5. Revert

| | |
|---|---|
| **Live** | HTTP `v2Svc.revert.stage/clear/commit`. Tape truncate/restore on core session. |
| **Parallel** | `SessionRevert.node` **not** in HTTP or app-runtime (2026-08-14). File remains for `SessionPrompt` tests. `RevertPayload` still imports V1 `RevertInput` fields (schema only). |
| **Keep-list** | Locked 08-07 HTTP semantics — already on V2 handler. |
| **Conclusion** | **dead-reg done** for production graphs. Schema import can stay until payload is inlined. |

### 6. Second compile (sidecar, not a second drain)

| | |
|---|---|
| **Live drain compile** | `@opencode-ai/llm` + `LLMRequest.compiled` |
| **Sidecar** | `packages/opencode/src/session/llm.ts` constructed in `app-runtime.ts` + `httpapi/server.ts`; `applyCaching` via `ProviderTransform.message`; `native-runtime.ts`; `handlers/project-copy.ts` |
| **Conclusion** | **keep** until title/native/copy streams move to `@opencode-ai/llm`. Wave D must **not** delete `applyCaching` while this service is constructed. |

### 7. Permission

| | |
|---|---|
| **Live** | PermissionV2 / QuestionV2 (TUI/tools) |
| **Compat** | Instance `permissionRespond` → V1 `Permission.Service` |
| **Conclusion** | **keep** (08-07 lock). No dual-write. |

---

## Runtime graph

`httpapi/server.ts` and `app-runtime.ts` register `Session.node` (list/get/TUI rows) + `SessionV2.node` + `ToolHostBridges` + `LLM.node` (`applyCaching` sidecar). They do **not** register `SessionPrompt.node` / `SessionProcessor.node` / `SessionCompaction.node` / `SessionRevert.node` (unregistered 2026-08-14). Those modules remain constructible from `prompt.test.ts` / `workspace.ts`.

---

## Wave D gate (do not execute from this file)

Allowed later, and only after a dedicated execution plan:

| Pair | Next action when keep-list is proven |
|---|---|
| Task shim | **done** (2026-08-14): no Host → error; V1 `runTask`/`ops.prompt` deleted |
| HTTP fork/deletePart/updatePart | **done** (2026-08-14): core `SessionV2` + tape; HTTP `v2Svc.*` |
| V1 compaction/revert/processor nodes | **done** (2026-08-14): unregistered from HTTP + app-runtime. Modules stay for tests. |
| `runLoop` / `prompt.ts` | **`runLoop` deleted.** `prompt.ts` is the V1-shaped adapter over live drain. Keep the file while `prompt.test.ts` constructs `SessionPrompt.Service`. Duplicate compile: **already-safe-to-unreg**. |
| `session/llm.ts` / `applyCaching` | keep |
| Permission V1 | keep |
| Suffix rename `SessionV2` → `Session` | separate PR after one path |

**Forbidden:** resurrect `runLoop` or port PromptTape onto a leftover V1 loop; delete tape/loop tests to make a delete green; suffix-rename `SessionV2` → `Session` in this wave.
