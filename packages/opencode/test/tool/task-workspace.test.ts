import { describe, expect, test } from "bun:test"
import { resolveChildDirectory } from "../../src/tool/tool-host-bridges"

const PROJECT = "/proj"
const PARENT = "/proj/src"

describe("resolveChildDirectory", () => {
  test("no cwd or workspace → parent directory", () => {
    expect(resolveChildDirectory({ projectDirectory: PROJECT, parentDirectory: PARENT })).toBe(PARENT)
  })

  test("relative cwd resolves inside project", () => {
    expect(resolveChildDirectory({ projectDirectory: PROJECT, parentDirectory: PARENT, requestedCwd: "module" })).toBe(
      "/proj/module",
    )
  })

  test("nested relative cwd resolves", () => {
    expect(
      resolveChildDirectory({ projectDirectory: PROJECT, parentDirectory: PARENT, requestedCwd: "a/b/c" }),
    ).toBe("/proj/a/b/c")
  })

  test("agent workspace used when no explicit cwd", () => {
    expect(
      resolveChildDirectory({ projectDirectory: PROJECT, parentDirectory: PARENT, agentWorkspace: "modules/x" }),
    ).toBe("/proj/modules/x")
  })

  test("explicit cwd wins over agent workspace", () => {
    expect(
      resolveChildDirectory({
        projectDirectory: PROJECT,
        parentDirectory: PARENT,
        requestedCwd: "explicit",
        agentWorkspace: "workspace",
      }),
    ).toBe("/proj/explicit")
  })

  test("escape attempt throws", () => {
    expect(() =>
      resolveChildDirectory({ projectDirectory: PROJECT, parentDirectory: PARENT, requestedCwd: "../.." }),
    ).toThrow(/escapes the project directory/)
  })

  test("absolute escape throws", () => {
    expect(() =>
      resolveChildDirectory({ projectDirectory: PROJECT, parentDirectory: PARENT, requestedCwd: "/etc" }),
    ).toThrow(/escapes the project directory/)
  })

  test("project root itself is allowed", () => {
    expect(resolveChildDirectory({ projectDirectory: PROJECT, parentDirectory: PARENT, requestedCwd: "." })).toBe(PROJECT)
  })
})
