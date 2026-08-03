import { describe, expect, test } from "bun:test"
import type { DisplayMode, PartStatus } from "../src/mode"
import {
  classifyVerbRuns,
  eagerFoldKind,
  nounLabel,
  verbGroupHeaderLabel,
  verbLabel,
} from "../src/verb-group"

function p(id: string, tool: string, mode: DisplayMode, status: PartStatus = "completed") {
  return { id, tool, status, mode }
}

describe("eagerFoldKind", () => {
  test("read → file", () => {
    expect(eagerFoldKind("read")).toBe("file")
  })
  test("grep/glob → search", () => {
    expect(eagerFoldKind("grep")).toBe("search")
    expect(eagerFoldKind("glob")).toBe("search")
  })
  test("webfetch/websearch split", () => {
    expect(eagerFoldKind("webfetch")).toBe("webfetch")
    expect(eagerFoldKind("websearch")).toBe("websearch")
  })
  test("shell/edit are label-only (null)", () => {
    expect(eagerFoldKind("bash")).toBeNull()
    expect(eagerFoldKind("edit")).toBeNull()
    expect(eagerFoldKind("todowrite")).toBeNull()
  })
})

describe("verbLabel / nounLabel", () => {
  test("file: Read/Reading + file/files", () => {
    expect(verbLabel("file", false)).toBe("Read")
    expect(verbLabel("file", true)).toBe("Reading")
    expect(nounLabel("file", 1)).toBe("file")
    expect(nounLabel("file", 3)).toBe("files")
  })
  test("websearch noun is website/websites (verified Grok)", () => {
    expect(nounLabel("websearch", 1)).toBe("website")
    expect(nounLabel("websearch", 3)).toBe("websites")
  })
})

describe("classifyVerbRuns", () => {
  test("consecutive same-kind collapsed → one run", () => {
    const runs = classifyVerbRuns([p("a", "read", "collapsed"), p("b", "read", "collapsed"), p("c", "read", "collapsed")])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.kind).toBe("file")
    expect(runs[0]!.memberIds).toEqual(["a", "b", "c"])
  })

  test("opened member breaks the run", () => {
    const runs = classifyVerbRuns([p("a", "read", "collapsed"), p("b", "read", "expanded"), p("c", "read", "collapsed")])
    expect(runs).toHaveLength(2)
    expect(runs[0]!.memberIds).toEqual(["a"])
    expect(runs[1]!.memberIds).toEqual(["c"])
  })

  test("different kinds do not merge", () => {
    const runs = classifyVerbRuns([p("a", "read", "collapsed"), p("b", "grep", "collapsed")])
    expect(runs).toHaveLength(2)
  })

  test("non-eager tool breaks the run", () => {
    const runs = classifyVerbRuns([p("a", "read", "collapsed"), p("b", "bash", "collapsed"), p("c", "read", "collapsed")])
    expect(runs).toHaveLength(2)
  })

  test("error member breaks the run", () => {
    const runs = classifyVerbRuns([p("a", "read", "collapsed"), p("b", "read", "collapsed", "error")])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.memberIds).toEqual(["a"])
  })

  test("running member marks run running", () => {
    const runs = classifyVerbRuns([p("a", "read", "collapsed", "running"), p("b", "read", "collapsed")])
    expect(runs[0]!.running).toBe(true)
  })

  test("empty input → no runs", () => {
    expect(classifyVerbRuns([])).toEqual([])
  })
})

describe("verbGroupHeaderLabel", () => {
  test("Read 3 files", () => {
    expect(verbGroupHeaderLabel({ kind: "file", memberIds: ["a", "b", "c"], failed: false, running: false })).toBe(
      "Read 3 files",
    )
  })
  test("Reading 1 file while running", () => {
    expect(verbGroupHeaderLabel({ kind: "file", memberIds: ["a"], failed: false, running: true })).toBe(
      "Reading 1 file",
    )
  })
})
