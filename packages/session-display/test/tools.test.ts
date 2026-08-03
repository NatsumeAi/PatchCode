import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { buildToolViewModel } from "../src/build"
import { DEFAULT_CONFIG } from "../src/config"
import type { DisplayContext } from "../src/registry"
import "../src/index" // register all descriptors

const ctx: DisplayContext = {
  cwd: "/home/user/project",
  width: 120,
  config: DEFAULT_CONFIG,
  formatPath: (p: string) => (p.startsWith("/home/user/project/") ? p.slice("/home/user/project/".length) : p),
}

function makePart(tool: string, state: ToolPart["state"]): ToolPart {
  return {
    id: "part_001",
    sessionID: "ses_001",
    messageID: "msg_001",
    type: "tool",
    callID: "call_001",
    tool,
    state,
  }
}

describe("§8.2 tool snapshots", () => {
  test("read completed → collapsed, body none", () => {
    const part = makePart("read", {
      status: "completed",
      input: { filePath: "/home/user/project/src/foo.ts" },
      output: "file content here",
      title: "Read src/foo.ts",
      metadata: {},
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
    expect(vm.body.kind).toBe("none")
    expect(vm.header.verb).toBe("Read")
    expect(vm.header.primary).toBe("src/foo.ts")
  })

  test("shell completed exit 0 + long output → collapsed, body none", () => {
    const part = makePart("shell", {
      status: "completed",
      input: { command: "bun test" },
      output: "",
      title: "bun test",
      metadata: { output: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11", exit: 0 },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
    expect(vm.body.kind).toBe("none")
  })

  test("shell completed exit 1 + output → truncated, body lines", () => {
    const part = makePart("shell", {
      status: "completed",
      input: { command: "bun test" },
      output: "",
      title: "bun test",
      metadata: { output: "error line 1\nerror line 2\nerror line 3", exit: 1 },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("truncated")
    expect(vm.body.kind).toBe("lines")
  })

  test("shell error → truncated", () => {
    const part = makePart("shell", {
      status: "error",
      input: { command: "bad command" },
      error: "command not found",
      metadata: { output: "some output" },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("truncated")
  })

  test("edit completed + diff → expanded, body diff", () => {
    const part = makePart("edit", {
      status: "completed",
      input: { filePath: "/home/user/project/src/bar.ts" },
      output: "",
      title: "Edit src/bar.ts",
      metadata: { diff: "--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -1 +1 @@\n-old\n+new" },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("expanded")
    expect(vm.body.kind).toBe("diff")
  })

  test("edit error → collapsed", () => {
    const part = makePart("edit", {
      status: "error",
      input: { filePath: "/home/user/project/src/bar.ts" },
      error: "oldString not found",
      metadata: {},
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
  })

  test("write completed + content → expanded", () => {
    const part = makePart("write", {
      status: "completed",
      input: { filePath: "/home/user/project/src/new.ts", content: "export const x = 1" },
      output: "",
      title: "Write src/new.ts",
      metadata: {},
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("expanded")
    expect(vm.body.kind).toBe("code")
  })

  test("patch multi file → expanded patch", () => {
    const part = makePart("apply_patch", {
      status: "completed",
      input: {},
      output: "",
      title: "Patch 2 files",
      metadata: {
        files: [
          { relativePath: "src/a.ts", filePath: "/home/user/project/src/a.ts", patch: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y", type: "edit", deletions: 1 },
          { relativePath: "src/b.ts", filePath: "/home/user/project/src/b.ts", patch: "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b", type: "edit", deletions: 1 },
        ],
      },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("expanded")
    expect(vm.body.kind).toBe("patch")
  })

  test("todowrite → collapsed, details done/total", () => {
    const part = makePart("todowrite", {
      status: "completed",
      input: { todos: [{ status: "completed", content: "task 1" }, { status: "pending", content: "task 2" }] },
      output: "",
      title: "Todos",
      metadata: { todos: [{ status: "completed", content: "task 1" }, { status: "pending", content: "task 2" }] },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
    expect(vm.header.details).toBe("1/2")
  })

  test("question answered → collapsed", () => {
    const part = makePart("question", {
      status: "completed",
      input: { questions: [{ question: "Which option?" }] },
      output: "",
      title: "Questions",
      metadata: { answers: [["Option A"]] },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
  })

  test("generic tool → collapsed", () => {
    const part = makePart("some_mcp_tool", {
      status: "completed",
      input: { query: "test" },
      output: "result",
      title: "some_mcp_tool",
      metadata: {},
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
    expect(vm.body.kind).toBe("none")
  })
})

describe("§4 content-dependence + pin + accent (audit fixtures)", () => {
  test("shell success + pin expanded → body lines (foldable reveals output)", () => {
    const part = makePart("shell", {
      status: "completed",
      input: { command: "bun test" },
      output: "",
      title: "bun test",
      metadata: { output: "line1\nline2\nline3", exit: 0 },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, "expanded")
    expect(vm.mode).toBe("expanded")
    expect(vm.body.kind).toBe("lines")
  })

  test("shell success no output + pin expanded → body none", () => {
    const part = makePart("shell", {
      status: "completed",
      input: { command: "true" },
      output: "",
      title: "true",
      metadata: { exit: 0 },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, "expanded")
    expect(vm.mode).toBe("expanded")
    expect(vm.body.kind).toBe("none")
  })

  test("shell completed exit 1 → header accent error", () => {
    const part = makePart("shell", {
      status: "completed",
      input: { command: "bun test" },
      output: "",
      title: "bun test",
      metadata: { output: "boom", exit: 1 },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("truncated")
    expect(vm.header.accent).toBe("error")
  })

  test("edit completed no diff → collapsed (no empty panel)", () => {
    const part = makePart("edit", {
      status: "completed",
      input: { filePath: "/home/user/project/src/foo.ts" },
      output: "",
      title: "Edit src/foo.ts",
      metadata: {},
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
    expect(vm.body.kind).toBe("none")
  })

  test("edit completed filediff only → expanded (web metadata shape)", () => {
    const part = makePart("edit", {
      status: "completed",
      input: { filePath: "/home/user/project/src/foo.ts" },
      output: "",
      title: "Edit src/foo.ts",
      metadata: { filediff: { file: "/home/user/project/src/foo.ts", patch: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new" } },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("expanded")
    expect(vm.body.kind).toBe("diff")
  })

  test("write completed no content → collapsed", () => {
    const part = makePart("write", {
      status: "completed",
      input: { filePath: "/home/user/project/src/new.ts" },
      output: "",
      title: "Write src/new.ts",
      metadata: {},
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
  })

  test("patch completed no files → collapsed", () => {
    const part = makePart("patch", {
      status: "completed",
      input: {},
      output: "",
      title: "Patch",
      metadata: {},
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, null)
    expect(vm.mode).toBe("collapsed")
  })

  test("read completed + pin expanded → clickable, loaded list body", () => {
    const part = makePart("read", {
      status: "completed",
      input: { filePath: "/home/user/project/src/foo.ts" },
      output: "content",
      title: "Read src/foo.ts",
      metadata: { loaded: ["/home/user/project/src/a.ts", "/home/user/project/src/b.ts"] },
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, "expanded")
    expect(vm.clickable).toBe(true)
    expect(vm.body.kind).toBe("lines")
  })

  test("userPin expanded on empty-body tool stays expanded (I4)", () => {
    const part = makePart("edit", {
      status: "completed",
      input: { filePath: "/home/user/project/src/foo.ts" },
      output: "",
      title: "Edit src/foo.ts",
      metadata: {},
      time: { start: 1000, end: 2000 },
    })
    const vm = buildToolViewModel(part, ctx, "expanded")
    expect(vm.mode).toBe("expanded")
  })
})
