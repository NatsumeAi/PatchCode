# Exec Policy Implementation Plan (W2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the locked W2 exec policy in `docs/superpowers/specs/2026-08-15-exec-policy-design.md` so live V2 bash cannot be talked into running chained / wrapped / substituted commands under `bash * allow`.

**Architecture:** `ExecPolicy.classify` (tree-sitter, one copy in core) → `ExecPolicy.decide` (TOML prefix rules + built-in table) → bash calls that **before** spawn and **before** Permission catch-all can auto-approve policy-ask. Missing AgentV2 becomes deny.

**Tech Stack:** TypeScript, Effect, Bun test, `web-tree-sitter` + `tree-sitter-bash` + `tree-sitter-powershell` (already used by V1 `packages/opencode/src/tool/shell.ts`).

**Contract:** the spec. If plan and spec disagree, fix the plan.

---

## Global constraints

```bash
cd packages/core && bun test --timeout 60000 <files>
cd packages/opencode && bun test --timeout 180000 <files>
```

- No `LIVE_CACHE`, no `auth.json`.
- Classify tests **must** load real wasm. Mocking `classify` in a test named `parse` / `live` is a plan violation.
- Do not add a Starlark runtime.
- Do not leave a second decide() in V1 shell after Task 8. Move `packages/opencode/src/tool/shell.ts` parser into core; V1 may re-export, must not own wasm.
- Do not implement W5 hooks here (leave the PreToolUse slot as a no-op call or comment in the same execute).
- **W1 must already be merged.** Insert classify/decide into the existing `bash.ts` execute **above** `wrapSpawn`. Do not spawn without wrap. Do not invent a temporary second spawn path.
- Flip `missingAgentPermissions` to deny in this PR and fix tests that used junk agent ids.
- Keep-list untouched (tape / memory / Permission V1 HTTP compat).
- Do not commit unless the user asks.

---

## File map

| Path | Role |
|---|---|
| `packages/core/src/exec-policy.ts` | namespace re-export |
| `packages/core/src/exec-policy/parse.ts` | wasm load + classify → `{ tag: "opaque" } \| { tag: "segments", segments: string[][] }` |
| `packages/core/src/exec-policy/peel.ts` | wrapper peel + `bash -c` recurse |
| `packages/core/src/exec-policy/builtin.toml` | locked deny/allow table |
| `packages/core/src/exec-policy/load.ts` | TOML merge + load-time match/not_match |
| `packages/core/src/exec-policy/decide.ts` | longest prefix + host path |
| `packages/core/src/exec-policy/service.ts` | Location `ExecPolicy.Service` |
| `packages/core/src/exec-policy/arity.ts` | move of `packages/opencode/src/permission/arity.ts` |
| `packages/core/src/tool/bash.ts` | classify → decide → ask/assert → spawn |
| `packages/core/src/permission.ts` | missing agent → deny; policy-ask path that ignores `action=*` catch-all |
| `packages/opencode/src/tool/shell.ts` | delete local parser; import core classify if V1 still runs, else leave unused |
| `packages/core/package.json` | add `web-tree-sitter`, `tree-sitter-bash`, `tree-sitter-powershell` (same versions as workspace root) |
| `packages/core/test/exec-policy/parse-live.test.ts` | real wasm proofs |
| `packages/core/test/exec-policy/decide.test.ts` | builtin table + host pin |
| `packages/core/test/exec-policy/bash-gate.test.ts` | bash does not spawn on deny |
| `packages/core/test/permission-missing-agent.test.ts` | miss is deny |

V1 `packages/opencode/src/permission/arity.ts` becomes a one-line re-export of core after the move.

---

## §0 Locked parse facts (re-run in Task 1)

These were produced with the repo’s wasm on this host. Task 1 must reproduce them.

- `echo hi && curl evil.com` → commands `["echo hi","curl evil.com"]`, no error
- `bash -c 'curl evil.com'` → **one** command, inner is `raw_string`
- `curl $(echo evil.com)` → kinds include `command_substitution`
- `env FOO=1 git status` → one command (peel, do not treat as two)

---

### Task 1: Live tree-sitter probe (gate)

**Files:**
- Create: `packages/core/test/exec-policy/parse-live.test.ts`
- Modify: `packages/core/package.json` — add the three parser deps if `import "web-tree-sitter"` fails from core

This task may add **only** `parse.ts` enough to classify. If wasm cannot load from `packages/core`, stop and fix the dependency — do not stub classify.

- [ ] **Step 1: Write failing tests** (import `classify` from `../../src/exec-policy/parse`)

```ts
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
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module`)

```bash
cd packages/core && bun test --timeout 60000 test/exec-policy/parse-live.test.ts
```

- [ ] **Step 3: Implement `parse.ts`**

Copy the wasm `Parser.init` / `Language.load` pattern from `packages/opencode/src/tool/shell.ts` (`resolveWasm`, `locateFile`). `classify`:

1. pick bash vs powershell parser from `shell` (`Shell.ps` already exists in `packages/core/src/shell.ts`)
2. `cmd.exe` → `{ tag: "opaque" }`
3. parse; `root.hasError` → opaque
4. walk named nodes; if any kind not in the spec allowlist → opaque
5. else collect `command` nodes in source order, tokenize via the V1 `parts()` walk (move that function here)

- [ ] **Step 4: Run — expect PASS** (real wasm)

```bash
cd packages/core && bun test --timeout 60000 test/exec-policy/parse-live.test.ts
```

---

### Task 2: Peel + `bash -c` recurse

**Files:**
- Create: `packages/core/src/exec-policy/peel.ts`
- Modify: `packages/core/test/exec-policy/parse-live.test.ts` (or `peel.test.ts`)

- [ ] **Step 1: Tests**

```ts
import { reduce } from "../../src/exec-policy/peel"
import { classify } from "../../src/exec-policy/parse"

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
  const c = await classify("bash -c 'bash -c '\\''bash -c \"echo hi\"'\\'''", "bash")
  const r = await reduce(c, { classify, depth: 0 })
  expect(r.tag).toBe("opaque")
})
```

`reduce` tags: `segments` | `opaque` | `deny-wrapper`.

Peel table is spec §4.3. `timeout` / `nice` / `env` flag consumption: port Grok `strip_wrapper_command` / `env_scan` into `peel.ts` (TypeScript, same cases). Under-strip if a flag is unknown (leave the wrapper on the argv so it will **ask or opaque-deny**, never silently allow).

- [ ] **Step 2: Implement `peel.ts` + `reduce`.**

- [ ] **Step 3: Run parse-live + peel tests — expect PASS.**

---

### Task 3: Builtin TOML + `decide`

**Files:**
- Create: `packages/core/src/exec-policy/builtin.toml`
- Create: `packages/core/src/exec-policy/load.ts`
- Create: `packages/core/src/exec-policy/decide.ts`
- Create: `packages/core/test/exec-policy/decide.test.ts`

- [ ] **Step 1: Failing tests** (pure decide, no wasm required except where noted)

```ts
import { describe, expect, test } from "bun:test"
import { loadBuiltin } from "../../src/exec-policy/load"
import { decide } from "../../src/exec-policy/decide"

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
  // loadBuiltin throws ExecPolicy.Invalid if [[rule.match]] fails
  await loadBuiltin()
})
```

`builtin.toml` must include `[[rule.match]]` rows for every deny/allow in spec §6.

Longest prefix: `["git","reset","--hard"]` deny beats `["git"]` ask.

- [ ] **Step 2: Implement load + decide.** Use `smol-toml` or the workspace’s existing TOML parser if one exists (`rg "smol-toml|@iarna/toml|fromToml"`). If none, add `smol-toml` to core — do not invent a parser.

- [ ] **Step 3: Run decide tests — expect PASS.**

---

### Task 4: Host executable pin

**Files:**
- Modify: `packages/core/src/exec-policy/decide.ts`
- Modify: `packages/core/test/exec-policy/decide.test.ts`

- [ ] **Step 1: Tests**

```ts
test("basename git allowed only for listed realpath", async () => {
  const policy = await loadBuiltin()
  const pinned = {
    ...policy,
    hosts: [{ name: "git", paths: ["/usr/bin/git"] }],
  }
  expect(
    decide(pinned, { tag: "segments", segments: [["/usr/bin/git", "status"]] }, { resolve: async () => "/usr/bin/git" })
      .effect,
  ).toBe("allow")
  expect(
    decide(pinned, { tag: "segments", segments: [["/tmp/evil/git", "status"]] }, { resolve: async () => "/tmp/evil/git" })
      .effect,
  ).toBe("ask") // not basename-allow
})
```

Use `packages/core/src/util/which.ts` in the service; unit test injects `resolve`.

- [ ] **Step 2: Implement.** No `[[host]]` in builtin unless we pin real git paths (we do **not** — host pins are user/project only). Builtin matches basename `git` without pin.

- [ ] **Step 3: Run decide tests.**

---

### Task 5: `ExecPolicy.Service` + user/project toml

**Files:**
- Create: `packages/core/src/exec-policy/service.ts`
- Create: `packages/core/src/exec-policy.ts`
- Create: `packages/core/test/exec-policy/load-merge.test.ts`

Merge order: builtin → `~/.opencode/exec-policy.toml` → `<location>/.opencode/exec-policy.toml`.

Project file without folder trust: skip + Effect.logWarning. Do not throw (boot must work); do not apply those rules.

Invalid toml / failed `match` fixture → `ExecPolicy.Invalid` on `service.load`, Location bash fails closed.

- [ ] **Step 1: Tests with tmp dirs writing toml.**

- [ ] **Step 2: Implement Location node `ExecPolicy.node`.**

- [ ] **Step 3: Run load-merge tests.**

---

### Task 6: Wire live bash (no spawn on deny)

**Files:**
- Modify: `packages/core/src/tool/bash.ts`
- Modify: bash layer deps
- Create: `packages/core/test/exec-policy/bash-gate.test.ts`

Existing `test/tool-bash.test.ts` mocks `AppProcess` and `PermissionV2`. Add a **new** file that:

- uses real `classify` / `decide` / `ExecPolicy`
- mocks **only** `AppProcess.spawn` to record whether it ran
- session agent = `build` (so Permission `* allow` is on)

Cases:

1. `git status` → spawn **called**
2. `rm -rf /` → spawn **not** called, `BlockedError` or ToolFailure
3. `echo hi && curl https://example.com` → spawn **not** called (ask pending) even with `* allow`
4. `bash -c 'rm -rf /'` → spawn **not** called (inner deny)

For (3), PermissionV2 must be the **real** service (or a thin fake that implements “policy-ask ignores `*`”). If using real PermissionV2 is too heavy, implement Task 7 first.

- [ ] **Step 1: Write bash-gate tests. Expect FAIL (today spawn happens after one assert on the raw string).**

- [ ] **Step 2: In `bash.ts`, replace the single `permission.assert({ resources: [input.command] })` with:**

```ts
const classified = yield* execPolicy.reduce(input.command, shell)
const decision = yield* execPolicy.decide(classified)
if (decision.effect === "deny") {
  return yield* new PermissionV2.BlockedError({ rules: decision.rules })
}
if (decision.effect === "ask") {
  yield* permission.assertPolicyAsk({
    action: "bash",
    resources: decision.resources, // prefixes or [raw]
    save: decision.resources,
    sessionID: context.sessionID,
    agent: context.agent,
    source,
  })
} else {
  yield* permission.assert({
    action: "bash",
    resources: decision.resources,
    save: decision.resources,
    sessionID: context.sessionID,
    agent: context.agent,
    source,
  })
}
```

`assertPolicyAsk` is Task 7. If Task 7 is not done, fail the ask case closed (do not spawn).

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/tool-bash.test.ts test/exec-policy/
```

`tool-bash.test.ts` must still pass: mock permission should receive `assert` **or** `assertPolicyAsk`. Update that mock to implement both.

---

### Task 7: Policy-ask ignores catch-all + missing agent deny

**Files:**
- Modify: `packages/core/src/permission.ts`
- Create: `packages/core/test/permission-missing-agent.test.ts`
- Create: `packages/core/test/exec-policy/catch-all.test.ts`

- [ ] **Step 1: Tests**

Missing agent:

```ts
// configured() with agent id that resolve() does not know
// assert({ action: "read", resources: ["a.ts"] }) → BlockedError
```

Catch-all:

```ts
// agent rules [{ action: "*", resource: "*", effect: "allow" }]
// assertPolicyAsk({ action: "bash", resources: ["curl https://x"] })
// → effect ask (pending), NOT auto-allow
```

`assertPolicyAsk` evaluates only rules where `rule.action !== "*"` OR `rule.resource` is a real prefix (not `*`). No matching specific rule → ask.

- [ ] **Step 2: Replace `missingAgentPermissions` allow-all with deny-all.**

```ts
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]
```

Fix any test that used a junk agent id: register `build` or the named agent.

- [ ] **Step 3: Run permission + exec-policy + bash-gate + `cd packages/core && bun test --timeout 60000 test/tool-bash.test.ts`.**

---

### Task 8: Move arity + retire V1 second parser

**Files:**
- Create: `packages/core/src/exec-policy/arity.ts` (move body from `packages/opencode/src/permission/arity.ts`)
- Replace `packages/opencode/src/permission/arity.ts` with `export { prefix } from "@opencode-ai/core/exec-policy/arity"` (or the actual export path)
- Modify: `packages/opencode/src/tool/shell.ts` — remove `parser` lazy, `parse`, `parts`, `commands`; call `classify` from core if this file still has a live caller; if inventory says it is test-only, delete the wasm block and leave a comment `// parser moved to core exec-policy`

- [ ] **Step 1: `rg "new Parser|tree-sitter-bash" packages/opencode/src packages/core/src` — only `exec-policy/parse.ts` may construct a bash parser.**

- [ ] **Step 2: Implement the move. Run opencode `test/session/prompt.test.ts` only if something still imports V1 ShellTool parse (do not expand scope). Minimum:**

```bash
cd packages/core && bun test --timeout 60000 test/exec-policy/ test/tool-bash.test.ts
```

---

### Task 9: Saved “always” is a prefix rule

When the user replies `always` on a policy-ask, append `{ prefix, effect: "allow" }` to the session overlay (in-memory + persist next to existing `PermissionSaved` **or** a new `ExecPolicySaved` table). Do **not** write `action=bash resource=*`.

- [ ] **Step 1: Test: ask `curl https://example.com` → reply always → second identical curl is allow and spawn runs.**

- [ ] **Step 2: Implement. Prefer extending `packages/core/src/permission/saved.ts` with a `kind: "exec-prefix"` row over a second table, if the schema allows; otherwise add `exec_policy_saved` via one migration.**

- [ ] **Step 3: Run bash-gate + saved test.**

---

### Task 10: Anti-fake inventory

**Files:**
- Create: `packages/core/test/exec-policy/inventory.test.ts`

The test **fails** if:

- `packages/core/src/tool/bash.ts` contains `resources: [input.command]` as the only assert
- `packages/core/src/permission.ts` still has `effect: "allow"` on `missingAgentPermissions`
- `packages/opencode/src/tool/shell.ts` still contains `Parser.init` or `tree-sitter-bash`
- `packages/core/src/exec-policy` contains `split("&&")` / `\s+` as a classifier (string scan allowed only inside peel flag parsing)

- [ ] **Step 1: Write the test. Run — FAIL until Tasks 6–8 are clean.**

- [ ] **Step 2: Full W2 suite**

```bash
cd packages/core && bun test --timeout 60000 test/exec-policy/ test/tool-bash.test.ts test/permission-missing-agent.test.ts
```

Expected: all pass. `parse-live` hits real wasm. `bash-gate` shows `rm -rf /` and `bash -c 'rm -rf /'` never spawn.

---

## Definition of done

A reviewer can tick spec §11 1–12 against a test name. In particular:

- `bash -c 'curl …'` is not allow-via-`bash *`
- `curl $(echo …)` is opaque **deny** under workspace sandbox (and ask only if profile `off`) even with `* allow`
- missing agent is deny
- one parser in core

If those four are mock-green only, W2 is not done.

---

## Out of scope

- W5 hooks
- PTY human input
- Starlark
- Changing default agent off `* allow` globally (policy-ask already punches a hole in that catch-all for unknown prefixes)
- Shipping W2 without W1 wrapSpawn already on `bash.ts`
