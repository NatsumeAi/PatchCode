# OS Sandbox Implementation Plan (W1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the locked W1 sandbox in `docs/superpowers/specs/2026-08-15-os-sandbox-design.md` so agent-facing children are kernel-isolated and in-process file tools obey the same policy — without a second implementation and without a mock-only “sandbox.”

**Architecture:** `Sandbox.Service` owns profile resolve, `assertPath`, and `wrapSpawn`. `AppProcess` stays unsandboxed. Linux = system `bwrap` only. Darwin = `sandbox-exec`. Windows non-`off` = `Unsupported`. All agent spawn sites (bash, PTY `#pty`, MCP stdio, **`lsp/server.ts` language servers**, ripgrep, formatter) call `wrapSpawn`. This PR also lands shared `Trust.Service` + `Net.denyHost`.

**Default profile is not `off`.** See spec §9. Leave a frozen-chain comment in `bash.ts` execute so W2/W3 insert into the same function.

**Tech Stack:** TypeScript, Effect, Bun test, system `bwrap` (proven 0.6.1 on this host), Drizzle migration.

**Contract:** the spec. If this plan and the spec disagree, fix the plan — do not invent a third design.

---

## Global constraints

- Tests from package dirs only:
  - `cd packages/core && bun test --timeout 60000 <files>`
  - `cd packages/opencode && bun test --timeout 180000 <files>`
- No `LIVE_CACHE`, no `auth.json`.
- Live kernel tests **must not** mock `AppProcess`. Mocking `AppProcess` in a test named `live` / `kernel` is a plan violation.
- If `/usr/bin/bwrap` is missing on Linux, live kernel tests **fail** (do not skip). This machine has it; CI must install `bubblewrap` or fail.
- Do not add a Landlock path. Do not wrap the server process.
- Do not silently store `off` when bwrap is missing on Linux.
- Do not commit unless the user asks.
- Keep-list untouched: PromptTape, memory flush-on-compact, Permission V1 compat.
- Roadmap Hard freeze §2 is binding if this plan disagrees.

---

## File map

| Path | Role |
|---|---|
| `packages/core/src/trust.ts` | shared folder trust (`trusted-folders.json`) |
| `packages/core/src/net/deny-host.ts` | shared SSRF (loopback / 169.254 / metadata) |
| `packages/core/src/sandbox.ts` | `Sandbox` namespace re-export |
| `packages/core/src/sandbox/profile.ts` | built-in profiles, deny defaults, custom toml merge, glob match |
| `packages/core/src/sandbox/resolve.ts` | session pin + Location path expansion |
| `packages/core/src/sandbox/assert-path.ts` | in-process `assertPath` |
| `packages/core/src/sandbox/wrap-spawn.ts` | `wrapSpawn` → rewritten argv |
| `packages/core/src/sandbox/linux-bwrap.ts` | bwrap argv builder + binary lookup |
| `packages/core/src/sandbox/darwin-seatbelt.ts` | Seatbelt profile text + `sandbox-exec` argv |
| `packages/core/src/sandbox/windows.ts` | `Unsupported` |
| `packages/core/src/sandbox/service.ts` | Effect `Sandbox.Service` Location node |
| `packages/core/src/database/migration/20260815180000_add_session_sandbox_profile.ts` | column |
| `packages/core/src/session/sql.ts` | `sandbox_profile` |
| `packages/core/src/session/info.ts` | map column → Info |
| `packages/schema/src/session.ts` | `sandboxProfile` on Info |
| `packages/core/src/config.ts` | `sandbox.profile` |
| `packages/core/src/tool/bash.ts` | `wrapSpawn("workspace-child")` then `AppProcess` |
| `packages/core/src/ripgrep.ts` | `wrapSpawn("integration-child")` |
| `packages/core/src/pty.ts` | wrap shell before `#pty` spawn |
| `packages/core/src/location-mutation.ts` + `tool/read.ts` / `write.ts` / `edit.ts` | `assertPath` |
| `packages/opencode/src/mcp/index.ts` | wrap stdio command |
| `packages/opencode/src/lsp/launch.ts` | wrap helper if still used |
| `packages/opencode/src/lsp/server.ts` | **all language-server spawns** through wrap helper |
| `packages/opencode/src/format/index.ts` | wrap formatter spawn |
| `packages/core/test/sandbox/linux-bwrap-live.test.ts` | kernel proofs |
| `packages/core/test/sandbox/assert-path.test.ts` | in-process policy |
| `packages/core/test/sandbox/wrap-spawn.test.ts` | argv + win32 refuse |
| `packages/opencode/test/sandbox/spawn-inventory.test.ts` | no bypass |

Host must **not** wrap: `packages/core/src/git.ts`, `session/worktree-pool.ts`, `packages/opencode/src/snapshot/index.ts`, LSP `go install` / `gem install` helpers.

---

## §0 Locked facts (do not rediscover)

Host probe already succeeded (see spec). Re-run at the start of Task 1. If it fails, **stop the program** — the environment cannot enforce a real sandbox.

Bwrap rewrite is:

```
bwrap --die-with-parent --unshare-pid --dev /dev --proc /proc
  [--unshare-net]                  # workspace-child && restrict_network
  --ro-bind / /                    # workspace | read-only
  --bind <w> <w>...
  --ro-bind /dev/null <denied-file>
  --tmpfs <denied-dir>
  --chdir <cwd>
  --
  <cmd> <args>
```

`strict` omits `--ro-bind / /` and only binds the read roots in the spec.

---

### Task 0: Shared Trust + deny-host (this PR, used by later W*)

**Files:**
- Create: `packages/core/src/trust.ts`
- Create: `packages/core/src/net/deny-host.ts`
- Create: `packages/core/test/trust.test.ts`
- Create: `packages/core/test/net-deny-host.test.ts`

- [ ] `Trust.isTrusted(absPath)` reads `~/.opencode/trusted-folders.json` prefix match on realpath. Empty file → nothing trusted.
- [ ] `Trust.grant(absPath)` writes canonical path. CLI can call this later; W1 only needs the module.
- [ ] `Net.denyHost(url|hostname)` true for loopback, link-local, `169.254.169.254`, `metadata.google.internal` (and documented aliases). No DNS lookup required for literal IPs; hostname literals on the deny list fail before fetch.
- [ ] Tests: untrusted tmp dir is false; after grant, true. `http://169.254.169.254/` denied; `https://example.com` not denied.

Do not put a second copy under `hooks/trust.ts`.

---

### Task 1: Live kernel probe (gate)

**Files:**
- Create: `packages/core/test/sandbox/linux-bwrap-live.test.ts`

This task adds **no product code**. If it fails, later tasks are fake.

- [ ] **Step 1: Write the live probe**

```ts
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const bwrap = "/usr/bin/bwrap"

function run(args: string[]) {
  return new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(bwrap, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += String(c)))
    child.stderr.on("data", (c) => (stderr += String(c)))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

describe.skipIf(process.platform !== "linux")("bwrap kernel probe", () => {
  test("binary exists — missing bwrap is a hard fail on linux", async () => {
    const stat = await Bun.file(bwrap).exists()
    expect(stat).toBe(true)
  })

  test("write outside bind is EROFS and does not create the host file", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-sb-work-"))
    const outside = await mkdtemp(path.join(tmpdir(), "oc-sb-out-"))
    const leaked = path.join(outside, "leaked.txt")
    try {
      const result = await run([
        "--die-with-parent",
        "--unshare-pid",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        work,
        work,
        "--chdir",
        work,
        "--",
        "/bin/sh",
        "-c",
        `echo leaked > '${leaked}'`,
      ])
      expect(result.code).not.toBe(0)
      expect(result.stderr + result.stdout).toMatch(/Read-only file system|Permission denied|权限不够/i)
      expect(await Bun.file(leaked).exists()).toBe(false)
    } finally {
      await rm(work, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("denied file bind-over is unreadable", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-sb-den-"))
    try {
      await writeFile(path.join(work, "secret.env"), "SECRET\n")
      const result = await run([
        "--die-with-parent",
        "--unshare-pid",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        work,
        work,
        "--ro-bind",
        "/dev/null",
        path.join(work, "secret.env"),
        "--chdir",
        work,
        "--",
        "/bin/cat",
        "secret.env",
      ])
      expect(result.code).not.toBe(0)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test("unshare-net makes TCP ENETUNREACH", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-sb-net-"))
    try {
      const result = await run([
        "--die-with-parent",
        "--unshare-pid",
        "--unshare-net",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        work,
        work,
        "--chdir",
        work,
        "--",
        "python3",
        "-c",
        "import socket; s=socket.socket(); s.settimeout(1); s.connect(('1.1.1.1', 53))",
      ])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/Network is unreachable|Errno 101/)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run**

```bash
cd packages/core && bun test --timeout 60000 test/sandbox/linux-bwrap-live.test.ts
```

Expected: 4 pass on this Linux host. If `binary exists` fails, install `bubblewrap` or stop.

---

### Task 2: Profile + glob + `assertPath` (pure)

**Files:**
- Create: `packages/core/src/sandbox/profile.ts`
- Create: `packages/core/src/sandbox/assert-path.ts`
- Create: `packages/core/test/sandbox/assert-path.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { assertPath } from "../../src/sandbox/assert-path"
import { builtInProfile } from "../../src/sandbox/profile"

test("workspace allows write inside location", () => {
  const p = builtInProfile("workspace", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "write", "/repo/a.ts")._tag).toBe("Allow")
})

test("workspace denies write to home probe", () => {
  const p = builtInProfile("workspace", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "write", "/home/u/opencode-sandbox-probe")._tag).toBe("Deny")
})

test("default deny blocks .env even inside location", () => {
  const p = builtInProfile("workspace", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "read", "/repo/.env")._tag).toBe("Deny")
  expect(assertPath(p, "read", "/repo/.env.example")._tag).toBe("Allow")
})

test("off never denies", () => {
  const p = builtInProfile("off", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "write", "/home/u/.ssh/id_rsa")._tag).toBe("Allow")
})
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module` / `builtInProfile is not a function`)

```bash
cd packages/core && bun test --timeout 60000 test/sandbox/assert-path.test.ts
```

- [ ] **Step 3: Implement `profile.ts` and `assert-path.ts`**

`builtInProfile` returns `{ name, defaultRead, readRoots, writeRoots, denyGlobs, restrictNetwork }`.

Default deny globs **exactly** as in the spec. `assertPath`:

1. `name === "off"` → Allow
2. realpath-normalize (pure string join; no IO in this unit)
3. deny glob (gitignore-style `**`, same subset as Grok: `* ? ** [abc]`, no braces) → Deny
4. write/rename: must be under a write root → else Deny
5. `strict` read: must be under a read root → else Deny
6. else Allow

- [ ] **Step 4: Run — expect PASS**

```bash
cd packages/core && bun test --timeout 60000 test/sandbox/assert-path.test.ts
```

---

### Task 3: `linux-bwrap` argv builder

**Files:**
- Create: `packages/core/src/sandbox/linux-bwrap.ts`
- Create: `packages/core/test/sandbox/wrap-spawn.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { buildLinuxWrap } from "../../src/sandbox/linux-bwrap"
import { builtInProfile } from "../../src/sandbox/profile"

test("workspace wrap starts with bwrap and keeps original command after --", () => {
  const profile = builtInProfile("workspace", {
    location: "/repo",
    home: "/home/u",
    tmp: "/tmp",
    opencodeTmp: "/tmp/opencode",
  })
  const wrapped = buildLinuxWrap({
    profile,
    class: "workspace-child",
    cwd: "/repo",
    command: "/bin/sh",
    args: ["-c", "echo hi"],
    bwrapPath: "/usr/bin/bwrap",
    deniedFiles: ["/repo/.env"],
    deniedDirs: [],
  })
  expect(wrapped.command).toBe("/usr/bin/bwrap")
  expect(wrapped.args.slice(0, 3)).toEqual(["--die-with-parent", "--unshare-pid", "--dev"])
  expect(wrapped.args).toContain("--ro-bind")
  expect(wrapped.args).not.toContain("--unshare-net")
  const dd = wrapped.args.indexOf("--")
  expect(wrapped.args.slice(dd)).toEqual(["--", "/bin/sh", "-c", "echo hi"])
  expect(wrapped.args).toContain("/repo/.env")
})

test("read-only workspace-child adds unshare-net; integration-child does not", () => {
  const profile = builtInProfile("read-only", {
    location: "/repo",
    home: "/home/u",
    tmp: "/tmp",
    opencodeTmp: "/tmp/opencode",
  })
  const shell = buildLinuxWrap({
    profile,
    class: "workspace-child",
    cwd: "/repo",
    command: "/bin/sh",
    args: [],
    bwrapPath: "/usr/bin/bwrap",
    deniedFiles: [],
    deniedDirs: [],
  })
  const mcp = buildLinuxWrap({
    profile,
    class: "integration-child",
    cwd: "/repo",
    command: "npx",
    args: ["-y", "fake-mcp"],
    bwrapPath: "/usr/bin/bwrap",
    deniedFiles: [],
    deniedDirs: [],
  })
  expect(shell.args).toContain("--unshare-net")
  expect(mcp.args).not.toContain("--unshare-net")
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd packages/core && bun test --timeout 60000 test/sandbox/wrap-spawn.test.ts
```

- [ ] **Step 3: Implement `buildLinuxWrap` exactly as §0 / spec §6**

Writable binds = `profile.writeRoots`. Denied files = `--ro-bind /dev/null PATH`. Denied dirs = `--tmpfs PATH`.

- [ ] **Step 4: Run — expect PASS**

```bash
cd packages/core && bun test --timeout 60000 test/sandbox/wrap-spawn.test.ts
```

---

### Task 4: Darwin builder + Windows refuse

**Files:**
- Create: `packages/core/src/sandbox/darwin-seatbelt.ts`
- Create: `packages/core/src/sandbox/windows.ts`
- Modify: `packages/core/test/sandbox/wrap-spawn.test.ts`

- [ ] **Step 1: Add tests**

```ts
import { buildDarwinWrap } from "../../src/sandbox/darwin-seatbelt"
import { windowsRefuse } from "../../src/sandbox/windows"

test("darwin profile text denies .env and optional network", () => {
  const profile = builtInProfile("read-only", {
    location: "/repo",
    home: "/home/u",
    tmp: "/tmp",
    opencodeTmp: "/tmp/opencode",
  })
  const { command, args, seatbelt } = buildDarwinWrap({
    profile,
    class: "workspace-child",
    cwd: "/repo",
    command: "/bin/zsh",
    args: ["-l"],
  })
  expect(command).toBe("sandbox-exec")
  expect(seatbelt).toContain("(version 1)")
  expect(seatbelt).toContain("deny")
  expect(seatbelt).toMatch(/\\.env/)
  expect(seatbelt).toContain("(deny network*)")
  expect(args[0]).toBe("-p")
  expect(args.includes("--")).toBe(true)
})

test("windows non-off is Unsupported", () => {
  const err = windowsRefuse("workspace")
  expect(err._tag).toBe("Sandbox.Unsupported")
})
```

- [ ] **Step 2: Implement Seatbelt text generator** matching spec §7 (workspace/read-only = allow default + deny writes outside roots + deny globs; read-only/strict workspace-child = `(deny network*)`). `windowsRefuse` returns `new Sandbox.Unsupported({ platform: "win32", profile })`.

- [ ] **Step 3: Run wrap-spawn tests — expect PASS**

---

### Task 5: `Sandbox.Service` + wrapSpawn lookup

**Files:**
- Create: `packages/core/src/sandbox.ts`
- Create: `packages/core/src/sandbox/service.ts`
- Create: `packages/core/src/sandbox/wrap-spawn.ts`
- Create: `packages/core/src/sandbox/resolve.ts`

`Sandbox.Unavailable` / `Denied` / `Unsupported` / `ProfileMismatch` = `Schema.TaggedErrorClass`.

`wrapSpawn({ sessionID, class, cwd, command, args })`:

1. `resolve(sessionID)` → profile (`off` → return command/args unchanged)
2. `win32` → fail `Unsupported`
3. `linux` → `which bwrap` (`PATH`, then `/usr/bin/bwrap`). Missing → `Unavailable`
4. expand deny globs with `rg --files --hidden --no-ignore -g <glob>` under location and `$HOME`, cap 8192, else fail `glob_overflow`
5. `buildLinuxWrap` / `buildDarwinWrap`
6. return `{ command, args }`

`resolve` for this task may take an explicit `Sandbox.ResolveInput { profileName, location }` so we can unit-test without a session column yet. Session pin is Task 6.

- [ ] **Step 1: Test `off` is identity; `workspace` on linux prefixes bwrap; missing bwrap throws (inject `bwrapPath: "/no/bwrap"`).**

- [ ] **Step 2: Implement.**

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/sandbox/wrap-spawn.test.ts test/sandbox/assert-path.test.ts
```

---

### Task 6: Session pin + config

**Files:**
- Create: `packages/core/src/database/migration/20260815180000_add_session_sandbox_profile.ts`
- Modify: `packages/core/src/session/sql.ts` — add `sandbox_profile: text().notNull().default("off")`
- Modify: `packages/core/src/session/info.ts` — `sandboxProfile: row.sandbox_profile`
- Modify: `packages/schema/src/session.ts` — `sandboxProfile: Schema.String`
- Modify: `packages/core/src/config.ts` — optional `sandbox: Schema.Struct({ profile: Schema.String })`
- Modify: `packages/core/src/session.ts` create path — persist resolved profile; child copies parent; reject switch

Migration:

```ts
yield* tx.run(`ALTER TABLE \`session\` ADD \`sandbox_profile\` text NOT NULL DEFAULT 'off';`)
```

Resolution order for **new** sessions: create input `sandboxProfile` > `process.env.OPENCODE_SANDBOX` > `config.sandbox.profile` > trust default (`workspace` if `Trust.isTrusted(location)` else `strict` on Linux/Darwin; `off` on win32). Never fall through to `"off"` on Unix unless the user/config explicitly asked.

SQL `DEFAULT 'off'` is for migrated old rows only. Create writes the resolved name.

If create/resume requested name ≠ stored name → `ProfileMismatch`.

Linux + non-`off` + missing bwrap → create fails `Unavailable` (do not persist `off`).

- [ ] **Step 1: Add/adjust session create tests in the existing session test file that already inserts project rows.** If none fit, create `packages/core/test/sandbox/session-pin.test.ts` using the same DB fixture as `session-create` tests (copy the `sandboxes: []` insert pattern).

- [ ] **Step 2: Implement column + mapping + create/resume checks.**

- [ ] **Step 3: Run that test file.**

---

### Task 7: Wire bash (live, not mock)

**Files:**
- Modify: `packages/core/src/tool/bash.ts` — after permission, `wrapSpawn({ class: "workspace-child", ... })` then `AppProcess.run`. Leave a comment in execute with the frozen chain slots (`classify/decide/PlanGate/PreToolUse/BackgroundJob.start`) so W2/W3 do not invent a second spawn file.
- Modify: `packages/core/src/tool/builtins.ts` / bash layer deps to include `Sandbox.node`
- Create: `packages/core/test/sandbox/bash-live.test.ts`

Existing `tool-bash.test.ts` mocks `AppProcess`. **Leave those mocks.** Add a **separate** live file.

- [ ] **Step 1: Live bash test**

```ts
// tmp location, session with sandboxProfile "workspace"
// settle bash: `echo ok > inside.txt` → file exists
// settle bash: `echo leaked > $outside/leaked.txt` → exit != 0, host file absent
// write $location/.env with SECRET via host fs
// settle bash: `cat .env` → exit != 0
```

Use real `AppProcess.node` + real `Sandbox` + real `bwrap`. Skip **only** when `process.platform !== "linux"`. On linux, missing bwrap fails Task 1 already.

- [ ] **Step 2: Implement bash wrap. `off` sessions (all current unit tests) must keep current argv (`/bin/sh` or configured shell) so `tool-bash.test.ts` still passes.**

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/tool-bash.test.ts test/sandbox/bash-live.test.ts test/sandbox/linux-bwrap-live.test.ts
```

Expected: existing bash suite green; live file proves kernel deny.

---

### Task 8: `assertPath` on read / write / edit / LocationMutation

**Files:**
- Modify: `packages/core/src/location-mutation.ts` — after resolve, `assertPath(write)` when `forWrite`
- Modify: `packages/core/src/tool/read.ts` — `assertPath(read)` after path resolve
- Modify: `packages/core/src/tool/write.ts` / `edit.ts` / `apply-patch.ts` — rely on mutation or call assert
- Create: `packages/core/test/sandbox/read-deny.test.ts`

- [ ] **Step 1: Test `read` on `$location/.env` under workspace returns `Sandbox.Denied` / ToolFailure (not file contents).** Write the `.env` with host `fs` first.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Run `read-deny.test.ts` + existing write/edit tests.**

---

### Task 9: ripgrep + formatter

**Files:**
- Modify: `packages/core/src/ripgrep.ts` — wrap `integration-child` when a session profile is available. Ripgrep is Location-scoped today via `AppProcess`. Thread `Sandbox.Service`; if no session (host search), treat as `off`.
- Modify: `packages/opencode/src/format/index.ts` — wrap `workspace-child` when formatting a session path and session profile ≠ off.

- [ ] **Step 1: Live test: workspace session, `.env` contains `SECRET=1`, `grep`/`ripgrep` for `SECRET` does not return that line (denied path excluded or process cannot read it).**

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Run ripgrep/format existing tests + the new live test.**

---

### Task 10: PTY, MCP stdio, LSP server

**Files:**
- Modify: `packages/core/src/pty.ts` `create` — `wrapSpawn(workspace-child)` then pass rewritten argv to `#pty` (not AppProcess)
- Modify: `packages/opencode/src/mcp/index.ts` `connectLocal` — rewrite `cmd`/`args` via `wrapSpawn(integration-child)`
- Modify: `packages/opencode/src/lsp/server.ts` — one helper wrapping every **language-server** `spawn` / `Process.spawn`. `launch.ts` if it still spawns. Do **not** wrap `go install` / `gem install` / `dotnet tool install` (mark `// sandbox:host`).

- [ ] **Step 1: Tests**

PTY (linux live): create PTY with `command=/bin/sh`, `args=["-c", "echo leaked > $outside/leaked.txt; exit"]`, workspace profile, wait for exit, host file absent.

MCP: unit test `connectLocal` with a stub sandbox that records wrap input; assert `class === "integration-child"` and transport.command is `bwrap`. Use a fake profile ≠ off.

LSP: unit test that a representative `server.ts` spawn (e.g. typescript-language-server) has argv[0] `bwrap` when wrap is injected. Grep-only of `launch.ts` is **not** enough.

- [ ] **Step 2: Implement.** PTY env still sets `TERM` / `OPENCODE_TERMINAL` on the **inner** process (bwrap forwards env by default).

- [ ] **Step 3: Run the new tests + existing pty/mcp smoke if present.**

---

### Task 11: Bypass inventory (anti-fake CI)

**Files:**
- Create: `packages/opencode/test/sandbox/spawn-inventory.test.ts`
- Create: `packages/core/test/sandbox/spawn-inventory.test.ts`

The test reads these files as text and fails if they contain a spawn that is not preceded in-function by `wrapSpawn` (or a documented `// sandbox:host` marker on the same line):

**Must wrap:**

- `packages/core/src/tool/bash.ts`
- `packages/core/src/pty.ts`
- `packages/core/src/ripgrep.ts`
- `packages/opencode/src/mcp/index.ts` (`StdioClientTransport`)
- `packages/opencode/src/lsp/launch.ts`
- `packages/opencode/src/lsp/server.ts` (language-server spawns; installer lines may have `// sandbox:host`)
- `packages/opencode/src/format/index.ts`

**Allowed host (must contain `// sandbox:host` on the spawn line):**

- `packages/core/src/git.ts`
- `packages/core/src/session/worktree-pool.ts`
- `packages/opencode/src/snapshot/index.ts`
- LSP installer `Process.spawn(["go", "install", ...])` etc.

- [ ] **Step 1: Write the inventory test. Run — FAIL until markers and wraps exist.**

- [ ] **Step 2: Add `// sandbox:host` only on true host spawns. Fix any missed wrap.**

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/sandbox/
cd packages/opencode && bun test --timeout 180000 test/sandbox/spawn-inventory.test.ts
```

---

### Task 12: Config, env, events, Darwin/Windows behavior tests

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: session create (already Task 6) to read config/env
- Publish a small EventV2 payload on wrap failure (`unavailable` / `unsupported` / `denied`)

- [ ] **Step 1: Tests**

- `OPENCODE_SANDBOX=workspace` on create without explicit input → stored `workspace`
- untrusted Location, no env/config → stored `strict` (Linux/Darwin)
- explicit `OPENCODE_SANDBOX=off` → stored `off`
- `OPENCODE_SANDBOX=workspace` on resume of `off` session → `ProfileMismatch`
- win32: force `process.platform` via injecting `windowsRefuse` in wrapSpawn (do not mock platform globally); session create `workspace` fails `Unsupported`

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Full sandbox suite:**

```bash
cd packages/core && bun test --timeout 60000 test/sandbox/ test/tool-bash.test.ts
cd packages/opencode && bun test --timeout 180000 test/sandbox/
```

Expected: all pass. Live linux tests hit real bwrap. No skipped “kernel” test on linux.

---

## Definition of done

A reviewer can:

1. Read spec §13 and tick each item against a test name in `test/sandbox/`.
2. Run Task 1 on this host and see EROFS / EACCES / ENETUNREACH.
3. Run Task 7 and see bash under `workspace` unable to create a file outside the Location **on the host**.
4. `rg "wrapSpawn" packages/core/src/tool/bash.ts packages/core/src/pty.ts packages/opencode/src/mcp/index.ts packages/opencode/src/lsp/server.ts` — all hit. `launch.ts` if it still spawns.
5. Find **zero** Landlock code and **zero** “fallback to permission-only” branches.
6. New Unix session without env/config is `workspace` or `strict`, never implicit `off`.

If any of those fail, W1 is not done. Inventory grep alone is not Done.

---

## Out of scope (explicit, not “later in this plan”)

- W2 exec policy / tree-sitter arity
- W5 user hooks (when they land they must call `wrapSpawn("workspace-child")`)
- W6 CoW worktree
- Bundled bwrap binary
- Windows AppContainer
- Server-process landlock
