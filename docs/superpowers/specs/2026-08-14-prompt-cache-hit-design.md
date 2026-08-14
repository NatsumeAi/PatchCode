# Prompt Tape — Design

**Date:** 2026-08-14
**Status:** source of truth (replaces the freeze-and-patch draft)
**Scope:** the **live session drain** — `SessionV2.prompt` → `SessionExecution` → `SessionRunner` / `runner/llm.ts` (HTTP `session.prompt` / `prompt_async` / `command` already call this). Go/Zen DeepSeek Chat. Not Anthropic `cache_control` as the hit strategy.

**One compile. Names `V1`/`V2` are not a delete filter.** Earlier session work **kept** some V1-named modules (they still do work) and **removed** some V2-named ones. Follow-up is to strip the suffixes and leave **one** set. Do not delete “because it says V1.”

## 0. One compile, not “delete all V1”

### 0.1 What is live today

| Capability | Implementation that runs | Do not treat as |
|---|---|---|
| HTTP/TUI prompt, command, compact drain | `SessionV2.prompt` → `SessionRunner` / `runner/llm.ts` | “still V1” |
| Chat wire for that drain | `@opencode-ai/llm` `LLMClient` | `packages/opencode/src/session/llm.ts` |
| Revert / permission / summary / some types | Mixed names; see `docs/superpowers/specs/2026-08-07-v1-runtime-inventory.md` | Automatically dead |

The **duplicate compile** (second way to build a provider prompt) is:

`SessionPrompt.runLoop` → `SessionProcessor` → `MessageV2.toModelMessages` → `ProviderTransform.applyCaching` + `system.ts` (`Today's date: ${new Date().toDateString()}` every turn).

HTTP prompt does not use it. It is still **registered** and **tested**. That is the set we want gone **if and only if** a caller inventory shows zero production uses.

### 0.2 Delete rule (hard)

A symbol may be removed only when **all** of these hold:

1. `rg` of `packages/opencode/src`, `packages/tui/src`, `packages/app/src`, `packages/core/src` shows **no production caller** (tests do not count as a reason to keep a second drain).
2. The capability still exists on the live drain (or the product has dropped it).
3. After delete: `bun --cwd packages/core test` and `bun --cwd packages/opencode test` for the affected packages, plus the session-runner suite, stay green. Any red test is migrated to the live drain or the delete is reverted.

If any production caller remains → **stop and report**. Cut that caller to the live drain first. Never leave a half-deleted V1 that TUI/shell/task still hits.

### 0.3 Must keep until callers are gone (not “V1 = unused”)

From the 2026-08-07 inventory and current tree. **Do not delete in the tape wave:**

| Keep | Why |
|---|---|
| `SessionSummary` | HTTP `diff` / summary still uses it |
| `Permission.Service` (V1-named) | Instance `permissionRespond` compat; TUI is PermissionV2 |
| Message / part types still imported by TUI (`MessageV2`, `SessionV1.WithParts` in adapters) | UI log, not a second compile |
| `SessionRevert` registration until its **tests** are migrated | HTTP revert already V2; tests still call V1 |
| `SessionPrompt.shell` / `SessionProcessor` **if** shell or task host still calls them | Different feature from prompt compile; inventory first |
| `packages/opencode/src/session/llm.ts` **if** title/native/project-copy still stream through it | Not the SessionRunner drain; do not rip `applyCaching` out from under a live stream |

`applyCaching` is only a delete candidate after **every** `ProviderTransform.message` caller that still runs in production is gone or no longer needs it. Today it is invoked from `session/llm.ts` and `llm/native-runtime.ts`, which are still **registered** on the instance server. That is **not** “safe to delete this afternoon.”

### 0.4 End state (suffixes)

After there is one compile and one drain:

- `SessionV2` → `Session` (or keep `SessionV2` until a dedicated rename PR)
- Drop `V1`/`V2` from **new** APIs
- Rename is a **separate** PR from tape and from delete. Do not mix 500-file renames into the cache wave.

The tape is implemented **only** on the live runner. We do **not** port tape onto `runLoop`. We do **not** keep `runLoop` “just in case” once inventory is empty.

## 0.1 What this is not

The previous draft treated cache as a repair list: freeze tools, freeze persona, canonicalize schema keys, stop one merge, … That can *approximate* a stable prefix. It is not how the systems that actually keep implicit cache hot are built.

Those systems do not “reassemble then freeze.” They treat the provider prompt as a **tape**: the next request is the previous request’s body plus a new tail. Nothing in the middle is rebuilt.

99.85% is not a feature and it is not `cache_read > 0`. On a long tape it is the arithmetic `1 - tail/total`. Offline CI asserts the tape was not rewritten. The **armed Go Flash live test** must actually score that shape (see §4). A 5k prefix cannot.

## 1. Invariant (the only one that matters)

For every intra-epoch Go/Zen Chat call after the first of that epoch:

```
body_{n+1}.tools     === body_n.tools
body_{n+1}.messages  === body_n.messages + tail
```

`tail` is only: new user / assistant / tool / ephemeral-this-call.

Forbidden, even once, inside an epoch:

- Re-join `system[]` from live agent + baseline + persona + verifier
- Re-`materialize` tools onto the wire
- `toLLMMessages(entire store)` and lower again
- Mutate a message that was already sent (including Chat `<system-update>` merged into a previous user)
- Re-stringify tool `arguments` from a parsed object
- Re-read `file://` that was already inlined on the tape

SessionMessage stays the **UI/event log**. It is not the provider log. The provider log is `PromptTape`.

## 2. What Hermes / Codex / Pi / OpenClaw actually do

Checked against `/home/huyongjun/reference/{hermes-agent,codex,pi,openclaw}`.

**Hermes** (`agent/system_prompt.py`, `agent/conversation_loop.py`):

- System is three layers ordered for cache: `stable` (identity, tool discipline) → `context` (AGENTS.md) → `volatile` (memory, profile, date-only timestamp).
- Built **once** per session onto `_cached_system_prompt`, persisted on the session row, replayed as a **single string**. Compression is the only rebuild.
- Mid-session recall / plugin / steer go into the **current user**. Comment in `conversation_loop.py`: changing system breaks the cache prefix.
- They still copy `conversation_history` into `api_messages` each turn — but that list **is** the API messages, not a second schema re-lowered from a UI store.
- They also have `ephemeral_system_prompt` concatenated at send time. That *does* bust system bytes. We will not copy it. Verifier/timer stay out of system.

**Codex**:

- Prefix-identity tests: request N’s input is a prefix of N+1; instructions/tools constant.
- Env diffs / warnings are appended, not rewritten.
- `previous_response_id`: the prefix stays on the server; they do not resend it. Chat Completions / DeepSeek **do not have this**. The Chat equivalent is: persist the last wire body locally and only `messages.push`.
- `session_startup_prewarm.rs`: session open, before the user types, send instructions+tools+empty history to warm KV. First user turn is already “prefix hit + new user.”
- GPT-5.6 note: implicit breakpoints follow the latest user/tool. A stable prefix plus a *changing* suffix can still miss if you rely on implicit breakpoints at the wrong boundary. Explicit breakpoints only when measured. Irrelevant to Go/Zen DeepSeek, which is implicit whole-prefix. Do not pile `cache_control` onto DeepSeek (OpenClaw: no benefit).

**Pi:** `prompt_cache_key` / 24h retention are affinity knobs for OpenAI, not a tape. Anthropic: breakpoint on the *last* block of the previous turn; compact requests `cacheRetention: "none"`. Late tools wait for the next epoch.

**OpenClaw:** historical user bytes stay historical. DeepSeek: do not stamp Anthropic markers.

Steal the invariant and the prewarm. Do not steal Anthropic marker layout as the Go/Zen plan.

## 3. Target architecture (OpenCode)

```
PromptTape {
  system:  string                         // written once at epoch origin
  tools:   ChatTool[] | undefined         // written once at epoch origin (wire JSON)
  messages: ChatMessage[]                 // conversation after system; append-only
}
```

Send path (Go/Zen Chat):

```
body.messages = [{ role: "system", content: tape.system }, ...tape.messages, ...ephemeral]
body.tools    = tape.tools
```

`ephemeral` is request-only (verifier reject, harness timer, last-step `MAX_STEPS_PROMPT`). It is **not** appended to the tape. Next call does not include the previous ephemeral tail. That means `isPrefixOf(N, N+1)` may be false when ephemeral is present; still required: `tools` identical, `messages[0]` identical, durable `tape.messages` is a prefix.

`LLMRequest.compiled` carries that body. `OpenAIChat.fromRequest` **must not** run `lowerMessages` / `lowerTool` when `compiled` is set. That is how re-lowering is cancelled, not “made more stable.”

`LLMRequest.system` / `.messages` / `.tools` may still be filled for compaction token estimates and tool `settle`. They are not the Chat wire when `compiled` is set.

### 3.1 Epoch origin (the only build)

Once per Context Epoch:

1. `system = join(agent.system, epoch.baseline, persona)` — one string. No verifier, no timer, no recall, no wall clock.
2. `materialize` tools **once**. Sort by name. Snapshot `describeTaskAgents` into the task description at this moment. Lower to Chat `tools[]` JSON. That JSON is the tape.
3. `settle` stays live-by-name (execution). Advertised JSON does not change mid-epoch. Tools that appear later wait for the next epoch (Pi).
4. Optional: persist the tape on `session_context_epoch.tape_json`. Reload on process restart. Do not hydrate from SessionMessage unless tape is missing (legacy).

After origin, `system` and `tools` are immutable for the epoch. There is no second join.

### 3.2 Append (the only mutation)

| Event | On the tape |
|---|---|
| User prompt (text + files) | New `role: user`. `file://` inlined to `data:` **once**; that URI is what the tape stores. |
| ContextUpdated (date, AGENTS.md, memory_summary) | New `role: user` with `<system-update>…</system-update>`. **Never** concatenate into a previous user. |
| Recall (epoch-start or refresh) | New `role: user`. Not system. Empty-after-nonempty is another user line (“cleared”), not a system rewrite. |
| Assistant stream | New `role: assistant` with `tool_calls[].function.arguments` = **exact delta accumulator string**, not `JSON.stringify(parsed)`. |
| Tool result | New `role: tool` with the framed text computed **once** at settle. |
| Compaction | **New tape.** Old tape discarded. Hydrate kept tail once onto the new tape. First call of the new epoch is cold (excluded from the metric). The summarizer request is a different prompt, not a patch on the old tape. Anthropic compact: `cache: "none"` (adapter). Go/Zen: just a new prefix. |

`toLLMMessages(store)` is allowed only to **hydrate a new tape** (legacy row, or compact kept-tail). It is not on the per-step path.

### 3.3 Prewarm (Codex’s extra, Chat-shaped)

When the epoch tape exists and the model is allowlisted Go/Zen Chat, fire one `generate`:

- `messages = [{ role: "system", content: tape.system }]`
- `tools = tape.tools`
- `max_tokens: 1`, `temperature: 0`
- **No dummy user.** A ping user would sit in the prefix and be replaced by the real first user → miss from the first user onward.

If the host rejects system-only messages, skip prewarm. Do not poison the tape. Live test: after a successful prewarm, first real user call must show `cache_read > 0` on the system+tools prefix. If the host does not carry system-only KV into `system+user`, prewarm is a no-op — drop the claim, keep the tape.

Schedule: epoch origin, racing the first user when possible. `Session.create` only if agent+model are already known. Best-effort. Steady-state hit does not depend on it; first-turn cold does.

### 3.4 Last step / generation

Keep `tape.tools` on the cap step. Do not omit `tools`. `tool_choice: "none"` is an overlay, not a tape edit. Probe on Go whether changing `tool_choice` drops `cache_read`; if it does, leave `tool_choice` alone and constrain via `MAX_STEPS` in the ephemeral tail.

Do not change `temperature` / `max_tokens` / `tool_choice` between the warmup request and the scored request. If the host hashes the whole Chat body, a probe-only `maxTokens: 16` rewrite is a full miss and will never print 99.85%. Freeze the generation envelope on the tape at origin. `LLM.updateRequest` may swap **model** for the live host; it must not change generation between the two generates that are compared.

Last-step `tool_choice: "none"` is excluded from the 99.85% scored request (it is a cap step). Probe it separately. If it drops `cache_read`, last-step is allowed to miss; the growing-loop requests must not change `tool_choice`.

### 3.5 Protocol adapters (second layer, not the plan)

| Host | What we do |
|---|---|
| Go/Zen DeepSeek Chat | Tape + implicit prefix. No `cache_control`. |
| OpenAI Chat (not this live gate) | Same tape. Optional `prompt_cache_key` later; not required. |
| Anthropic | Last-block breakpoint + compact `none`. Out of this workstream’s live gate. |

### 3.6 Every path that can move the hit rate

If it sends Chat tokens or changes `system` / `tools` / already-sent messages, it is in this table. “Not the scored 99.85% call” still has a tape rule. Missing a row is a plan bug.

**Legend:** **append** = grow tape, next send is prefix+tail (this is 99.85%). **identical** = resend the same `compiled` (retry). **truncate** = drop suffix of tape to a boundary, then append (hit through what remains). **new tape** = new `sessionID` or new `baselineSeq`; first send cold. **sidecar** = different `LLM.request`; must not read or write the session tape. **exclude** = do not use that call’s `hitRate` as the 99.85% claim.

#### A. Same session, same epoch — must stay a prefix

| Situation | Code | Tape | 99.85% scored? |
|---|---|---|---|
| Tool loop step N→N+1 (one or many `tool_call`) | `runTurnAttempt` while `needsContinuation` | Append assistant (exact `arguments` strings) then each `role: tool` in **assistant `tool_calls` array order**, not completion order | **Yes** (this is the main loop) |
| Parallel tools | `FiberSet` settle | Same: wait for all, append in call order | Yes |
| Provider-executed tools | `event.providerExecuted` | Already inside the assistant message; do not also append a duplicate `role: tool` | Yes |
| Permission wait / Question wait | `PermissionV2` / `QuestionV2` | No LLM send while blocked. After allow: append one tool result, continue. After deny: append the error tool result once, continue. Do not rebuild | Next generate after result: yes |
| User declined / interrupt during tools | `failUnsettledTools` | Do **not** append a partial assistant. Unsettled tools get a failed tool message **or** the attempt is discarded; pick one and keep it for resume | Next successful generate: yes if prefix intact |
| Last step (`agent.steps`) | `isLastStep` | Keep `tape.tools`. `MAX_STEPS` ephemeral only. `tool_choice: none` overlay — probe; may miss this one call | **Exclude** that one call if `tool_choice` changes |
| Verifier reject / harness timer | `renderVerifierFeedback` | Ephemeral trailing user. Not persisted. Next call drops it | **Exclude** the verifier-tailed call; following durable loop: yes |
| Steer (user types while busy) | `promoteSteers` | Append new `role: user` after current assistant/tool settlement. Same tape. Do not origin | Yes |
| Queue (next prompt after settle) | `promoteNextQueued` | Same as steer: append user | Yes |
| `/command`, `init`, slash expand | HTTP → `SessionV2.prompt` | Same as user append (text is the expanded template) | Yes |
| `noReply` / `projectUser` | HTTP prompt flags | Still append the user to the tape if it is on the model transcript; if it is UI-only, do not | Only if it went on the wire |
| Shell | `SessionV2.shell` | Append one user-shaped shell block (`lower` once). Next model turn sees it as tail | Yes |
| Synthetic / peer_message | `SiblingMessage.deliver` steer | Append as user on the **target** session’s tape | Target session: yes after that append |
| ContextUpdated (date, AGENTS.md, memory_summary / dream) | `SessionContextEpoch.prepare` | New user `<system-update>`. Never merge into an old user | Yes (tail is the update) |
| Recall refresh | `MemoryRecall` | New user, not system. Cleared → another user line | Yes |
| Grace budget turn | `budget.useGrace` | Same tape, another generate | Yes |
| `session.resume` / drain rejoin | `SessionRunner.run` | Load tape (`Map` then `tape_json`). **Do not** `origin()` if `sessionID:baselineSeq` matches. Append only what landed while idle | Yes |
| Process restart then resume | `tape_json` | Reload tape; rematerialize `settle` by name only | Yes |
| HTTP 429 / transport retry | `llm.stream` layer | Same `compiled` body. Tape unchanged | Yes (identical resend) |
| W1 stream retry (`MAX_STREAM_ATTEMPTS`, `onFailover.recovered`, before assistant started) | `runTurnAttempt` while | **identical** `compiled`. Do not append. Fresh publisher (already true) | Yes |
| Stream idle timeout then retry | 120s timeout | If classified retryable and no assistant started: identical. If assistant started: treat as interrupt (no partial append) | Yes if identical |
| MCP/plugin/structured-output tools appearing mid-epoch | `materialize` | **Do not** put them on the wire until next epoch (Pi). Execution `settle` may still run by name for already-advertised tools | Yes (tools JSON frozen) |
| Plugin / skill text that would rewrite `agent.system` | plugin agent, `Session.skill` | Skill is currently `OperationUnavailable`. When it lands: **append user** (skill body), never rejoin system. Plugin system-prompt patches wait for the next epoch | Yes after append |
| Circuit breaker Open | `allowRequest` / `shouldContinue` | **No send.** Tape unchanged | n/a (no call) |
| Circuit breaker HalfOpen probe | same | **identical** `compiled` of the request that will run. Do not shrink `max_tokens` / drop tools for the probe | Yes if that generate runs |
| Doom-loop (repeated tool fingerprint / repeated claim) | `DoomLoop` → `HardAbort` | Stop. **Do not** insert a reminder at `messages[0]` (Grok bust). Tape stays; no partial append | Next generate only if epoch unchanged: yes |
| Tree-budget exhausted | `treeBudget.debit` | Same as `budget_exhausted`: stop, tape stays | Next generate: yes |
| Loop timer 24h / `hard_timeout` | `TimerDaemon` `LoopTerminated` | Stop. Tape stays | Next generate: yes |
| `/loop` goal / timer / breaker | `loop-control/command.ts` | Harness state only. No LLM unless the command also admits a user prompt (then table A user append) | Only if a user went on the wire |
| Goal auto-seed from first user | `buildDrainContext` | Must **not** rewrite `tape.system`. Goal is harness state | Yes (unchanged prefix) |
| Persona snapshot | `PersonaInject.systemTextForSession` at **origin only** | File change or fingerprint drift mid-epoch does **not** rejoin system. Child resume persona mismatch: **reject**, do not origin a drifted persona onto the old tape | Yes (frozen) / child reject: n/a |
| Reasoning / thinking parts | assistant stream | Append **exact streamed reasoning bytes**. Same-model next turn keeps them. Do not drop, re-wrap, or convert to text mid-epoch | Yes |
| Media / `file://` | `materializeMedia` | Inline to `data:` **once** at the user append. Later turns send that same URI/bytes; do not re-read the file | Yes |
| Rapid-fire users in one drain | `promoteSteers` / queue | Append each admitted user in admit order. One origin. Do not merge users | Yes |
| Auth / `content_policy_blocked` / non-retryable | `ErrorClassifier` | **No retry.** Tape unchanged (nothing appended) | n/a |
| Concurrent drains, different `sessionID` | `runTurnAttempt` isolation | Never share a `PromptTapeStore` key. Parent/child/sibling are different keys | Each session’s own score |
| Crash mid-stream / background-job rejoin | W3 durable job | No partial assistant. Resume loads tape; identical or append-only | Yes |
| `response_format` / `stream` / `n` / penalties | Chat body | Frozen on the tape envelope at origin with temperature / max_tokens / tool_choice | Yes |
| Empty / whitespace-only assistant that was actually sent | stream success | Append what was sent. Do not omit then later invent a placeholder | Yes |
| Parent sees `SubagentFailed` | loop-control | Abort parent drain. Parent tape stays (no child bytes copied onto it) | Parent next: yes if epoch unchanged |
| Child iteration cap (50 vs parent 90) | `budget.setCap` | Child’s own last-step rules. Do not copy parent `compiled` | Child loop: yes |

#### B. Same session — tape shortens or splits

| Situation | Code | Tape | 99.85% scored? |
|---|---|---|---|
| Revert (stage/commit) | `SessionV2.revert` | **Truncate** tape to the boundary message. Next user is append after that. Remaining prefix can still hit | After truncate+append: yes through boundary |
| Unrevert | `revert.clear` | Restore the pre-truncate tape snapshot (store one backup) or hydrate from remaining SessionMessage **once**. Do not leave tape longer than UI history | Next generate: yes iff bytes match a previously sent prefix |
| Delete last message | HTTP delete | Truncate like revert | Yes through remainder |
| Delete **middle** message | HTTP delete | Cannot un-append the middle. **Hydrate a new tape** from surviving messages (byte-identical to a prefix only if the deleted span was a suffix). From the hole onward: cold. Do not send ghost messages | Exclude first generate after middle-delete |
| `budget_exhausted` / abort / terminal | `terminal.request` | Stop sending. Tape stays. Later resume/new prompt appends on the same tape if epoch unchanged | Next generate: yes |
| Overflow → compact succeeds | `continueAfterOverflowCompaction` | **New tape** (new `baselineSeq`). Summarizer is sidecar | First post-compact: **exclude**. Later: yes on the new tape |
| Manual `/compact`, HTTP `summarize` | `SessionRunner.compact` | New tape. Compaction LLM is sidecar (`cache: none` on Anthropic) | First after: exclude |
| Agent switch | `agent-switched` (omitted from `toLLMMessages`) | If `agent.system` or advertised tools would change: **new tape**. If only a UI marker: ignore | First after real switch: exclude |
| Model / variant / provider switch | `model-switched`, `models.resolve` | **New tape**. Different tokenizer/host KV | Exclude first |
| Failover that **changes model** | `onFailover` | New tape. Failover that only retries same model: identical (table A) | Exclude if model changed |
| Compaction `ReplacementBlocked` | `context-epoch` | Keep old tape. Do not rewrite `system` | Yes (unchanged) |
| HTTP `session.fork` at `messageID` | `session.fork` (today still V1-named HTTP) | **New session, new tape.** Hydrate once from parent messages **up to** `messageID` (that prefix is the child’s origin conversation). Do not share parent `PromptTapeStore` key. Do not keep a live pointer into parent tape | Child first generate: **exclude**. Later child loop: yes |
| `deletePart` / `updatePart` | HTTP part mutate | If it changes bytes already on the tape: **hydrate a new tape** (same as middle-delete). If it only edits UI-only fields that never went on the wire: ignore | First generate after wire mutation: exclude |
| `session.remove` / delete session | HTTP delete | Drop tape (`clear` that session’s keys). No further sends | n/a |
| Compact / revert / fork / deleteMessage while drain busy | `SessionBusyError` | **No tape mutation** under a live stream. Wait until idle, then apply the table B rule | After idle apply: as that row |
| `toLLMMessages` compaction hoist (checkpoints moved to front) | `to-llm-message.ts` today | **Forbidden on the hot path.** That rewrite is why the tape exists. Hydrate-new-tape after compact may place the checkpoint as the **start** of the new tape only | First after compact: exclude |

#### C. Other sessions / other prompts — never the parent tape

| Situation | Code | Tape | 99.85% scored? |
|---|---|---|---|
| Subagent spawn (`task`) | child `Session.create` + `parentID` | **Child’s own tape.** Origin from child agent + child tools. Parent tape only appends the parent’s `task` tool result when the child settles | Parent loop: **yes**. Child first request: **exclude** (cold). Child after warmup: child’s own 99.85% |
| ForkMode `FullHistory` / `LastNTurns` / `PromptOnly` | `projectParentMessagesForInsert` | Child first user may be a **synthetic** parent-trace block. That is the start of the **child** tape, not a copy of parent `compiled` | Child first: exclude |
| `task_id` resume of a child | `SubagentIdentity` | Load **child** tape by child `sessionID`. Do not origin again. Do not use parent tape | Child: yes |
| Subtask XML embed without spawn | HTTP prompt `_subtasks` | Parent user text includes `<subtask>`. Parent append | Parent: yes |
| Sibling `peer_message` | `SiblingMessage` | Steer on **target** child tape | Target: yes |
| Title generation | `ensureTitle` | **Sidecar.** `tools: []`, different system. Never `PromptTapeStore.set` | **Exclude.** Must not mutate session tape (today it races the drain — pin that) |
| Memory dream / flush / summary / consolidate | `memory/*.ts` | **Sidecar.** If they later write `memory_summary` into session context, that is ContextUpdated on the session tape (table A), not sharing their request | Sidecar: exclude. Session after summary lands: yes |
| Project-copy / native `session/llm.ts` | HTTP copy, `native-runtime` | **Sidecar** until Wave D inventory says otherwise. Not the runner tape | Exclude |
| Verifier’s own LLM (if any) | `verifier.ts` | Sidecar. Feedback text is ephemeral user on the **session** send | Sidecar: exclude |
| HTTP `session.update` (title / metadata / archive / permission ACL) | HTTP patch | **Must not** read or write the session tape. Title string is session row, not `tape.system` | n/a |
| Share / unshare | HTTP | No tape | n/a |
| Snapshot / step diffs (`persistStepDiffs`) | `ensureTitle` adjacent | UI summary. No tape | n/a |
| Worktree-isolated child | `WorktreePool` + task `isolation` | Child **origin** may read AGENTS.md from the worktree **once**. Parent tape unchanged | Child first: exclude. Child later: yes |
| ACP `forkSession` | `acp/service.ts` | Same rule as HTTP fork: new tape | Child first: exclude |
| `prompt_async` | HTTP | Same drain as `prompt`. Same tape | Yes |
| list / get / wait / events / history | HTTP read | No tape | n/a |
| Session.create (empty) | `SessionV2.create` | No origin until first drain that needs a generate. Optional prewarm if agent+model already known | First user: exclude unless prewarm |

#### D. Host / envelope (bytes may be identical and still miss)

| Situation | Rule |
|---|---|
| DeepSeek block alignment (64–128) | Not a tape bug. Why Layer B needs ~100k |
| `tool_choice` / `max_tokens` / `temperature` / `stream` flicker | Freeze envelope on the tape at origin. Retry/resume/tool-loop use the same. Probe `tool_choice` |
| KV stickiness (multi-replica Go/Zen) | Probe same `compiled` twice; then with/without `prompt_cache_key` or session headers. If miss, affinity is a host constraint — do not “fix” by rewriting messages |
| Idle TTL | Probe same tape after 5–10 min. If cold, document; optional re-prewarm. Do not rebuild system |
| First request of an epoch / after compact / after model switch | Exclude unless prewarm made the first **user** call a hit |
| Huge tool result (5k) | That one request’s rate dips; **next** must absorb it (it is now on the tape) |
| Title / compact / dream sidecar | Different prefix; ignore their `cached_tokens` in the session score |

#### E. Hard rules that fall out of the table

1. Append to the session tape **only after** a successful stream (or a committed revert/truncate). Retries send `identical` compiled.
2. One tape key: `` `${session.id}:${baselineSeq}` ``. Parent and child never share a key.
3. Title, compact summarizer, memory, project-copy, verifier-model **must not** call `PromptTapeStore.set` on the session key.
4. Revert/delete-tail **truncate**; delete-middle **hydrate new tape**.
5. Fork/spawn/HTTP fork = new session = new tape. Parent 99.85% is the parent tool loop, not the child’s first generate.
6. Harness signals (timer, verifier, doom-loop, `/loop`, goal, circuit breaker) never rewrite `tape.system` or `messages[0]`. Timer/verifier = ephemeral trailing user. Doom-loop/breaker Open/24h = stop, no inject.
7. `toLLMMessages` compaction-hoist and Chat `lowerMessages` user-merge are **hydrate-only** bugs if they run per step.
8. Busy-session mutations (compact/revert/fork/delete) wait. They do not patch a live `compiled`.

Hermes: do not persist a failed turn onto history. Codex: interrupt does not become the next prefix. Pi: late tools wait for the next epoch; compact is a different cache. Grok: do not rewrite the tool-loop body; do **not** insert reminders at `messages[0]`.

## 4. Metric — and why 99.85% is rare

```
hit = cache_read / (cache_read + uncached_input)
```

99.85% means uncached ≈ **0.15% of the whole input**. That is a long-tape number:

| Prefix tokens | Uncached budget for 99.85% | What fits |
|---|---|---|
| ~5k (`LARGE_CACHEABLE_SYSTEM`) | ~7.5 tokens | Nothing. DeepSeek implicit cache is block-aligned (typically 64–128). A `"ping"` user already blows the budget. `read > 0` here only proves the host reports cache, **not** 99.85%. |
| ~42k | ~64 tokens | One block of slop, almost no new text. |
| **~100k** | **~150 tokens** | Short new user + one alignment block. This is the demonstration size. |
| ~500k | ~750 tokens | A modest tool result still looks like 99.85%. |

This is why only a handful of harnesses ever print that number in a real run: they keep an append-only prefix **and** they routinely send tens of thousands of tokens of it. Tape without length cannot. Length without tape (any rewrite of `tools` / `messages[0]` / an old user) is a full miss and prints ~0% on that call.

Exclude from the 99.85% **scored** call: first request of an epoch (unless prewarm already baked system+tools), first request after compaction, model switch, last-step `tool_choice` change, verifier ephemeral (that call’s extra tail is not the growing-loop shape), a one-request dip from a huge new tool result. The **next** request must absorb that result. Title-generation requests are a different tape; do not mix them into the score.

DeepSeek block alignment of a few dozen tokens is not a regression. It **is** why the prefix must be ~100k, not 5k.

### 4.1 Offline CI

- Durable growing loop: `isPrefixOf(body_n, body_{n+1})`
- Ephemeral present: tools + `messages[0]` unchanged; `tape.messages` prefix holds
- Negatives: mutating `tape.system`, shuffling `tape.tools`, merging a system-update into an old user, re-stringifying arguments — each must fail the prefix test
- Do **not** assert `hit === 0.9985` offline. There is no tokenizer.

### 4.2 Live — two layers (both required to claim 99.85%)

Allowlist only:

| Role | id | Host |
|---|---|---|
| Required | `opencode-go/deepseek-v4-flash` | `https://opencode.ai/zen/go/v1` |
| Optional | `opencode/deepseek-v4-flash` | `https://opencode.ai/zen/v1` |
| Optional | `opencode/deepseek-v4-flash-free` | same Zen host |

Skip unless `LIVE_CACHE=1` (or `RECORD=true`) **and** a key. Helper throws on any other model.

**Layer A — host lights up** (not the 99.85% claim): tape-shaped Go Flash, system at least `LARGE_CACHEABLE_SYSTEM`, identical generation envelope on both calls, second `cache_read > 0`.

**Layer B — 99.85% demonstration** (the claim). All of these, one test:

1. Tape `system` ≥ **100k estimated tokens** (fixed sentence × enough repeats; not 250). Tools frozen. No dummy user.
2. Warmup generate **or** system-only prewarm, then append one short user (`"ok"` / `"ping"`).
3. Warmup and scored generate use the **same** `temperature` / `max_tokens` / `tool_choice` / `stream` fields. Swap model via `LLM.updateRequest` only.
4. Scored call: `inputTokens >= 80_000`, `cache_read > 0`, `uncached <= 200`, `hitRate >= 0.9985` **or** (`uncached <= 128 + 32` and `hitRate >= 1 - 200/inputTokens` if the host’s block size makes 0.9985 miss by a few dozen tokens — record the actual numbers in spec Risks, do not silently drop the floor to `read > 0`).
5. `isPrefixOf(prepare(warmup), prepare(scored))`.
6. Runner-shaped: same Layer B numbers from a SessionRunner-built `compiled` body (agent/baseline pumped to 100k), not only a hand-built tape.

Prewarm is what makes **turn 1** look like 99.85% (Codex). Without it, session-lifetime average including the cold first write is `(n-1)/n` of the steady-state rate and will not print 99.85% on a short session. Steady-state Layer B excludes that first write unless prewarm succeeded and the first **user** call is the scored call.

Forbidden live: Anthropic / OpenAI / Gemini / Bedrock / OpenRouter / `api.deepseek.com`.

## 5. Out of this round

Do not write these back into the plan:

- A 21st “generic optimization”
- Canonicalizing model tool-argument JSON (that *rewrites* the tape)
- `prompt_cache_key` as the hit strategy
- Anthropic `cache_control` on Go/Zen
- Making `isPrefixOf` green by persisting verifier
- Dummy-user prewarm
- Treating 99.85% as an **offline** CI equality
- Claiming 99.85% from Layer A (`read > 0` on ~5k)
- Treating a child session’s **first** generate as the parent’s 99.85% (it is a new tape)

Every row in §3.6 **is** this round. Tool loop, subagent, resume, and retry are four rows, not the set. HTTP fork, delete/update part, doom-loop, circuit breaker, persona freeze, reasoning bytes, media-once, busy-session waits, and harness-not-in-system are in scope. If a row has no test in the plan, add one.

Subagent **first** request is a new tape (cold). Child **resume** and parent **task-result** append are in scope.

## 6. Done when

0. Duplicate **compile** (`runLoop`) removed **only** after inventory shows zero production callers. Still-live V1-named modules (summary, permission, types, `session/llm.ts` if it still streams) stay. Suffix rename is a later PR.
1. Per-step runner path does not call `toLLMMessages` on the full store.
2. `OpenAIChat.fromRequest` on runner requests uses `compiled` (no `lowerMessages`).
3. Growing tool-loop CI: `isPrefixOf` true; verifier test expects trailing user, not a second system part; transcript still has no `verifier-feedback`.
4. §3.6 boundary CI (Task 9b coverage matrix): every row maps to a unit test, a runner test, a persist/live probe, or an explicit “no LLM / no tape write” assertion. Not only retry/resume/subagent/tool-loop.
5. Armed Go Flash Layer A: `read > 0` on a tape-shaped call. Necessary, not sufficient.
6. Armed Go Flash Layer B: ~100k prefix, identical envelope, scored `hitRate` in the 99.85% shape (§4.2). **Without Layer B, do not claim 99.85%.** `read > 0` on 5k is not that claim.
7. Compaction starts a new tape. Restart reuses `tape_json` if present.

## 7. Risks / Wave D inventory (2026-08-14)

Armed Go Flash live (2026-08-14, `opencode-go/deepseek-v4-flash` @ `https://opencode.ai/zen/go/v1`):

| Layer / probe | Result |
|---|---|
| A | PASS: prefix send `cache_read > 0` on the 250-repeat fixture |
| B (tape-shaped) | PASS: `input=104847` `read=104832` `uncached=15` `hitRate=0.999857` on `PromptTape.compiled` warmup+append with identical envelope |
| B (runner-shaped tools) | PASS: same numbers after `LLMClient.prepare` + sorted Chat tools, then warmup+append. Not a SessionRunner drain with `agent.system` pumped to 100k. |
| `tool_choice: none` | Prefix holds. `read` 4992 → 4736 (Δ−256). Overlay does not zero cache; last-step `none` stays. Thinking mode **rejects** `tool_choice: required`. |
| Huge tool result | Dip `input=15157` `read=4992` `uncached=10165` `rate=0.329`; next request `read=15104` `uncached=54` `rate=0.9964`. Thinking-mode `tool_calls` assistants must include `reasoning_content`. |
| Identical compiled (stickiness) | Second send `read=4992` |
| System-only prewarm → first user | Prewarm (`maxTokens: 1`) accepted; first user `read=4992` |
| Two-turn (assistant bytes on tape) | `read=4992` |
| Idle TTL 5 min | Still `read=4992` |

Do not treat Layer A `read > 0` as the 99.85% claim. Tape-shaped and prepare-sorted Layer B both meet `input >= 80_000`, `uncached <= 200`, `hitRate >= 0.9985`. Huge-tool dip is excluded from that claim; the following request absorbed the result.

| Symbol | Production callers | Keep / cut-over / delete |
|---|---|---|
| `runLoop` / `SessionPrompt.prompt` | Internal `packages/opencode/src/session/prompt.ts` only. HTTP/CLI/ACP use `SessionV2`. `tool/task.ts` V1 fallback still closes over `ops.prompt`. | **KEEP** until TaskTool fallback and `SessionPrompt.node` are cut over. |
| `applyCaching` via `session/llm.ts` | `provider/transform.ts` ← `session/llm.ts:333`, `native-runtime.ts:94`. `project-copy.ts` streams `LLM.Service`. | **KEEP** — second compile still alive on non-prompt streams. |
| `SessionPrompt.shell` | Definition only; HTTP uses `v2Svc.shell`. | KEEP while `SessionPrompt.node` is registered. |
| `SessionPrompt.node` | `packages/opencode/src/server/routes/instance/httpapi/server.ts` layer registration. | **KEEP** — registered on the HTTP server even though handlers yield `SessionV2`. |
| `system.ts` `environment()` | `session/prompt.ts` V1 loop only. `SystemPrompt.provider()` is still used by `session/llm/request.ts`. | KEEP `provider()`; do not delete `system.ts`. |

Wave D does **not** delete `runLoop` in this change: `SessionPrompt.node` is still provided, TaskTool still has a V1 fallback, and `prompt.test.ts` / structured-output tests still construct `SessionPrompt.Service`. Suffix rename is a later PR.

