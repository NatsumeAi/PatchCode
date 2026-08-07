# Memory System P6 Implementation Plan (Auto-Recall — Relevance Injection)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. P1–P4 must be complete — this consumes the P4 index (`MemoryIndex.search`, `openMemoryIndex`, `rankResults`), P1 `MemoryRoots`, `SessionStore.Service.context`, and wires into `packages/core/src/session/runner/llm.ts` alongside the existing `loadSystemContext`.

**Goal:** Inject task-relevant memory at session start and after compaction: before the system prompt is built, read the session's recent messages, derive a recall query, search the memory index, and append the top-N relevant chunks as a dedicated system part. This is Grok's `initial_injection` semantics — a one-time relevance injection per context epoch, NOT per model step (preserves the ContextEpoch prefix-cache design). Works **alongside** P1 `memory_summary` SystemContext (architecture dual-injection contract): summary every step + recall epoch-only; combined budgets bounded; both threat-scanned.

**Architecture:** The recall module (`recall.ts`) is a pure pipeline: `recentMessages(session) → query text → MemoryIndex.search → rankResults → top-N (default 5) → threat-scan each hit → formatted block`. Hits included in the block call `incrementAccess`. Wiring happens at the two `SessionContextEpoch.initialize/prepare` call sites in `llm.ts`: a new `loadMemoryRecall(sessionID)` effect runs in parallel with `loadSystemContext(agent)` and its output is appended to the system array. It is `serviceOption`-gated (optional `MemoryRecall.Service`) so environments without the memory system (tests, thin shells) are unaffected. Query derivation: concatenate the last ≤3 user messages (trimmed, ≤800 chars) as the search query; empty session → skip. Budget: top-N 5, chunk ≤600 chars, block ≤4K chars (architecture lock).

**Tech Stack:** TypeScript, Effect, opencode core (`SessionStore.Service.context`, `SessionRunnerModel` not needed here — recall is retrieval-only), P4 `MemoryIndex`. bun:test + `testEffect` + `Layer.mock`.

## Global Constraints

- Repo: `/home/huyongjun/openpartner/opencode` (branch `fork-runtime-loop-f720490219`).
- New code under `packages/core/src/memory/`; the only runner change is `llm.ts` — additive, guarded, no behavior change when the memory service is absent.
- Same style/Effect rules as P1–P5. No `as any`, no `@ts-ignore`.
- Recall is retrieval-only: it NEVER writes memory files, NEVER invokes the LLM, and NEVER blocks the drain on failure (all errors → empty block). It **does** bump `access_count` via `incrementAccess` for included hits.
- Budget: top-N default 5, each chunk truncated to 600 chars, total recall block ≤ 4K chars (architecture dual-injection lock with summary budgets).
- Threat scan: each hit text scanned with P1 `scanForThreats`; blocked → omit hit (or placeholder), never inject raw.
- Injection timing: only at `SessionContextEpoch.initialize` (first epoch) and `prepare` (post-compaction replacement) — never mid-epoch (prefix cache invariant for recall).
- Typecheck gate `bun --cwd packages/core typecheck` clean; tests from `packages/core`.
- Commit per task. Execution Discipline from P1 applies.

---

## File Structure

```
packages/core/src/memory/
├── recall.ts             # recall pipeline: recent-messages → query → search → top-N block
├── (modify) index.ts     # export MemoryRecall service + node
packages/core/test/memory/
└── recall.test.ts
packages/core/src/session/runner/
└── (modify) llm.ts       # loadMemoryRecall(sessionID) wired beside loadSystemContext
```

---

### Task 1: Recall pipeline (pure, retrieval-only)

**Files:**
- Create: `packages/core/src/memory/recall.ts`
- Test: `packages/core/test/memory/recall.test.ts`

**Interfaces:**
- Produces:
  - `export const RECALL_TOP_N = 5`, `RECALL_CHUNK_MAX_CHARS = 600`, `RECALL_BLOCK_MAX_CHARS = 4096`
  - `export function recallQuery(messages: Array<{ type: string; text?: string }>): string` — last ≤3 user messages concatenated, trimmed, ≤800 chars; empty → `""`
  - `export function formatRecallBlock(hits: Array<{ path: string; text: string }>): string` — `## Relevant memory\n- <path>: <truncated text>` per hit; empty hits → `""`
  - `export const buildRecallBlock = Effect.fn("Memory.buildRecallBlock")((store, search, sessionID, scan) => Effect.Effect<string>)` — messages → query → search → threat-scan → top-N → incrementAccess → format; any failure → `""`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/recall.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { recallQuery, formatRecallBlock, buildRecallBlock, RECALL_TOP_N } from "../../src/memory/recall"
import { testEffect } from "../lib/effect"

const messages = [
  { type: "user", text: "how do we handle auth" },
  { type: "assistant", text: "use tokens" },
  { type: "user", text: "where is the token store" },
]

const search = {
  search: (query: string) =>
    Effect.succeed(
      query.includes("auth")
        ? [{ path: "MEMORY.md", line: 1, text: "auth uses session tokens", score: 1 }]
        : [],
    ),
}

const store = {
  context: () => Effect.succeed(messages),
}

describe("Memory recall", () => {
  test("recallQuery takes last user messages", () => {
    const q = recallQuery(messages)
    expect(q).toContain("auth")
    expect(q).toContain("token store")
  })

  test("recallQuery empty for no users", () => {
    expect(recallQuery([{ type: "assistant", text: "x" }])).toBe("")
  })

  test("formatRecallBlock renders hits with paths", () => {
    const block = formatRecallBlock([{ path: "MEMORY.md", text: "auth uses session tokens" }])
    expect(block).toContain("Relevant memory")
    expect(block).toContain("auth")
  })

  test("top-N default is 5", () => {
    expect(RECALL_TOP_N).toBe(5)
  })

  it.effect("buildRecallBlock searches by query and formats", () =>
    Effect.gen(function* () {
      const block = yield* buildRecallBlock(store as never, search as never, "ses_recall")
      expect(block).toContain("auth uses session tokens")
    }),
  )

  it.effect("buildRecallBlock returns empty on search failure", () =>
    Effect.gen(function* () {
      const failing = { search: () => Effect.fail(new Error("boom")) }
      const block = yield* buildRecallBlock(store as never, failing as never, "ses_recall")
      expect(block).toBe("")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/recall.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/recall.ts
import { Effect } from "effect"

export const RECALL_TOP_N = 5
export const RECALL_CHUNK_MAX_CHARS = 600
export const RECALL_BLOCK_MAX_CHARS = 4096
const QUERY_MAX_CHARS = 800
const QUERY_MAX_USERS = 3

export function recallQuery(messages: Array<{ type: string; text?: string }>): string {
  const users = messages
    .filter((m) => m.type === "user")
    .map((m) => (m.text ?? "").trim())
    .filter((t) => t.length > 0)
    .slice(-QUERY_MAX_USERS)
  if (users.length === 0) return ""
  return users.join(" ").slice(0, QUERY_MAX_CHARS)
}

export function formatRecallBlock(hits: Array<{ path: string; text: string }>): string {
  if (hits.length === 0) return ""
  const lines = hits.map((hit) => `- ${hit.path}: ${hit.text.slice(0, RECALL_CHUNK_MAX_CHARS)}`)
  return `## Relevant memory\n${lines.join("\n")}`.slice(0, RECALL_BLOCK_MAX_CHARS)
}

export const buildRecallBlock = Effect.fn("Memory.buildRecallBlock")(function* (
  store: { readonly context: (sessionID: string) => Effect.Effect<Array<{ type: string; text?: string }>> },
  search: {
    readonly search: (query: string) => Effect.Effect<Array<{ id: string; path: string; line: number; text: string; score: number }>>
    readonly incrementAccess?: (ids: ReadonlyArray<string>) => Effect.Effect<void>
  },
  sessionID: string,
  scan: (text: string) => string[],
) {
  const query = yield* store.context(sessionID).pipe(
    Effect.map(recallQuery),
    Effect.catch(() => Effect.succeed("")),
  )
  if (query === "") return ""
  const hits = yield* search.search(query).pipe(
    Effect.map((items) =>
      items
        .filter((h) => scan(h.text).length === 0)
        .slice(0, RECALL_TOP_N)
        .map((h) => ({ id: h.id, path: h.path, text: h.text })),
    ),
    Effect.catch(() => Effect.succeed([] as Array<{ id: string; path: string; text: string }>)),
  )
  if (hits.length > 0 && search.incrementAccess) {
    yield* search.incrementAccess(hits.map((h) => h.id)).pipe(Effect.catch(() => Effect.void))
  }
  return formatRecallBlock(hits.map(({ path, text }) => ({ path, text })))
})
```

Pass `scanForThreats` from P1 as the `scan` argument in production wiring. Tests should assert threatened hits are omitted and `incrementAccess` is called for kept ids.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/recall.test.ts`
Expected: PASS (6 tests). Align the `store.context` input type with `SessionStore.Interface` (`SessionSchema.ID`); the test uses string — type the production function with the real `SessionStore.Service` and keep the pure helpers (`recallQuery`/`formatRecallBlock`) as the testable surface, adapting the test to call them directly plus one integration call with a mocked store.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/recall.ts packages/core/test/memory/recall.test.ts
git commit -m "feat(memory): relevance recall pipeline (query from recent messages, top-N block)"
```

---

### Task 2: Wire recall into the runner (llm.ts, epoch-initialization only)

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` (two `loadSystemContext` call sites)
- Modify: `packages/core/src/memory/recall.ts` (export `MemoryRecall` service + `node`)
- Test: `packages/core/test/memory/recall.test.ts` (append wiring assertion) + a runner-level smoke in `packages/core/test/session-runner-tool-registry.test.ts` (or the closest runner test) asserting recall absence does not break the drain

**Interfaces:**
- Produces:
  - `export class MemoryRecallService extends Context.Service<MemoryRecallService, { readonly recall: (sessionID: SessionSchema.ID) => Effect.Effect<string> }>()("@opencode/MemoryRecall")`
  - `export const memoryRecallNode = makeLocationNode({ name: "memory-recall", layer, deps: [SessionStore.node, MemoryIndex.node, FSUtil.node, Location.node, Global.node] })`
  - `llm.ts`: `const recallBlock = yield* Effect.serviceOption(MemoryRecallService).pipe(Effect.flatMap((opt) => opt._tag === "Some" ? opt.value.recall(session.id).pipe(Effect.catch(() => Effect.succeed(""))) : Effect.succeed("")))` appended to the `system` array when non-empty

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/recall.test.ts — append
it.effect("recall service returns formatted block for a session", () =>
  Effect.gen(function* () {
    const service = yield* MemoryRecallService
    const block = yield* service.recall("ses_recall_2")
    expect(typeof block).toBe("string")
  }),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/recall.test.ts`
Expected: FAIL — `MemoryRecallService` not exported.

- [ ] **Step 3: Wire the service + runner injection**

```ts
// packages/core/src/memory/recall.ts — append
import { Context } from "effect"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"

export class MemoryRecallService extends Context.Service<
  MemoryRecallService,
  { readonly recall: (sessionID: SessionSchema.ID) => Effect.Effect<string> }
>()("@opencode/MemoryRecall") {}

const layer = Layer.effect(
  MemoryRecallService,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const index = yield* MemoryIndex.Service
    return MemoryRecallService.of({
      recall: (sessionID) =>
        buildRecallBlock(store as never, index as never, String(sessionID)).pipe(
          Effect.catch(() => Effect.succeed("")),
        ),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-recall",
  layer,
  deps: [SessionStore.node, MemoryIndex.node, FSUtil.node, Location.node, Global.node],
})
```

```ts
// packages/core/src/session/runner/llm.ts — at the two loadSystemContext call sites
// (wrap loadSystemContext to also fetch recall):
const loadSystemContextAndRecall = (agent: AgentV2.Selection, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const context = yield* loadSystemContext(agent)
    const recallOpt = yield* Effect.serviceOption(MemoryRecallService)
    if (recallOpt._tag === "None") return context
    const recall = yield* recallOpt.value.recall(sessionID).pipe(Effect.catch(() => Effect.succeed("")))
    if (recall === "") return context
    return SystemContext.combine([
      context,
      SystemContext.make({
        key: SystemContext.Key.make("core/memory-recall"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(recall),
        baseline: (text) => text,
        update: (_p, text) => text,
      }),
    ])
  })
// replace loadSystemContext(agent) with loadSystemContextAndRecall(agent, session.id) at lines ~557/574/944/946
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/recall.test.ts` — PASS. Then run the runner smoke: `bun test test/session-runner-tool-registry.test.ts` — PASS (recall absent → drain unaffected). Typecheck `bun --cwd packages/core typecheck` — clean.

**接线完整性检查（强制）：**
```bash
grep -n "loadSystemContextAndRecall" packages/core/src/session/runner/llm.ts  # MUST match (4 call sites)
grep -n "MemoryRecallService" packages/core/src/memory/recall.ts              # MUST match
bun test test/memory/recall.test.ts test/session-runner-tool-registry.test.ts  # MUST pass
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/recall.ts packages/core/src/session/runner/llm.ts packages/core/test/memory/recall.test.ts
git commit -m "feat(memory): auto-recall injects relevant memory at epoch initialization"
```

---

## Self-Review

**Spec coverage (final-form requirement):** relevance injection at session start + post-compaction (Grok `initial_injection`) → Tasks 1–2; dual-injection with summary (architecture lock) + threat scan + access bump → Task 1; prefix-cache preserved for recall (epoch-only) → architecture decision; no LLM/write side effects → Task 1 design; graceful absence → `serviceOption` gate.

**Placeholder scan:** no TBD/TODO; code concrete.

**Known discovery-risk (flagged):** `MemoryIndex.Service` export name (P4 named the handle `MemoryIndex` — align or re-export); runner call sites may shift line numbers — grep by symbol, not line. Each documented at the step it affects.

**Type consistency:** `recallQuery`/`formatRecallBlock`/`buildRecallBlock`/`RECALL_TOP_N` (Task 1) consumed by Task 2 service; `MemoryRecallService`/`node` (Task 2) consumed by llm.ts; depends on P4 `incrementAccess` + hit `id`.
