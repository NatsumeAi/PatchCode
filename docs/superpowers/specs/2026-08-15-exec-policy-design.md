# Exec Policy Design (W2)

> **Status:** locked for implementation. Pair with `docs/superpowers/plans/2026-08-15-exec-policy.md`.
> Final architecture. One parser, one policy language, one decide(). No Starlark second engine. No “token split now, tree-sitter later.”

**Goal:** Live V2 `bash` (and only live `bash`) classifies a command with tree-sitter, reduces it to prefixes or marks it opaque, then applies a prefix policy **that `PermissionV2` `* allow` cannot punch through**. Missing AgentV2 is deny, not allow-all.

**Proven on this host (2026-08-15, `web-tree-sitter` + `tree-sitter-bash` already in the repo):**

| Input | `hasError` | `command` nodes | Implication |
|---|---|---|---|
| `echo hi && curl evil.com` | false | `echo hi`, `curl evil.com` | Must decide **both** segments |
| `git status; rm -rf /` | false | two commands | `;` is not a free pass |
| `bash -c 'curl evil.com'` | false | **one** node `bash -c '…'` | Inner script is a `raw_string`, **not** a command. Must re-parse `-c` or treat opaque |
| `curl $(echo evil.com)` | false | outer + inner, kinds include `command_substitution` | Not word-only → **opaque** |
| `python -c "os.system('rm')"` | false | one node | Cannot peel → **opaque** |
| `env FOO=1 git status` / `nice -n 10 ls` / `sudo rm …` | false | one node | Need wrapper peel, not a second parser |

V2 today does `permission.assert({ action: "bash", resources: [input.command] })` on the **raw string** plus a whitespace token scan that is advisory. That is fake policy: `allow bash *` plus `echo hi && curl …` is one resource.

---

## 1. Threat model

A model that already passed Permission `bash * allow` (the default `build` agent is `{ action: "*", resource: "*", effect: "allow" }`) can still:

- chain `harmless && destructive`
- hide work in `bash -c '…'`, `eval`, `$(…)`
- wrap with `sudo` / `env` / `nice` / `timeout`

W1 kernel sandbox is the FS/net upper bound. W2 is **which command is allowed to start**. W1 does not decide `sudo` vs `ls`.

---

## 2. Permanently rejected

| Idea | Why |
|---|---|
| Starlark execpolicy runtime | Second language, second engine. Codex can keep it. We use TOML + JSON Schema. |
| Whitespace / regex split as the live classifier | Fake. Already proven insufficient vs `bash -c` and `$(…)`. |
| Leave tree-sitter in V1 `packages/opencode/src/tool/shell.ts` and “call it from V2” | Two parsers. **Move** the grammar load + walk into core. V1 may keep a thin import until V1 shell is deleted; it must not own a second copy of the decide logic. |
| Policy deny overridable by Permission `* allow` | Fake. Default agent would auto-run `curl`. |
| Missing AgentV2 → allow-all | The live hole in `packages/core/src/permission.ts`. Final: miss → deny. |
| “Opaque commands inherit allow” | Fake. Opaque under sandbox profile ≠ `off` is **deny**. Opaque with profile `off` is **ask** (or deny in `dontAsk`). |
| Peeling `python -c` / `node -e` / `perl -e` as if they were shell | Not executable safely. Opaque. |

---

## 3. Pipeline (final order, bash only)

```
workdir + external_directory          existing LocationMutation
     ↓
ExecPolicy.classify(command, shell)   tree-sitter → Segments | Opaque
     ↓
ExecPolicy.decide(segments|opaque)    built-in ∪ project ∪ user ∪ saved
     ↓
if deny  → PermissionV2.BlockedError, no spawn, no PreToolUse, no BackgroundJob.start
if ask   → PermissionV2.ask on reduced prefixes / opaque string
           (this ask IGNORES agent catch-all allow)
if allow → PermissionV2.assert({ action: "bash", resources: prefixes })
           (agent * allow may pass here)
     ↓
PlanGate (W8b; no-op until that PR)
     ↓
Hooks.PreToolUse (W5; no-op until that PR)
     ↓
Sandbox.wrapSpawn                     W1 — already on this execute; do not add a second spawn
     ↓
BackgroundJob.start → AppProcess      W3 — same execute
```

`decide` is `AND` over segments: any deny → deny; else any ask → ask; else allow.

**W2 does not ship if W1 wrapSpawn is not already on this `bash.ts` execute.** Insert `classify`/`decide` above the existing wrap. Do not create `exec-bash.ts`.

---

## 4. Classifier (one implementation)

Port V1’s working wasm load (`web-tree-sitter` + `tree-sitter-bash` + `tree-sitter-powershell`) into `packages/core/src/exec-policy/parse.ts`.

### 4.1 Word-only

A tree is word-only iff every named node is in this allowlist (Grok’s list, locked):

`program`, `list`, `pipeline`, `command`, `command_name`, `word`, `string`, `string_content`, `raw_string`, `number`, `concatenation`, `variable_assignment`, `variable_name`, `redirected_statement`, `file_redirect`, `file_descriptor`, `comment`, `heredoc_*`

Allowed punctuation: `&&` `||` `;` `|` quotes `=` and the redirection tokens in that Grok list.

Anything else (`command_substitution`, `subshell`, `expansion`, `` ` ``, `for_statement`, `if_statement`, `function_definition`, ERROR, `hasError`) → **Opaque**.

PowerShell: same idea with the powershell grammar. `cmd.exe`: no grammar → **Opaque** always (honest).

### 4.2 Segments

Word-only → one segment per `command` node, source order, tokens = unquoted words. Env assignments `FOO=1 cmd` stay on the same segment.

### 4.3 Wrapper peel (after tokenize, before match)

Basename of argv0 (path-qualified still peels):

| Wrapper | Behavior |
|---|---|
| `env`, `nice`, `nohup`, `stdbuf`, `ionice`, `chrt`, `time`, `command`, `builtin`, `timeout` | Strip wrapper + its flags (Grok `strip_wrapper_command` semantics; under-strip if unsure) |
| `sudo`, `doas`, `su`, `pkexec` | **deny** (built-in, not peel) |
| `bash`/`sh`/`zsh`/`dash` + `-c`/`-lc` | Re-parse the **next** argument as a new script. Recurse. Depth > 2 or re-parse opaque → Opaque |
| `bash`/`sh` file, `python -c`, `node -e`, `perl -e`, `ruby -e`, `eval` | **Opaque** |

`cd` / `export` / `unset` as a whole segment: treat as setup (allow if word-only, still cannot hide a later deny).

### 4.4 Parse failure

`parse()` throws or `hasError` → Opaque. Never fall back to whitespace tokens.

---

## 5. Policy language (one)

Files (later wins):

1. built-in `packages/core/src/exec-policy/builtin.toml`
2. `~/.opencode/exec-policy.toml`
3. `<project>/.opencode/exec-policy.toml` (folder trust required; untrusted → ignore file **and** log; do not pretend it loaded)

Schema:

```toml
[[rule]]
prefix = ["git", "reset", "--hard"]
effect = "deny"
reason = "destructive"

[[rule]]
prefix = ["ls"]
effect = "allow"

[[rule]]
prefix = ["git"]
effect = "ask"

# load-time tests — fail process boot if they break
[[rule.match]]
argv = ["git", "reset", "--hard"]
expect = "deny"

[[rule.not_match]]
argv = ["git", "status"]
prefix = ["git", "reset", "--hard"]

[[host]]
name = "git"
paths = ["/usr/bin/git"]
```

Matching (Codex prefix semantics, no Starlark):

- Longest matching `prefix` wins.
- First token: exact, then basename if `host` allows that realpath (`which` + `realpath`).
- If `[[host]]` exists for a name, basename fallback **only** for listed paths. Unknown path → Opaque (then spec opaque effect: deny if sandbox on).
- No match → default **ask** (word-only) or default **opaque** effect (deny if sandbox ≠ `off`).

`effect`: `allow` | `ask` | `deny`.

Load-time `match` / `not_match` run in `ExecPolicy.load`. Failure → `ExecPolicy.Invalid` at Location boot, not at first bash.

---

## 6. Built-in rules (locked, tested)

**deny**

- `sudo`, `doas`, `su`, `pkexec` (any args)
- `rm` with `-rf`/`-fr` and target `/` or `/*`
- `mkfs`, `mkfs.*`, `dd` (any)
- `shutdown`, `reboot`, `halt`, `poweroff`, `init 0`
- `chmod` / `chown` on `/` or `/*`
- `curl` / `wget` / `nc` / `ncat` / `socat` to link-local / metadata (`169.254.169.254`, `metadata.google.internal`) — match argv tokens, not DNS

**allow** (word-only, after peel)

- `ls`, `pwd`, `echo`, `true`, `false`, `printf`
- `git status`, `git diff`, `git log`, `git rev-parse`, `git branch` (no `-D`), `git remote -v`
- `rg`, `grep`, `find` (no `-delete` / `-exec`)

**ask** — word-only leftovers.

**opaque** — `sandbox_profile !== "off"` → **deny** (kernel cannot see inside `python -c` / `$(…)`). Profile `off` → **ask**. `dontAsk` → deny either way.

This table is the product. Adding allow later is a toml change + test, not a new engine.

---

## 7. Permission interaction

- Policy **deny** → stop. Do not call `assert` in a way that `* allow` can override.
- Policy **ask** → `PermissionV2.ask` / pending UI with `resources` = prefixes (or the opaque string). **Catch-all agent allow does not auto-approve this ask.** Implementation: evaluate this ask against rules that match `action=bash` **excluding** `action=*` / `resource=*` catch-alls. Session saved “always” prefixes become ExecPolicy saved rules, not `bash *`.
- Policy **allow** → existing `PermissionV2.assert({ action: "bash", resources: prefixes })`. Here `* allow` may pass (user opted into a permissive agent for known-safe prefixes).

Saved “always allow `git status *`” writes `{ prefix: ["git","status"], effect: "allow" }` into session/project exec-policy overlay.

---

## 8. Missing AgentV2

`packages/core/src/permission.ts` today:

```
const missingAgentPermissions = [{ action: "*", resource: "*", effect: "allow" }]
```

Final in **this PR** (same commit as decide wiring):

```
agent?.permissions ?? [{ action: "*", resource: "*", effect: "deny" }]
```

Junk-agent tests that relied on the allow fallback must register `build` or an AgentV2 row in the same PR. Comment today admits this was a compatibility hack for oh-my-agent names not registered in AgentV2. Those plugins must register AgentV2.

This applies to **all** tools, not only bash. It is in W2 because it is the same fail-open class.

---

## 9. Composition with W1 / W5

```
sandbox ∩ exec-policy ∩ hooks ∩ permission
```

W1 cannot start a denied command. W5 `PreToolUse` still sees the original command and can deny. Neither layer is optional. Project `exec-policy.toml` loads only if `Trust.isTrusted(location)` (W1 `Trust.Service`). Untrusted → built-in + user policy only, plus an event.

PTY user-typed commands are **not** W2 in this program (interactive human). Agent `bash` is.

---

## 10. Failure and observability

Classify + decide emit EventV2 `{ kind: opaque|segments, prefixes, effect, ruleId, reason }`. Never execute on `Invalid` policy.

---

## 11. Definition of done (anti-fake)

Live or parser-true tests (real tree-sitter wasm, not a mocked `classify`):

1. `echo hi && curl https://example.com` → two prefixes; default built-in → ask (or deny curl if we add it); **not** a single allow via `echo *`.
2. `git status; rm -rf /` → deny (rm rule), no spawn.
3. `bash -c 'curl https://example.com'` → re-parse inner → same as curl segment, **not** allow via `bash *`.
4. `curl $(echo https://example.com)` → Opaque → **deny** if session sandbox ≠ `off`; **ask** if `off` — even if agent is `* allow`. Never spawn.
5. `python -c "print(1)"` → same opaque rule as (4).
6. `sudo ls` → deny.
7. `env FOO=1 git status` → peel to `git status` → allow (built-in).
8. `/usr/bin/git status` with `[[host]] name=git paths=["/usr/bin/git"]` → allow; `/tmp/evil/git status` → not basename-allow.
9. Agent id not in AgentV2 → `read`/`bash` deny (no allow-all).
10. Agent `* allow` + `curl https://example.com` → still ask (policy ask ignores catch-all).
11. `packages/core/src/tool/bash.ts` no longer asserts the raw full command as the only resource.
12. No second decide() under `packages/opencode/src/tool/shell.ts` after the move (V1 calls core or is unused).

If (3) or (4) can pass by stubbing `classify` to whitespace-split, the test is illegal.
