import { Effect, Layer, Schema } from "effect"
import path from "path"
import { Global } from "../global"
import { Location } from "../location"
import { FSUtil } from "../fs-util"
import { makeLocationNode } from "../effect/app-node"
import { SystemContext } from "../system-context"
import { SystemContextRegistry } from "../system-context/registry"
import { resolveRoots } from "./storage"
import { loadSummaries, renderSummaryBlock } from "./summary"

export const MemoryContextKey = SystemContext.Key.make("core/memory")

// Decision framework aligned with the Codex memory read-path prompt
// (reference: codex-rs/ext/memories/templates/memories/read_path.md),
// adapted to opencode's memory layout: memory_summary.md (injected),
// MEMORY.md (searchable archive), extensions/ad_hoc/notes/ (agent write zone),
// sessions/ (session logs, written by automatic capture).
const DECISION_FRAMEWORK = `## Memory

You have access to memory notes from prior runs. Use them when likely to help; they save time and keep you consistent.

Decision boundary: should you use memory for a new user query?

- Skip memory ONLY when the request is clearly self-contained and does not need prior context, conventions, or earlier decisions.
- Hard skip examples: current time/date, simple translation, simple sentence rewrite, one-line shell command, trivial formatting.
- Use memory by default when ANY of these are true:
  - the query mentions paths, modules, or files from the summaries below,
  - the user asks for prior context / consistency / previous decisions,
  - the task is ambiguous and could depend on earlier project choices,
  - the ask is non-trivial and related to the summaries below.
- If unsure, do a quick memory pass.

Memory layout (general -> specific):

- memory_summary.md (already provided below; do NOT open it again)
- MEMORY.md (searchable curated archive; primary file to query)
- extensions/ad_hoc/notes/ (append-only agent write zone; timestamped note files)
- sessions/ (automatic session logs, metadata + content excerpts)

Quick memory pass (when applicable):

1. Skim the summaries below and extract task-relevant keywords.
2. Search MEMORY.md (and extensions/ad_hoc/notes/) using those keywords via memory_search.
3. Only if a hit points to a specific file, open the 1-2 most relevant files with memory_read.
4. If there are no relevant hits, stop memory lookup and continue normally.

Quick-pass budget:

- Keep memory lookup lightweight: ideally <= 4 steps before main work.
- Avoid broad scans of the whole memory folder.

During execution: if you hit repeated errors, confusing behavior, or suspect relevant prior context, redo the quick memory pass.

How to decide whether to verify memory:

- Consider both risk of drift and verification effort.
- If a fact is likely to drift and is cheap to verify, verify it before relying on it.
- If a fact is likely to drift but verification is expensive, slow, or disruptive, you may answer from memory, but say it is memory-derived and may be stale.

When answering from memory without current verification:

- If you rely on memory for a fact you did not verify in the current turn, say so briefly in the final answer.
- If that fact is plausibly drift-prone or comes from an older note, say it may be stale or outdated.
- Do not present unverified memory-derived facts as confirmed-current.
- Prefer a short refresh offer for interactive questions, especially about prior results, commands, or timing.

Updating memories:

- Update memories ONLY when the user explicitly asks you to remember, forget, or update something.
- Write each update as one small file under extensions/ad_hoc/notes/ via memory_add_note; never edit MEMORY.md or memory_summary.md directly (they are consolidated by a background process).`

export const memoryContextNode = makeLocationNode({
  name: "memory-context",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const location = yield* Location.Service
      const global = yield* Global.Service
      const fs = yield* FSUtil.Service

      const render = (text: string) => (text === "" ? DECISION_FRAMEWORK : `${DECISION_FRAMEWORK}\n\n${text}`)

      const summaryBlock = loadSummaries(fs, resolveRoots(path.join(global.data, "memory"), location.directory)).pipe(
        Effect.map(renderSummaryBlock),
      )

      const context = SystemContext.make({
        key: MemoryContextKey,
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.orElseSucceed(summaryBlock, () => ""),
        baseline: render,
        update: (_previous, text) => render(text),
      })

      yield* registry.register({ key: MemoryContextKey, load: Effect.succeed(context) })
    }),
  ),
  deps: [SystemContextRegistry.node, Location.node, Global.node, FSUtil.node],
})
