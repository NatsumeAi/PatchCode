import { describe, expect, test } from "bun:test"
import { loadBuiltin } from "../../src/exec-policy/load"
import { decide, decideAsync } from "../../src/exec-policy/decide"

const policy = await loadBuiltin()

test("git status allow", () => {
  expect(decide(policy, { tag: "segments", segments: [["git", "status"]] }).effect).toBe("allow")
})

test("rm -rf / deny", () => {
  expect(decide(policy, { tag: "segments", segments: [["rm", "-rf", "/"]] }).effect).toBe("deny")
})

test("echo && curl is ask because curl has no allow", () => {
  const r = decide(policy, {
    tag: "segments",
    segments: [
      ["echo", "hi"],
      ["curl", "https://example.com"],
    ],
  })
  expect(r.effect).toBe("ask")
})

test("deny-wrapper sudo", () => {
  expect(decide(policy, { tag: "deny-wrapper", argv0: "sudo" }).effect).toBe("deny")
})

test("opaque is deny when sandbox is on", () => {
  expect(decide(policy, { tag: "opaque", source: "curl $(echo x)" }, { sandboxProfile: "workspace" }).effect).toBe("deny")
})

test("opaque is ask when sandbox is off", () => {
  expect(decide(policy, { tag: "opaque", source: "curl $(echo x)" }, { sandboxProfile: "off" }).effect).toBe("ask")
})

test("metadata curl deny", () => {
  expect(
    decide(policy, {
      tag: "segments",
      segments: [["curl", "http://169.254.169.254/latest/meta-data"]],
    }).effect,
  ).toBe("deny")
})

test("load-time match fixtures pass", async () => {
  await loadBuiltin()
})

test("basename git allowed only for listed realpath", async () => {
  const pinned = {
    ...policy,
    hosts: [{ name: "git", paths: ["/usr/bin/git"] }],
  }
  expect(
    (
      await decideAsync(
        pinned,
        { tag: "segments", segments: [["/usr/bin/git", "status"]] },
        { resolve: async () => "/usr/bin/git" },
      )
    ).effect,
  ).toBe("allow")
  expect(
    (
      await decideAsync(
        pinned,
        { tag: "segments", segments: [["/tmp/evil/git", "status"]] },
        { resolve: async () => "/tmp/evil/git" },
      )
    ).effect,
  ).toBe("ask")
})
