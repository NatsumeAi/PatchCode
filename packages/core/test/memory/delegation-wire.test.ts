import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { listCandidates, readCandidate } from "../../src/memory/candidates"
import { recordDelegationIfWired } from "../../src/memory/delegation-wire"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

const DELEGATION_ENV = "OPENCODE_MEMORY_DELEGATION"

/** Runs `body` with the env var set, restoring the prior value afterwards. */
const withDelegationEnv = <A, E2, R2>(
  value: string | undefined,
  body: () => Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E2, R2> => {
  const prior = process.env[DELEGATION_ENV]
  if (value === undefined) delete process.env[DELEGATION_ENV]
  else process.env[DELEGATION_ENV] = value
  return Effect.ensuring(
    body(),
    Effect.sync(() => {
      if (prior === undefined) delete process.env[DELEGATION_ENV]
      else process.env[DELEGATION_ENV] = prior
    }),
  )
}

const withTmpRoots = <A, E2>(
  body: (fs: FSUtil.Interface, roots: ReturnType<typeof resolveRoots>) => Effect.Effect<A, E2>,
) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
  ).pipe(
    Effect.flatMap((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
        return yield* body(fs, roots)
      }),
    ),
  )

const observation = {
  parentSessionID: "ses_parent_1",
  childSessionID: "ses_child_1",
  task: "Refactor the parser",
  result: "Done: split tokenizer from parser.",
  ok: true,
}

describe("Memory delegation wiring", () => {
  it.effect("skips entirely when OPENCODE_MEMORY_DELEGATION=0", () =>
    withDelegationEnv("0", () =>
      withTmpRoots((fs, roots) =>
        Effect.gen(function* () {
          yield* recordDelegationIfWired(fs, roots, observation)
          const list = yield* listCandidates(fs, roots, 0)
          expect(list.length).toBe(0)
        }),
      ),
    ),
  )

  it.effect("writes a delegation candidate when enabled", () =>
    withDelegationEnv("1", () =>
      withTmpRoots((fs, roots) =>
        Effect.gen(function* () {
          yield* recordDelegationIfWired(fs, roots, observation)
          const list = yield* listCandidates(fs, roots, 0)
          expect(list.length).toBe(1)
          expect(list[0]!.id).toMatch(/^deleg-ses_child_1-[a-f0-9]{8}$/)
          const text = yield* readCandidate(fs, roots, list[0]!.id)
          expect(text).toContain("Refactor the parser")
          expect(text).toContain("Done: split tokenizer from parser.")
        }),
      ),
    ),
  )

  it.effect("skips silently when the result text is empty", () =>
    withDelegationEnv("1", () =>
      withTmpRoots((fs, roots) =>
        Effect.gen(function* () {
          yield* recordDelegationIfWired(fs, roots, { ...observation, result: "   " })
          const list = yield* listCandidates(fs, roots, 0)
          expect(list.length).toBe(0)
        }),
      ),
    ),
  )
})
