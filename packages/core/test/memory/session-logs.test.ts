import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots, readTextSafe } from "../../src/memory/storage"
import { appendSessionLog, sessionLogPath, isTrivialSession, sanitizeSessionId } from "../../src/memory/session-logs"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Session logs", () => {
  test("dated filename uses YYYY-MM-DD and full sanitized session id", () => {
    const roots = resolveRoots("/base/mem", "/proj")
    const p = sessionLogPath(roots, "ses_abcdef1234567890", new Date("2026-08-07T12:00:00Z"))
    expect(p).toContain("sessions")
    expect(path.basename(p)).toBe("2026-08-07-ses_abcdef1234567890.md")
  })

  test("sanitizeSessionId replaces unsafe characters", () => {
    expect(sanitizeSessionId("ses_abc/def:ghi")).toBe("ses_abc_def_ghi")
    expect(sanitizeSessionId("ses_plain-id_1")).toBe("ses_plain-id_1")
  })

  test("distinct session ids that share a last-8 suffix get distinct files", () => {
    const roots = resolveRoots("/base/mem", undefined)
    const when = new Date("2026-08-07T12:00:00Z")
    const a = sessionLogPath(roots, "ses_aaaaaaaa12345678", when)
    const b = sessionLogPath(roots, "ses_bbbbbbbb12345678", when)
    expect(path.basename(a)).toBe("2026-08-07-ses_aaaaaaaa12345678.md")
    expect(path.basename(b)).toBe("2026-08-07-ses_bbbbbbbb12345678.md")
    expect(a).not.toBe(b)
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
          const ok = yield* appendSessionLog(
            fs,
            roots,
            "ses_abcdef1234567890",
            new Date("2026-08-07T12:00:00Z"),
            "# Session\nmeta",
          )
          expect(ok).toBe(true)
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
          expect(yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", when, "first")).toBe(true)
          expect(yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", when, "second")).toBe(true)
          const text = yield* readTextSafe(fs, sessionLogPath(roots, "ses_abcdef1234567890", when))
          expect(text).toContain("first")
          expect(text).toContain("second")
        }),
      ),
    ),
  )

  it.effect("two different session ids write two separate files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const when = new Date("2026-08-07T12:00:00Z")
          const idA = "ses_aaaaaaaa12345678"
          const idB = "ses_bbbbbbbb12345678"
          expect(yield* appendSessionLog(fs, roots, idA, when, "alpha")).toBe(true)
          expect(yield* appendSessionLog(fs, roots, idB, when, "beta")).toBe(true)
          const textA = yield* readTextSafe(fs, sessionLogPath(roots, idA, when))
          const textB = yield* readTextSafe(fs, sessionLogPath(roots, idB, when))
          expect(textA).toBe("alpha")
          expect(textB).toBe("beta")
          const entries = yield* fs.readDirectoryEntries(path.join(roots.globalDir, "sessions"))
          const names = entries.filter((e) => e.type === "file" && e.name.endsWith(".md")).map((e) => e.name).sort()
          expect(names).toEqual([
            "2026-08-07-ses_aaaaaaaa12345678.md",
            "2026-08-07-ses_bbbbbbbb12345678.md",
          ])
        }),
      ),
    ),
  )

  it.effect("appendSessionLog returns false when atomic write cannot complete", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const when = new Date("2026-08-07T12:00:00Z")
          const file = sessionLogPath(roots, "ses_abcdef1234567890", when)
          // Block the target path with a directory so rename fails.
          yield* fs.makeDirectory(file, { recursive: true })
          const ok = yield* appendSessionLog(fs, roots, "ses_abcdef1234567890", when, "should-fail")
          expect(ok).toBe(false)
        }),
      ),
    ),
  )
})
