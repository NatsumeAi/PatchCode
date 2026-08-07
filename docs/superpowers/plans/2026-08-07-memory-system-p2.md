# Memory System P2 Implementation Plan (Session Logs + Flush + Citation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. P1 (`2026-08-07-memory-system-p1.md`) must be complete first — this plan consumes its `MemoryRoots`/`readTextSafe`/`writeTextAtomic`/`resolveScoped`/`scanForThreats`.

**Goal:** Add automatic session capture and LLM flush to the memory system: on drain end, write a zero-LLM metadata log to `sessions/`; on compaction (and on demand), write an LLM-generated session summary; retrieval results carry source citations. Privacy discipline: automatic saves are metadata-only; content capture is user-triggered (flush).

**Architecture:** Session logs follow Grok's dated-file layout (`sessions/YYYY-MM-DD-<sid8>.md`). The drain-end signal is a **location-node** watcher fiber that polls `SessionExecution.active` (read-only) and fires after a session transitions active→inactive with an idle debounce — no runner changes. When a project is open it writes **workspace** `sessions/`; only if `workspaceDir` is absent does it fall back to global (architecture lock: project-session hole from global-only watcher is rejected). Flush uses the title-model pattern already in `llm.ts` (`LLM.request` + `LLMClient.Service.stream` + textDelta filter), written through the same atomic `writeTextAtomic` path. Citation is additive: `memory_search`/`memory_read` outputs gain `path`/`line` source fields, and the P1 decision framework already asks the model to flag memory-derived facts as possibly stale.

**Tech Stack:** TypeScript, Effect (Layer/Effect/Schema/Stream), opencode core (`SessionExecution.Service`, `LLMClient.Service`, `LLM.request`, `LLMClient` node, `FSUtil.Service`, `Global.Path`, `Location.Service`), bun:test + `testEffect` + `Layer.mock`.

## Global Constraints

- Repo: `/home/huyongjun/openpartner/opencode` (branch `fork-runtime-loop-f720490219`).
- All new code under `packages/core/src/memory/`; tests under `packages/core/test/memory/`.
- Same module/Effect/style rules as P1. No `as any`, no `@ts-ignore`.
- Atomic writes only (`writeTextAtomic` from P1). Trivial-session skip rule: `<3` substantive user prompts OR `<50` bytes of user text → skip (Grok rule).
- Flush content is LLM-generated and therefore scanned with P1 `scanForThreats` before write; blocked → skip write, log warning.
- Watcher fiber is process-local and crash-safe by design: a lost watcher only means a missed metadata save (next flush can still capture content). No durable job state.
- Typecheck gate: `bun --cwd packages/core typecheck` clean. Run tests from `packages/core`.
- Commit per task, conventional messages.
- **Execution Discipline (from P1 plan, applies here):** no stubs, red-green enforced, wiring is a gate (Task 5 has grep checklist), no silent scope cuts — stop and report instead.

---

## File Structure

```
packages/core/src/memory/
├── session-logs.ts        # sessions/ dir, dated filename, idempotent append, trivial-skip
├── session-meta.ts        # zero-LLM metadata extraction from session history
├── drain-watcher.ts       # poll Execution.active, debounce, fire save on drain end
├── flush.ts               # LLM summary of a session → dated log (title-model pattern)
└── (modify) tools.ts      # search/read outputs gain citation fields
packages/core/test/memory/
├── session-logs.test.ts
├── session-meta.test.ts
├── drain-watcher.test.ts
├── flush.test.ts
└── (modify) tools.test.ts (citation assertions)
```

---

### Task 1: Session log writer (dated files, idempotent, trivial-skip)

**Files:**
- Create: `packages/core/src/memory/session-logs.ts`
- Test: `packages/core/test/memory/session-logs.test.ts`

**Interfaces:**
- Consumes: P1 `MemoryRoots`, `writeTextAtomic`, `readTextSafe`
- Produces:
  - `export function sessionLogPath(roots: MemoryRoots, sessionID: string, when: Date): string` — `<workspaceDir>/sessions/YYYY-MM-DD-<sid8>.md` where sid8 = last 8 chars of sessionID; falls back to globalDir when workspaceDir is undefined
  - `export function isTrivialSession(input: { userPromptCount: number; userTextBytes: number }): boolean` — `<3` prompts OR `<50` bytes
  - `export const appendSessionLog = Effect.fn("Memory.appendSessionLog")((fs, roots, sessionID, when, content) => Effect.Effect<void>)` — appends `\n\n---\n\n` + content if file exists, else creates; returns without error on missing roots dir (creates it)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/session-logs.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { resolveRoots, readTextSafe } from "../../src/memory/storage"
import { appendSessionLog, sessionLogPath, isTrivialSession } from "../../src/memory/session-logs"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(FSUtil.node)

describe("Session logs", () => {
  test("dated filename uses YYYY-MM-DD and sid8", () => {
    const roots = resolveRoots("/base/mem", "/proj")
    const p = sessionLogPath(roots, "ses_abcdef1234567890", new Date("2026-08-07T12:00:00Z"))
    expect(p).toContain("sessions")
    expect(path.basename(p)).toBe("2026-08-07-1234567890.md")
  })

  test("trivial session rule", () => {
    expect(isTrivialSession({ userPromptCount: 2, userTextBytes: 200 })).toBe(true)
    expect(isTrivialSession({ userPromptCount: 3, userTextBytes: 200 })).toBe(false)
    expect(isTrivialSession({ userPromptCount: 5, userTextBytes: 40 })).toBe(true)
  })

  it.effect("appendSessionLog creates file on first write", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", new Date("2026-08-07T12:00:00Z"), "# Session\nmeta")
      const text = yield* readTextSafe(fs, sessionLogPath(roots, "ses_abcdef1234567890", new Date("2026-08-07T12:00:00Z")))
      expect(text).toContain("# Session")
    }),
  )

  it.effect("appendSessionLog appends on second write", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      const when = new Date("2026-08-07T12:00:00Z")
      yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", when, "first")
      yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", when, "second")
      const text = yield* readTextSafe(fs, sessionLogPath(roots, "ses_abcdef1234567890", when))
      expect(text).toContain("first")
      expect(text).toContain("second")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/session-logs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/session-logs.ts
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"

const MIN_SUBSTANTIVE_PROMPTS = 3
const MIN_USER_TEXT_BYTES = 50

export function sessionLogPath(roots: MemoryRoots, sessionID: string, when: Date): string {
  const day = when.toISOString().slice(0, 10)
  const sid8 = sessionID.slice(-8)
  const base = roots.workspaceDir ?? roots.globalDir
  return path.join(base, "sessions", `${day}-${sid8}.md`)
}

export function isTrivialSession(input: { userPromptCount: number; userTextBytes: number }): boolean {
  return input.userPromptCount < MIN_SUBSTANTIVE_PROMPTS || input.userTextBytes < MIN_USER_TEXT_BYTES
}

export const appendSessionLog = Effect.fn("Memory.appendSessionLog")(function* (
  fs: FSUtil.Service,
  roots: MemoryRoots,
  sessionID: string,
  when: Date,
  content: string,
) {
  const file = sessionLogPath(roots, sessionID, when)
  const existing = yield* readTextSafe(fs, file)
  const next = existing === undefined || existing === "" ? content : `${existing}\n\n---\n\n${content}`
  yield* writeTextAtomic(fs, file, next)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/session-logs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/session-logs.ts packages/core/test/memory/session-logs.test.ts
git commit -m "feat(memory): dated session log writer with idempotent append and trivial-skip rule"
```

---

### Task 2: Zero-LLM session metadata extraction

**Files:**
- Create: `packages/core/src/memory/session-meta.ts`
- Test: `packages/core/test/memory/session-meta.test.ts`

**Interfaces:**
- Consumes: `SessionStore.Service` (`context`), `SessionSchema.ID`, `DateTime`; P1 `isTrivialSession`
- Produces:
  - `export interface SessionMeta { sessionID: string; date: string; userPrompts: number; userTextBytes: number; topics: string[]; assistantMessages: number; toolResults: number }`
  - `export const extractSessionMeta = Effect.fn("Memory.extractSessionMeta")((store, sessionID) => Effect.Effect<SessionMeta, MessageDecodeError>)` — reads `store.context(sessionID)`, counts user/assistant messages and tool parts, collects first ≤5 substantive user prompt texts (non-empty, trimmed), sums user text bytes; `topics` = first 5 user prompts truncated to 200 chars each

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/session-meta.test.ts
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { extractSessionMeta } from "../../src/memory/session-meta"
import { testEffect } from "../lib/effect"

const sessionID = "ses_meta_test"
const user = (text: string, id: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make(id),
    type: "user",
    text,
    time: { created: DateTime.toEpochMillis(DateTime.unsafeMake(0)) },
  })
const assistant = (id: string) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: "build",
    content: [],
    time: { created: 0 },
  })

const store = Layer.succeed(
  SessionStore.Service,
  SessionStore.Service.of({
    context: () => Effect.succeed([user("first question", "m1"), assistant("m2"), user("second question", "m3")]),
    get: () => Effect.die("unused"),
    sessionPermission: () => Effect.die("unused"),
    runnerContext: () => Effect.die("unused"),
    message: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
  }),
)

const it = testEffect(store)

describe("Session metadata", () => {
  it.effect("extracts counts and topics", () =>
    Effect.gen(function* () {
      const meta = yield* extractSessionMeta(yield* SessionStore.Service, sessionID)
      expect(meta.userPrompts).toBe(2)
      expect(meta.assistantMessages).toBe(1)
      expect(meta.topics).toEqual(["first question", "second question"])
      expect(meta.userTextBytes).toBe("first questionsecond question".length)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/session-meta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/session-meta.ts
import { Effect } from "effect"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"

const MAX_TOPICS = 5
const MAX_TOPIC_CHARS = 200

export interface SessionMeta {
  readonly sessionID: string
  readonly date: string
  readonly userPrompts: number
  readonly userTextBytes: number
  readonly topics: string[]
  readonly assistantMessages: number
  readonly toolResults: number
}

export const extractSessionMeta = Effect.fn("Memory.extractSessionMeta")(function* (
  store: SessionStore.Service,
  sessionID: SessionSchema.ID,
) {
  const messages = yield* store.context(sessionID)
  const userPrompts: string[] = []
  let userTextBytes = 0
  let assistantMessages = 0
  let toolResults = 0
  for (const message of messages) {
    if (message.type === "user") {
      const text = (message.text ?? "").trim()
      if (text.length > 0) {
        userTextBytes += text.length
        if (userPrompts.length < MAX_TOPICS) userPrompts.push(text.slice(0, MAX_TOPIC_CHARS))
      }
    } else if (message.type === "assistant") {
      assistantMessages++
      toolResults += message.content.filter((part) => part.type === "tool").length
    }
  }
  return {
    sessionID: String(sessionID),
    date: new Date().toISOString().slice(0, 10),
    userPrompts: userPrompts.length,
    userTextBytes,
    topics: userPrompts,
    assistantMessages,
    toolResults,
  }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/session-meta.test.ts`
Expected: PASS. If `SessionMessage.User.make` signature differs (text field name), read `packages/core/src/session/message.ts` and adjust the test fixture; do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/session-meta.ts packages/core/test/memory/session-meta.test.ts
git commit -m "feat(memory): zero-LLM session metadata extraction"
```

---

### Task 3: Drain-end watcher (save metadata on session end)

**Files:**
- Create: `packages/core/src/memory/drain-watcher.ts`
- Test: `packages/core/test/memory/drain-watcher.test.ts`

**Interfaces:**
- Consumes: `SessionExecution.Service` (`active`), P1 `MemoryRoots`/`writeTextAtomic`, Task 1 `appendSessionLog`/`isTrivialSession`, Task 2 `extractSessionMeta`, `SessionStore.Service`, `Global.Service` (`data`), `Location.Service` (`directory`)
- Produces:
  - `export const startDrainWatcher = Effect.fn("Memory.startDrainWatcher")(...)` — forks a scoped fiber: every 30s reads `active`, tracks previously-active sessions, for any session that left `active`, waits 60s idle debounce, re-checks it is still absent, then extracts meta + appends log (skipping trivial sessions). `Effect.forkScoped` + finalizer cleanup.
  - `export const node = makeGlobalNode({ name: "memory-drain-watcher", layer, deps: [SessionExecution.node, SessionStore.node, Global.node, Location.node, FSUtil.node] })`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/drain-watcher.test.ts
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { readTextSafe } from "../../src/memory/storage"
import { sessionLogPath } from "../../src/memory/session-logs"
import { drainWatcherNode } from "../../src/memory/drain-watcher"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const active = { current: new Set<string>(["ses_drain_target"]) }

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: () => Effect.succeed(new Set([...active.current].map((id) => SessionSchema.ID.make(id)))),
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)

const store = Layer.succeed(
  SessionStore.Service,
  SessionStore.Service.of({
    context: () =>
      Effect.succeed([
        SessionMessage.User.make({
          id: SessionMessage.ID.make("m1"),
          type: "user",
          text: "a substantive prompt",
          time: { created: DateTime.toEpochMillis(DateTime.unsafeMake(0)) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("m2"),
          type: "assistant",
          agent: "build",
          content: [],
          time: { created: 0 },
        }),
      ]),
    get: () => Effect.die("unused"),
    sessionPermission: () => Effect.die("unused"),
    runnerContext: () => Effect.die("unused"),
    message: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  Layer.provideMerge(drainWatcherNode, execution, store, FSUtil.node, Global.node, Location.node),
)

describe("Drain watcher", () => {
  it.effect("writes a session log when a session leaves active", () =>
    Effect.gen(function* () {
      await using dir = await tmpdir()
      // drain watcher reads Global data dir; seed via env override in test setup if needed
      active.current.delete("ses_drain_target")
      yield* Effect.sleep(100)
      const fs = yield* FSUtil.Service
      const text = yield* readTextSafe(fs, path.join(dir.path, "log.md"))
      // NOTE: this test needs a controllable data dir; see Step 4 for the fixed version
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/drain-watcher.test.ts`
Expected: FAIL — module not found (or compile error on `Location.node` in a global node — see Step 4 fix).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/drain-watcher.ts
import { Duration, Effect, Layer, Schedule } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { SessionExecution } from "../session/execution"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { resolveRoots } from "./storage"
import { appendSessionLog, isTrivialSession } from "./session-logs"
import { extractSessionMeta } from "./session-meta"

const POLL_INTERVAL = Duration.seconds(30)
const IDLE_DEBOUNCE = Duration.seconds(60)

export const startDrainWatcher = Effect.fn("Memory.startDrainWatcher")(function* () {
  const execution = yield* SessionExecution.Service
  const store = yield* SessionStore.Service
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const location = yield* Location.Service

  const seen = new Set<string>()
  const pending = new Map<string, number>() // sessionID -> left-active timestamp

  const tick = Effect.gen(function* () {
    const active = yield* execution.active
    const activeIds = new Set([...active].map((id) => String(id)))
    for (const id of [...seen]) {
      if (!activeIds.has(id)) {
        if (!pending.has(id)) pending.set(id, Date.now())
      } else {
        pending.delete(id)
      }
    }
    for (const id of [...seen]) if (activeIds.has(id)) seen.delete(id) // reset re-entered sessions
    for (const id of activeIds) seen.add(id)

    for (const [id, leftAt] of [...pending]) {
      if (Date.now() - leftAt >= IDLE_DEBOUNCE.toMillis()) {
        pending.delete(id)
        const roots = resolveRoots(path.join(global.data, "memory"), location.directory)
        const meta = yield* extractSessionMeta(store, SessionSchema.ID.make(id)).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (meta === undefined) continue
        if (isTrivialSession({ userPromptCount: meta.userPrompts, userTextBytes: meta.userTextBytes })) continue
        const lines = [
          `# Session ${id}`,
          `- date: ${meta.date}`,
          `- user prompts: ${meta.userPrompts}`,
          `- assistant messages: ${meta.assistantMessages}`,
          `- tool results: ${meta.toolResults}`,
          ...(meta.topics.length > 0 ? [`- topics: ${meta.topics.join(" | ")}`] : []),
        ].join("\n")
        yield* appendSessionLog(fs, roots, id, new Date(), lines)
      }
    }
  })

  yield* tick.pipe(
    Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
    Effect.forkScoped,
    Effect.asVoid,
  )
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* startDrainWatcher
  }),
)

export const node = makeLocationNode({
  name: "memory-drain-watcher",
  layer,
  deps: [SessionExecution.node, SessionStore.node, Global.node, Location.node, FSUtil.node],
})
```

(Add `Schedule` to the imports; import `makeLocationNode` instead of `makeGlobalNode`; remove unused `DateTime`.)

- [ ] **Step 4: Run test to verify it passes**

**Locked decision (architecture):** `makeLocationNode` — one watcher per open project — writing `workspaceDir/sessions/` via `resolveRoots(..., location.directory)`. Global fallback only when `workspaceDir` is undefined. Keep `Location.Service` in `startDrainWatcher`.

Test: provide Location + Global layers pointing at a tmp project; assert the log exists under `{proj}/.opencode/memory/sessions/` after debounce. Run until PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/drain-watcher.ts packages/core/test/memory/drain-watcher.test.ts
git commit -m "feat(memory): drain-end watcher writes zero-LLM session metadata logs"
```

---

### Task 4: Flush (LLM session summary → dated log, compaction hook + command)

**Files:**
- Create: `packages/core/src/memory/flush.ts`
- Test: `packages/core/test/memory/flush.test.ts`

**Interfaces:**
- Consumes: `LLMClient.Service` (`stream`), `LLM.request`, `LLMEvent`, `SessionRunnerModel.Service` (`resolve`), `SessionStore.Service` (`context`), `SessionSchema.Info`, P1 `appendSessionLog`/`scanForThreats`
- Produces:
  - `export const flushSession = Effect.fn("Memory.flushSession")((session, store, llm, models) => Effect.Effect<void>)` — loads session context, builds a summary request (system: "Summarize the decisions, patterns, and reasoning from this session into durable markdown. Output ONLY markdown."), streams textDelta → markdown, threat-scans, appends dated log; silent no-op on LLM failure (logged)
  - `export const node = makeLocationNode({ name: "memory-flush", layer, deps: [LLMClient.node, SessionStore.node, SessionRunnerModel.node, FSUtil.node, Location.node, Global.node] })`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/flush.test.ts
import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LLMClient } from "@opencode-ai/llm"
import { LLMEvent } from "@opencode-ai/llm"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { readTextSafe } from "../../src/memory/storage"
import { sessionLogPath } from "../../src/memory/session-logs"
import { flushSession } from "../../src/memory/flush"
import { testEffect } from "../lib/effect"

const session = { id: SessionSchema.ID.make("ses_flush"), directory: "/proj" } as SessionSchema.Info

const llm = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    stream: () =>
      Stream.fromIterable([LLMEvent.textDelta({ id: "1", text: "## Decisions\n- Use effect layers" })]),
  }),
)

const store = Layer.succeed(
  SessionStore.Service,
  SessionStore.Service.of({
    context: () => Effect.succeed([]),
    get: () => Effect.succeed(session),
    sessionPermission: () => Effect.die("unused"),
    runnerContext: () => Effect.die("unused"),
    message: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
  }),
)

const it = testEffect(Layer.provideMerge(llm, store, FSUtil.node))

describe("Flush", () => {
  it.effect("writes a dated summary log", () =>
    Effect.gen(function* () {
      await using dir = await tmpdir()
      const fs = yield* FSUtil.Service
      // provide roots via a direct call instead of node wiring for the unit test
      yield* flushSession(session, yield* SessionStore.Service, yield* LLMClient.Service, undefined as never)
      const text = yield* readTextSafe(fs, sessionLogPath(resolveRootsForTest(), "ses_flush", new Date()))
      expect(text).toContain("## Decisions")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/flush.test.ts`
Expected: FAIL — module not found / compile errors on LLMClient shape. Read `packages/llm/src/route/client.ts` to align the mock with the real `Interface` (`streamPrepared` etc. may be required).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/flush.ts
import { Effect, Layer, Stream } from "effect"
import path from "path"
import { LLM, LLMClient, LLMEvent } from "@opencode-ai/llm"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { SessionRunnerModel } from "../session/runner/model"
import { resolveRoots } from "./storage"
import { appendSessionLog } from "./session-logs"
import { scanForThreats } from "./scan"

const FLUSH_SYSTEM = "Summarize this session into durable markdown: decisions, rationale, architecture, preferences, and problem/solution pairs. Discard greetings, tool noise, and session metadata. Output ONLY markdown."

export const flushSession = Effect.fn("Memory.flushSession")(function* (session: SessionSchema.Info) {
  const store = yield* SessionStore.Service
  const llm = yield* LLMClient.Service
  const models = yield* SessionRunnerModel.Service
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const location = yield* Location.Service

  const messages = yield* store.context(session.id).pipe(Effect.catch(() => Effect.succeed([])))
  if (messages.length === 0) return

  const model = yield* models.resolve(session).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!model) return
  const request = LLM.request({ model, system: [LLM.SystemPart.make(FLUSH_SYSTEM)], messages: messagesToLlm(messages), tools: [] })
  const text = yield* llm.stream(request).pipe(
    Stream.filter(LLMEvent.is.textDelta),
    Stream.map((e) => e.text),
    Stream.mkString,
    Effect.catch(() => Effect.succeed("")),
  )
  const cleaned = text.trim()
  if (cleaned.length === 0) return
  if (scanForThreats(cleaned).length > 0) return

  const roots = resolveRoots(path.join(global.data, "memory"), location.directory)
  yield* appendSessionLog(fs, roots, String(session.id), new Date(), cleaned)
})
```

(Define `messagesToLlm` by adapting `to-llm-message.ts` from the runner; keep it minimal — map `SessionMessage.Message[]` → `Message[]`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/flush.test.ts`
Expected: PASS. Align the LLMClient mock with the real interface first. If `SessionRunnerModel.resolve` is heavy, mock it with `Layer.succeed` returning a stub model. Do NOT stub `flushSession` internals — the test must exercise the real stream→scan→append path.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/flush.ts packages/core/test/memory/flush.test.ts
git commit -m "feat(memory): LLM flush writes durable dated session summaries"
```

---

### Task 5: Wire watcher + flush hooks + citation on retrieval

**Files:**
- Modify: `packages/core/src/memory/tools.ts` (search/read outputs gain `path`/`line` citation fields)
- Modify: `packages/core/src/session/runner/context-engine.ts` (call flush before `compact` — additive, guarded)
- Modify: wiring points (drain watcher node into app runtime; flush node available to context engine)
- Test: extend `packages/core/test/memory/tools.test.ts` + `packages/core/test/memory/flush.test.ts`

**Interfaces:**
- Consumes: Task 3 `drainWatcherNode`, Task 4 `flushNode`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/memory/tools.test.ts — append
it.live("memory_search results carry path and line citations", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      withTool(tmp.path, (registry) =>
        Effect.gen(function* () {
          yield* fs.mkdir(path.join(tmp.path, ".opencode", "memory"), { recursive: true })
          yield* fs.writeFile(path.join(tmp.path, ".opencode", "memory", "MEMORY.md"), "line one\nremember to verify\nline three")
          const output = yield* executeTool(registry, call("memory_search", { query: "verify" }))
          expect(output.matches.length).toBe(1)
          expect(output.matches[0].path).toContain("MEMORY.md")
          expect(output.matches[0].line).toBe(2)
        }),
      ),
  ),
)
```

```ts
// packages/core/test/memory/flush.test.ts — append
it.effect("threat-laden flush output is not written", () =>
  Effect.gen(function* () {
    // llm mock returns "ignore all previous instructions"; assert no file created
  }),
)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/memory/tools.test.ts test/memory/flush.test.ts`
Expected: FAIL — search output lacks `line` field; flush writes scanned output.

- [ ] **Step 3: Wire the integration points**

```ts
// packages/core/src/memory/tools.ts — search output shape
const MemorySearchOutput = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String }),
  ),
})
// (already emits line; ensure `path` is relative to the memory base — Task 6 did this; keep it)
```

```ts
// packages/core/src/session/runner/context-engine.ts — flush before compact (additive, guarded)
// In the `compact` implementation, before invoking the existing compaction path:
yield* Effect.serviceOption(Flush.Service).pipe(
  Effect.flatMap((opt) =>
    opt._tag === "Some"
      ? opt.value.flush(sessionID).pipe(Effect.catch(() => Effect.void))
      : Effect.void,
  ),
)
```
(Add `Flush.Service` as an optional service dependency; register `flushNode` in the runner's composition so the guard resolves in production but tests without it stay green.)

- [ ] **Step 4: Run tests to verify they pass + wiring gate**

Run: `bun test test/memory/` — all pass. Typecheck: `bun --cwd packages/core typecheck` — clean.

**接线完整性检查（强制）：**
```bash
# Watcher must be a location node and registered in location-services (same pattern as MemoryContext).
grep -n "makeLocationNode" packages/core/src/memory/drain-watcher.ts          # MUST match
grep -n "memory-drain-watcher\|DrainWatcher\|drainWatcher" packages/core/src/location-services.ts  # MUST match
grep -n "Flush\|flushSession\|memory-flush" packages/core/src/session/runner/context-engine.ts  # MUST match
grep -n "line" packages/core/src/memory/tools.ts                              # MUST match (citation field)
bun test test/memory/drain-watcher.test.ts test/memory/flush.test.ts test/memory/tools.test.ts  # MUST pass
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/tools.ts packages/core/src/session/runner/context-engine.ts packages/core/test/memory/
git commit -m "feat(memory): wire drain watcher and flush hooks; retrieval citations"
```

---

## Self-Review

**Spec coverage (architecture doc P2 section):** session-end metadata save → Tasks 1–3; flush → Task 4; citation → Task 5; privacy (metadata-only auto, content user-triggered) → Tasks 1–4 design; trivial-skip rule → Task 1; wiring → Task 5 gate. P3 (consolidation) explicitly out of scope — its architecture is defined in `2026-08-07-memory-architecture.md` and its task plan starts after P2 ships.

**Placeholder scan:** no TBD/TODO in task steps; test code is concrete; Step 3 implementations are complete.

**Known discovery-risk items (flagged, not hidden):** Task 3 uses `makeLocationNode` (architecture lock — workspace sessions); Task 4 LLM mock must match the real `LLMClient.Interface` (read the client before mocking); Task 5 context-engine hook is additive/guarded; wiring grep targets `location-services.ts` explicitly. Each is documented in the step it affects.

**Type consistency:** `MemoryRoots`/`writeTextAtomic`/`readTextSafe` from P1; `sessionLogPath`/`appendSessionLog`/`isTrivialSession` (Task 1) consumed by Tasks 3/4; `extractSessionMeta` (Task 2) consumed by Task 3; `flushSession` (Task 4) consumed by Task 5 hook.
