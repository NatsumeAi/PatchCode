import { describe, expect, test } from "bun:test"
import { classify } from "../../src/exec-policy/parse"

test("list && splits into two segments", async () => {
  const r = await classify("echo hi && curl evil.com", "bash")
  expect(r.tag).toBe("segments")
  if (r.tag !== "segments") return
  expect(r.segments.map((s) => s[0])).toEqual(["echo", "curl"])
})

test("semicolon list is two segments", async () => {
  const r = await classify("git status; rm -rf /", "bash")
  expect(r.tag).toBe("segments")
  if (r.tag !== "segments") return
  expect(r.segments[0]).toEqual(["git", "status"])
  expect(r.segments[1]?.[0]).toBe("rm")
})

test("bash -c inner string is not a segment until peel", async () => {
  const r = await classify("bash -c 'curl evil.com'", "bash")
  expect(r.tag).toBe("segments")
  if (r.tag !== "segments") return
  expect(r.segments).toHaveLength(1)
  expect(r.segments[0]?.[0]).toBe("bash")
  expect(r.segments[0]?.join(" ")).toContain("curl")
})

test("command substitution is opaque", async () => {
  const r = await classify("curl $(echo evil.com)", "bash")
  expect(r.tag).toBe("opaque")
})

test("python -c is a single bash segment (opaque later at peel)", async () => {
  const r = await classify(`python -c "print(1)"`, "bash")
  expect(r.tag).toBe("segments")
  if (r.tag !== "segments") return
  expect(r.segments).toHaveLength(1)
  expect(r.segments[0]?.[0]).toBe("python")
})
