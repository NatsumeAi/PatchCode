/**
 * FULL acceptance gate (Wave G / §0.1): end-to-end product journey.
 *
 * Forbidden: planting candidates via writeCandidate. Inputs must come from the
 * production write path (notes + session logs).
 */
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Stream } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LLMClient, LLMEvent, Model } from "@opencode-ai/llm"
import { routes as openAICompatibleRoutes } from "@opencode-ai/llm/providers/openai-compatible"
import { runConsolidation, runDualRootConsolidation } from "../../src/memory/consolidate"
import { writeMemoryNote } from "../../src/memory/tools"
import { readTextSafe, resolveRoots, writeTextAtomic } from "../../src/memory/storage"
import { loadSummaries, renderSummaryBlock } from "../../src/memory/summary"
import { openMemoryIndex, ensureIndexed } from "../../src/memory/reindex"
import { buildRecallBlock } from "../../src/memory/recall"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const DECISION = "Decision: use Effect layers for memory consolidation."
const SESSION_BODY =
  "## Session summary\nSettled on dual-root consolidation with notes and session logs as direct merge sources.\n" +
  "Also confirmed Effect layers own the memory write path."

const MEMORY_BODY = `## Memory Archive

## Decisions
- ${DECISION}

## Technical context
- Dual-root notes + sessions merge into curated MEMORY.md
- Hash ledger (merged.hashes) provides idempotency beyond LLM markers
`

const SUMMARY_BODY = `## Workspace summary
- ${DECISION}
- Dual-root consolidation consumes notes and sessions directly
`

const model = Model.make({ id: "memory-journey", provider: "test", route: openAICompatibleRoutes[0]! })

/** Mock LLM: dream merge first, then summary regen (same run). Later runs get NO_REPLY if called. */
let llmCall = 0
const llm = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    stream: () => {
      llmCall += 1
      // Odd calls ≈ dream merge; even ≈ summary regen after a successful merge.
      if (llmCall === 1) {
        return Stream.fromIterable([LLMEvent.textDelta({ id: "dream", text: MEMORY_BODY })])
      }
      if (llmCall === 2) {
        return Stream.fromIterable([LLMEvent.textDelta({ id: "summary", text: SUMMARY_BODY })])
      }
      return Stream.fromIterable([LLMEvent.textDelta({ id: "noop", text: "NO_REPLY" })])
    },
    prepare: () => Effect.die("unused"),
    generate: () => Effect.die("unused"),
  }),
)

const it = testEffect(Layer.mergeAll(LayerNode.compile(FSUtil.node), llm))

describe("Memory FULL journey (e2e)", () => {
  it.effect(
    "note + session → consolidate → MEMORY/summary/injection/search; second run does not wipe",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            llmCall = 0
            const fs = yield* FSUtil.Service
            const globalDir = path.join(dir.path, "global-mem")
            const projectDir = path.join(dir.path, "proj")
            const roots = resolveRoots(globalDir, projectDir)
            expect(roots.workspaceDir).toBeDefined()

            // 1. Empty roots (ensure dirs exist; no prior MEMORY/notes/sessions).
            yield* fs.ensureDir(roots.globalDir)
            yield* fs.ensureDir(roots.workspaceDir!)
            const emptyMem = yield* readTextSafe(fs, path.join(roots.workspaceDir!, "MEMORY.md"))
            expect(emptyMem).toBeUndefined()

            // 2. Production note write path (NOT writeCandidate).
            const written = yield* writeMemoryNote(fs, roots, DECISION)
            expect(written.filename.endsWith(".md")).toBe(true)
            const notesDir = path.join(roots.workspaceDir!, "extensions", "ad_hoc", "notes")
            const notesBefore = yield* fs.readDirectoryEntries(notesDir)
            expect(notesBefore.some((e) => e.name === written.filename)).toBe(true)

            // 3. Durable session log under sessions/ (production layout; no planted candidates).
            const sessionName = "2026-08-10-ses_journey_e2e.md"
            const sessionsDir = path.join(roots.workspaceDir!, "sessions")
            yield* fs.ensureDir(sessionsDir)
            const sessionOk = yield* writeTextAtomic(fs, path.join(sessionsDir, sessionName), SESSION_BODY)
            expect(sessionOk).toBe(true)

            // 4. First consolidation with mock LLM that returns MEMORY including the decision.
            const llmSvc = yield* LLMClient.Service
            yield* runDualRootConsolidation({
              fs,
              globalDir,
              projectDirectory: projectDir,
              llm: llmSvc,
              model,
            })

            // 5a. MEMORY.md contains the decision (workspace owning root for notes/sessions).
            const mem = yield* readTextSafe(fs, path.join(roots.workspaceDir!, "MEMORY.md"))
            expect(mem).toBeDefined()
            expect(mem!).toContain(DECISION)

            // 5b. Budget-included note + session are gone.
            const notesAfter = yield* fs.readDirectoryEntries(notesDir).pipe(Effect.catch(() => Effect.succeed([])))
            expect(notesAfter.filter((e) => e.type === "file" && e.name.endsWith(".md")).length).toBe(0)
            const sessionsAfter = yield* fs
              .readDirectoryEntries(sessionsDir)
              .pipe(Effect.catch(() => Effect.succeed([])))
            expect(sessionsAfter.filter((e) => e.type === "file" && e.name.endsWith(".md")).length).toBe(0)

            // 5c. memory_summary.md non-empty after mock summary regen.
            const summaryPath = path.join(roots.workspaceDir!, "memory_summary.md")
            const summaryRaw = yield* readTextSafe(fs, summaryPath)
            expect(summaryRaw).toBeDefined()
            expect(summaryRaw!.trim().length).toBeGreaterThan(0)
            expect(summaryRaw!).toContain("Effect layers")

            // 5d. loadSummaries + renderSummaryBlock non-empty.
            const loaded = yield* loadSummaries(fs, roots)
            expect(loaded.workspace.trim().length).toBeGreaterThan(0)
            const block = renderSummaryBlock(loaded)
            expect(block).toContain("workspace-memory")
            expect(block.trim().length).toBeGreaterThan(0)

            // 5e. ensureIndexed + search / buildRecallBlock can find the decision.
            const index = yield* openMemoryIndex(fs, roots)
            yield* ensureIndexed(index, fs, roots)
            const hits = yield* index.search("Effect OR layers OR consolidation", 10)
            yield* index.close()
            expect(hits.some((h) => h.text.includes("Effect layers") || h.path.includes("MEMORY"))).toBe(true)

            const store = Layer.succeed(
              SessionStore.Service,
              SessionStore.Service.of({
                context: () =>
                  Effect.succeed([
                    SessionMessage.User.make({
                      id: SessionMessage.ID.make("msg_journey_1"),
                      type: "user",
                      text: "remind me about Effect layers for memory consolidation",
                      time: { created: DateTime.makeUnsafe(0) },
                    }),
                  ]),
                get: () => Effect.die("unused"),
                sessionPermission: () => Effect.die("unused"),
                runnerContext: () => Effect.die("unused"),
                message: () => Effect.die("unused"),
                wait: () => Effect.die("unused"),
              }),
            )
            const recall = yield* Effect.gen(function* () {
              const storeSvc = yield* SessionStore.Service
              return yield* buildRecallBlock(storeSvc, fs, roots, SessionSchema.ID.make("ses_journey"))
            }).pipe(Effect.provide(store))
            expect(recall.length).toBeGreaterThan(0)
            expect(recall.toLowerCase()).toContain("effect")

            // 6. Second consolidation with no new sources → no wipe of MEMORY.md.
            // Clear min_hours gate so we exercise the no-sources path (not too-soon skip).
            yield* fs.remove(path.join(roots.workspaceDir!, "consolidation.last")).pipe(
              Effect.catch(() => Effect.void),
            )
            yield* fs.remove(path.join(roots.globalDir, "consolidation.last")).pipe(Effect.catch(() => Effect.void))
            yield* runConsolidation({ fs, roots, llm: llmSvc, model })
            const memAfter = yield* readTextSafe(fs, path.join(roots.workspaceDir!, "MEMORY.md"))
            expect(memAfter).toBeDefined()
            expect(memAfter!).toContain(DECISION)
            // Summary must also survive (not wiped to empty).
            const summaryAfter = yield* readTextSafe(fs, summaryPath)
            expect(summaryAfter).toBeDefined()
            expect(summaryAfter!.trim().length).toBeGreaterThan(0)
          }),
        ),
      ),
    60_000,
  )
})
