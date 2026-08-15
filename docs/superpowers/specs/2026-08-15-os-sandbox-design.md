# OS Sandbox Design (W1)

> **Status:** locked for implementation. Pair with `docs/superpowers/plans/2026-08-15-os-sandbox.md`.
> This is the final architecture. No second sandbox implementation. No “software now, kernel later.”

**Goal:** Kernel-enforced filesystem (and, for agent shells, network) isolation for every agent-facing child, plus the same policy on in-process file tools — so `bash`, PTY, MCP stdio, LSP, `grep`/`ripgrep`, and `read`/`write`/`edit` cannot silently escape.

**Proven on this host (2026-08-15, Ubuntu 6.8, `bwrap` 0.6.1, `unprivileged_userns_clone=1`):**

```
--ro-bind / / --bind $WORKDIR $WORKDIR
  write inside WORKDIR          → ok
  write outside WORKDIR         → "Read-only file system" (exit 2)
--ro-bind /dev/null $WORKDIR/secret.env
  cat secret.env                → EACCES
--unshare-net
  TCP connect                   → ENETUNREACH
```

If a later environment cannot reproduce these three outcomes, **do not ship a non-`off` profile** on that host. Missing `bwrap` on Linux is `Sandbox.Unavailable`, not a silent `off`. Do not invent a permission-only fallback.

---

## 1. Threat model

PermissionV2 and `assertWriteContained` are policy. They do not stop a `bash` child that already has the user’s uid from:

- `curl` exfiltrating `~/.ssh` / `.env`
- `mv ~/.ssh/id_rsa /tmp/x && cat /tmp/x`
- writing outside the Location via `/bin/sh -c`

Sandbox is the **upper bound**. `allow *` cannot widen it.

---

## 2. Permanently rejected

| Idea | Why rejected |
|---|---|
| Landlock/Seatbelt on the OpenCode **server** process | One process, N Locations, in-process LLM/SQLite/HTTP. Grok’s process-lifetime model does not fit. |
| Linux Landlock as a stepping-stone then switch to bwrap | Two implementations. Linux backend is **only** bwrap. |
| Software path checks as the only enforcement for `bash` | Fake sandbox. |
| “We’ll wrap MCP/PTY/LSP later” | Fake sandbox. Those are live spawn holes today. |
| Silent degrade to permission-only when bwrap is missing | Fake sandbox. |
| Windows AppContainer in this program | Not executable in this TS tree with a known, tested recipe. Windows `profile !== off` **refuses**. That is the product, not a stub. |

---

## 3. One service, two surfaces, one policy

```
Sandbox.Service          Location-scoped
  resolve(sessionID)     pinned profile name + paths vs current Location
  assertPath(op, path)   in-process read | write | rename
  wrapSpawn(class, cmd)  the only agent-child exec transform
```

`AppProcess` stays the **unsandboxed** host primitive (git, snapshot, worktree pool, installer).

Agent-facing children **must** call `wrapSpawn` then `AppProcess` / PTY / MCP / LSP spawn. A CI test greps the agent spawn sites; a new raw spawn in those trees fails CI.

---

## 4. Spawn classes (final)

| Class | Who | FS profile | Network |
|---|---|---|---|
| `workspace-child` | `bash`, PTY, after-edit formatter, W5 hook shell, future background bash | full | `restrict_network` → Linux `--unshare-net` (not a TS seccomp filter) |
| `integration-child` | MCP **stdio**, LSP **server** process, ripgrep used by grep/glob | full | always on |
| host (not a class) | `git.ts`, snapshot, worktree-pool, LSP *install* (`go install` / `gem install`), CLI pager | no wrap | host |

In-process LLM / webfetch / websearch never go through `wrapSpawn`.

---

## 5. Profiles

| Name | Read | Write | `workspace-child` net |
|---|---|---|---|
| `off` | unrestricted | unrestricted (PermissionV2 still applies) | on |
| `workspace` | all (via `--ro-bind / /`) | Location + `Global.Path.{data,cache,config,state,tmp}` + `/tmp` + `/var/tmp` | on |
| `read-only` | all | `Global.Path.{data,cache,config,state,tmp}` + `/tmp` + `/var/tmp` | **off** (`--unshare-net`) |
| `strict` | Location + `/bin` `/sbin` `/usr` `/etc` `/lib` `/lib64` `/dev` `/proc` `/nix/store` | Location + `Global.Path.tmp` + fresh `--tmpfs /tmp` | **off** |
| custom | `extends` + overrides | same | as configured |

**Default deny (all non-`off` profiles, cannot be removed by custom `read_write`):**

- `**/.ssh`
- `**/.gnupg`
- `**/.aws`
- `**/.netrc`
- `**/.env`
- `**/.env.*` except `**/.env.example`
- `**/*.pem`
- `**/*.key`

Custom deny is appended. Deny = no read, no write, no rename. Enforcement:

- in-process: `assertPath` glob match on the resolved realpath
- Linux child: each **spawn** expands globs under the Location + `$HOME` (cap 8192 hits; overflow → spawn fails) and `--ro-bind /dev/null` (file) or `--tmpfs` (dir) over each hit
- macOS child: Seatbelt regex on the same globs (runtime, including files created after start)

Project `sandbox.toml` custom profiles require folder trust. Untrusted project profile name → resolve **fails** (not `off`).

---

## 6. Linux wrapper (the only Linux backend)

Resolved `bwrap` binary from `PATH`. Missing → `Sandbox.Unavailable` for any wrap of a non-`off` session.

Canonical argv (workspace, network on):

```
bwrap
  --die-with-parent
  --unshare-pid
  --dev /dev
  --proc /proc
  --ro-bind / /
  --bind <writable> <writable>     # one per writable root
  --ro-bind /dev/null <denied-file>
  --tmpfs <denied-dir>
  --chdir <cwd>
  --
  <original command> <args...>
```

`read-only` / `strict` add `--unshare-net` for `workspace-child` only.

`strict` does **not** `--ro-bind / /`. It bind-mounts only the read roots listed above, then writable binds.

PTY: node-pty `#pty` is **not** `AppProcess`. Call `wrapSpawn("workspace-child")` on the shell argv, then pass the rewritten command/args to `#pty`.

MCP `StdioClientTransport`: `command = bwrap`, `args = [ ...wrap, "--", originalCmd, ...originalArgs ]`.

LSP: every **language-server** `spawn` / `Process.spawn` in `packages/opencode/src/lsp/server.ts` goes through one helper that calls `wrapSpawn("integration-child")` then the existing spawn. `launch.ts` is not sufficient — most servers spawn in `server.ts`. Installers (`go install`, `gem install`, `dotnet tool install`) stay `// sandbox:host`.

---

## 7. macOS wrapper (the only Darwin backend)

`sandbox-exec -p <generated-sbpl> -- <cmd> ...`

Generated Seatbelt:

- `(version 1)`
- `(allow default)` for `workspace` / `read-only` (read-all) then `(deny file-write*)` except writable subpaths
- `strict`: `(deny default)` then allow listed read/write subpaths + process-exec + sysctl needed to run binaries
- deny globs → `(deny file-read* file-write-*)` with `regex`
- `workspace-child` + `restrict_network` → `(deny network*)`

`sandbox-exec` missing → `Sandbox.Unavailable` (will not happen on real macOS).

---

## 8. Windows

`process.platform === "win32"` && profile !== `off` → `Sandbox.Unsupported` at session create and at every `wrapSpawn`. No pretend workspace.

---

## 9. Session pin

- Column `session.sandbox_profile` `text not null default 'off'` — SQL default is **only** for pre-W1 rows after migration. Create must write the resolved name.
- New session resolution: create input > `OPENCODE_SANDBOX` > `config.sandbox.profile` > **trust default** (Linux/Darwin: trusted Location → `workspace`, untrusted → `strict`; win32 → `off` + `sandbox.unsupported` event). Explicit `off` is the only way to disable on Unix.
- Linux/Darwin + resolved profile ≠ `off` + missing `bwrap`/`sandbox-exec` → session create **fails** `Unavailable`. Never store `off` as a fallback.
- win32 + requested profile ≠ `off` → `Unsupported` at create and every `wrapSpawn`.
- Resume / continue: use stored name. CLI/config asking a **different** name → error. New session to change.
- Child `task` session copies parent profile (cannot widen).
- Paths recompute from the current Location on every `resolve` / `wrapSpawn`. Location move that cannot apply the profile → drain fails.
- This PR also lands `Trust.Service` (`packages/core/src/trust.ts`, `~/.opencode/trusted-folders.json`) and `Net.denyHost` (`packages/core/src/net/deny-host.ts`). Later W2/W5/W8f/W8g/W8h import them; do not triplicate.

---

## 10. In-process `assertPath`

Called from `LocationMutation.resolve` (writes) and read/grep/glob path resolution.

- `off` → no-op
- deny glob match → `Sandbox.Denied`
- write outside writable roots → `Sandbox.Denied`
- `strict` read outside read roots → `Sandbox.Denied`

This is **not** a substitute for bwrap. Both must pass their tests independently.

---

## 11. Config

`opencode.json` / global config:

```jsonc
{
  "sandbox": {
    "profile": "workspace"
  }
}
```

`~/.opencode/sandbox.toml` and `<project>/.opencode/sandbox.toml`:

```toml
[profiles.hardened]
extends = "workspace"
restrict_network = true
deny = ["**/secrets/**"]
```

---

## 12. Failure and observability

Every wrap/deny publishes `SessionEvent` (or EventV2) with `{ profile, class, reason, backend }`.

Reasons: `unavailable` (no bwrap), `unsupported` (win32), `denied` (path), `glob_overflow`, `profile_mismatch`, `untrusted_project_profile`.

Never log the contents of denied files.

---

## 13. Definition of done (anti-fake gate)

All of these are live tests on Linux with system `bwrap`, not mocks:

1. `bash` workspace: write in Location ok; write `$HOME/opencode-sandbox-probe` → child EROFS/EACCES; host file **absent**.
2. deny: create `.env` in Location; `bash cat .env` fails; `read` tool on `.env` fails via `assertPath`.
3. `read-only`: `bash` `curl`/`python connect` → ENETUNREACH; in-process webfetch **not** wrapped (unit: wrapSpawn not called).
4. PTY started under workspace cannot write the probe file.
5. MCP stdio argv begins with `bwrap` when profile ≠ off (integration with a dummy `cat` server).
6. LSP **server** argv in `lsp/server.ts` begins with `bwrap` when profile ≠ off (not only `launch.ts`). Installer spawns stay unmarked-as-wrapped and carry `// sandbox:host`.
7. ripgrep/grep under workspace cannot read a denied `.env`.
8. Agent-facing spawn inventory test: no raw `Process.spawn` / `StdioClientTransport({ command })` / `pty.spawn` without `wrapSpawn` in the listed files **including `lsp/server.ts` language-server spawns**. Inventory is **regression**, not Done — Done still requires live bash EROFS (item 1).
9. win32 unit: `wrapSpawn` + create session with `workspace` fails `Unsupported`.
10. Resume with a different `--sandbox` fails.

If (1) can be made green by stubbing `AppProcess`, the test is illegal. Live bash tests use real `AppProcess` + real `bwrap`.
