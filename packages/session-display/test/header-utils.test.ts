import { describe, expect, test } from "bun:test"
import { shortenPath, truncateText, formatDuration, filename } from "../src/header-utils"

describe("shortenPath", () => {
  test("strips cwd prefix", () => {
    expect(shortenPath("/home/user/project/src/index.ts", "/home/user/project")).toBe("src/index.ts")
  })

  test("returns full path when not under cwd", () => {
    expect(shortenPath("/other/file.ts", "/home/user/project")).toBe("/other/file.ts")
  })

  test("returns full path when cwd is root", () => {
    expect(shortenPath("/src/index.ts", "/")).toBe("/src/index.ts")
  })

  test("returns full path when cwd is empty", () => {
    expect(shortenPath("/src/index.ts", "")).toBe("/src/index.ts")
  })

  test("handles cwd with trailing slash", () => {
    expect(shortenPath("/home/user/project/src/index.ts", "/home/user/project/")).toBe("src/index.ts")
  })
})

describe("truncateText", () => {
  test("returns text unchanged when under max", () => {
    expect(truncateText("hello", 10)).toBe("hello")
  })

  test("truncates with ellipsis when over max", () => {
    expect(truncateText("hello world", 6)).toBe("hello\u2026")
  })

  test("handles exact length", () => {
    expect(truncateText("hello", 5)).toBe("hello")
  })
})

describe("formatDuration", () => {
  test("formats sub-minute as seconds", () => {
    expect(formatDuration(2100)).toBe("2.1s")
  })

  test("formats multi-minute", () => {
    expect(formatDuration(90000)).toBe("1m30s")
  })
})

describe("filename", () => {
  test("extracts filename from path", () => {
    expect(filename("/home/user/project/src/index.ts")).toBe("index.ts")
  })

  test("returns input when no slash", () => {
    expect(filename("index.ts")).toBe("index.ts")
  })
})
