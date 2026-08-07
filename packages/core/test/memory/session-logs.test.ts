import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots, readTextSafe } from "../../src/memory/storage"
import { appendSessionLog, sessionLogPath, isTrivialSession } from "../../src/memory/session-logs"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Session logs", () => {
  test("dated filename uses YYYY-MM-DD and sid8", () => {
    const roots = resolveRoots("/base/mem", "/proj")
    const p = sessionLogPath(roots, "ses_abcdef1234567890", new Date("2026-08-07T12:00:00Z"))
    expect(p).toContain("sessions")
    expect(path.basename(p)).toBe("2026-08-07-34567890.md")
  })

  test("trivial session rule", () => {
    expect(isTrivialSession({ userPromptCount: 2, userTextBytes: 200 })).toBe(true)
    expect(isTrivialSession({ userPromptCount: 3, userTextBytes: 200 })).toBe(false)
    expect(isTrivialSession({ userPromptCount: 5, userTextBytes: 40 })).toBe(true)
  })

  it.effect("appendSessionLog creates file on first write", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", new Date("2026-08-07T12:00:00Z"), "# Session\nmeta")
          const text = yield* readTextSafe(
            fs,
            sessionLogPath(roots, "ses_abcdef1234567890", new Date("2026-08-07T12:00:00Z")),
          )
          expect(text).toContain("# Session")
        }),
      ),
    ),
  )

  it.effect("appendSessionLog appends on second write", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const when = new Date("2026-08-07T12:00:00Z")
          yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", when, "first")
          yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", when, "second")
          const text = yield* readTextSafe(fs, sessionLogPath(roots, "ses_abcdef1234567890", when))
          expect(text).toContain("first")
          expect(text).toContain("second")
        }),
      ),
    ),
  )
})
