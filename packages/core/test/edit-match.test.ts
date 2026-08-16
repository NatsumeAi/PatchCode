import { describe, expect, test } from "bun:test"
import { replace, isDisproportionateMatch } from "../src/tool/edit-match"

test("exact still wins", () => {
  expect(replace("a b a", "b", "c")).toBe("a c a")
})

test("indent-only mismatch matches the file indent", () => {
  const file = "function f() {\n    return 1\n}\n"
  const old = "function f() {\n  return 1\n}"
  expect(replace(file, old, "function f() {\n    return 2\n}")).toBe("function f() {\n    return 2\n}\n")
})

test("two exact hits without replaceAll throw", () => {
  expect(() => replace("aa x aa", "aa", "bb")).toThrow(/multiple/i)
})

test("replaceAll replaces the matched search", () => {
  expect(replace("aa x aa", "aa", "bb", true)).toBe("bb x bb")
})

test("empty oldString throws", () => {
  expect(() => replace("x", "", "y")).toThrow(/empty/i)
})

test("identical old/new throws", () => {
  expect(() => replace("x", "x", "x")).toThrow(/identical/i)
})

test("block-anchor accepts first/last anchors with middle token drift", () => {
  const file = [
    "function process() {",
    "  const value = 100",
    "  const multiplier = 2",
    "  const result = value * multiplier",
    "  return result",
    "}",
  ].join("\n")
  const old = [
    "function process() {",
    "  const value = 100",
    "  const mult = 2",
    "  const result = value * mult",
    "  return result",
    "}",
  ].join("\n")
  const next = [
    "function process() {",
    "  const value = 200",
    "  const multiplier = 2",
    "  const result = value * multiplier",
    "  return result",
    "}",
  ].join("\n")

  expect(replace(file, old, next)).toBe(next)
})

test("two-line snippet does not rewrite a distant function", () => {
  const file = [
    "function near() {",
    "  return 1",
    "}",
    "",
    "function distant() {",
    "  doWork()",
    "  return 2",
    "}",
  ].join("\n")
  const old = ["function distant() {", "  return 2"].join("\n")

  expect(() => replace(file, old, ["function distant() {", "  return 9"].join("\n"))).toThrow(
    /Could not find oldString/i,
  )
})

test("disproportionate fuzzy spans are refused", () => {
  expect(isDisproportionateMatch("a\nb\nc\nd\ne\nf", "a\nb")).toBe(true)
  expect(isDisproportionateMatch("short", "short")).toBe(false)
  expect(isDisproportionateMatch("x".repeat(600), "abc\ndef")).toBe(true)
})
