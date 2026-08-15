# Capability Gap Roadmap

> **Status:** W1–W8h specced。2026-08-15 按可实现性审过一遍：下面 **Hard freeze** 压过各份 plan 里互相打架的句子。本文是索引，不要从这里直接开写代码。

**Goal:** 把对照 Codex / Grok Build / Hermes / Pi / oh-my-agent 后确认要补的能力，收成一条有序主线。当前 fork 在 tape / memory / loop-control 上已经超官方 OpenCode；缺口在安全执行、干活工具、可运营扩展。

**Not a goal:** 变成 OpenClaw / Hermes 那种个人助理 OS（gateway、IM 通道、桌面宠物、语音）。Browser / computer-use / skills hub 只做 coding-agent 需要的最小成熟面。

**Frozen while this program runs:** PromptTape 语义、memory 六缺口不变量、loop-control keep-list、Permission V1 兼容端、`applyCaching` sidecar（title/native/copy）。新能力只接 live V2 drain（`SessionV2 → SessionExecution → SessionRunner`）。禁止再开一条平行 drain / 平行 bash / 平行 permission。

**Loop is already live.** Abort / breaker / `/loop status` / timer pause 已在 session-owned drain 上工作。本路线图不把 loop 当半成品，也不在这些 PR 里重做 drain。W3 job 完成通知不得把已 abort 的 drain 叫醒成新一轮 user prompt。

---

## 0. 官方有没有 OS 级沙箱？

**没有。** `reference_opencode_agent` 与当前 fork 同一结论。

官方所谓 `sandboxes` 是 `project.sandboxes` 列：git worktree 路径数组，session/project 记录用，不是内核隔离。全树没有 landlock / seatbelt / bwrap / seccomp。CodeMode 的 “sandbox” 是 JS 解释器边界，明确不是 filesystem / process sandbox。

所以「补 OS 沙箱」不是追平官方，是 **对标 Codex / Grok、超过官方**。PermissionV2 + `assertWriteContained` + 可选 `git worktree` 留着，作为沙箱之上的策略层，不能假装已经隔离。

---

## 1. 怎么用这份文件

| 阶段 | 做什么 |
|---|---|
| 现在 | 只锁定范围、顺序、不变量、锚点 |
| 每开一条 | 单独 design + 细 plan + 证明测试；回这里把状态改成 `specced` / `in progress` / `done` |
| 禁止 | 把 12 条一次开写；为了绿测试削弱 live 路径；从 repo root 跑测试；动 `auth.json` / `LIVE_CACHE` |

测试一律：

```bash
cd packages/core && bun test --timeout 45000 <files>
cd packages/opencode && bun test --timeout 180000 <files>
```

---

## 2. Hard freeze（实现时以这里为准）

各份 2026-08-15 plan 里如果还写着「W1 没合也可以先 spawn」「TUI 面板以后再说」「Ctrl+G promote」「默认 sandbox = off」，那些句子作废。

### 2.1 一条 bash 执行链

Live V2 bash 只有 `packages/core/src/tool/bash.ts` 这一口 `execute`。顺序锁死：

```
classify → decide → PlanGate(W8b, 未落地则 no-op)
  → PermissionV2 → PreToolUse(W5, 未落地则 no-op)
  → wrapSpawn → BackgroundJob.start → AppProcess
  → PostToolUse
```

- W1 / W2 / W3 **分 PR 合入，但必须改同一条 execute**，禁止临时第二套 spawn 配方（`background-bash.ts`、V1 `shell.ts` 再 parse 一次、hooks 自己 `spawn` 不经 wrap）。
- W2 deny / W8b deny / Permission deny / PreToolUse deny：**不得** `BackgroundJob.start`。
- W2 deny → 不发 PreToolUse（命令从未“即将执行”）。
- Permission deny → `PermissionDenied` hook，不发 PreToolUse，不 execute。
- 删掉 W2「不阻塞 W1」、W3「W1 没合也 start」这类句子。顺序仍是 W1→W2→W3，因为后一条要插进前一条留下的槽，不是因为可以各写各的 spawn。

### 2.2 默认沙箱不能是 `off`

那是上次「接线了但生产关掉」的复刻。

| 平台 | 新 session 默认 | 缺后端 |
|---|---|---|
| Linux / Darwin | 目录已 trust → `workspace`；未 trust → `strict` | 非 `off` 且缺 `bwrap` / `sandbox-exec` → `Unavailable`，**禁止**降成 permission-only 或默默 `off` |
| Windows | 只能 `off`；请求其它 profile → `Unsupported` | 不假装 workspace |

显式 `OPENCODE_SANDBOX=off` 或 `config.sandbox.profile=off` 才能关。SQL 列 DEFAULT `'off'` 只服务 **迁移前的旧 session**；create 路径必须写入解析后的 profile，不能靠列默认。

### 2.3 一份信任门、一份 SSRF

`packages/core/src/trust.ts`（W1 PR 落地）是唯一 `trusted-folders.json`。W2 项目 `exec-policy.toml`、W5 项目 hooks、W8h 项目 skills、W1 项目 `sandbox.toml` 都读它。禁止三套 trust 文件。

`packages/core/src/net/deny-host.ts`（同一 PR 或第一个网络调用方落地）拒绝 loopback / link-local / `169.254.169.254` / metadata DNS。W5 项目 HTTP、W8f clone、W8g navigate、W8h install 共用。禁止各写一份 169.254 字符串。

### 2.4 实现顺序（可并行的只有不碰 bash.ts 的）

```
W1  Trust + deny-host + wrapSpawn + 默认 profile     ← 第一刀
W2  classify/decide 插进同一 bash.ts                  ← 必须在 W1 之后改 bash.ts
W3  BackgroundJob.start 插进同一 bash.ts              ← 必须在 W1+W2 之后
W4 / W8a                                              ← 几乎不碰 bash.ts，可与 W1 交错
W5 / W8b                                              ← 必须 W1+W2 已合；项目 hook 走 wrapSpawn
W6  本 PR 只交 git backend
W7  token trigger + checkpoint；uncompact 不得 SessionV2.prompt
W8c / W8d / W8e / W8f / W8g / W8h
```

禁止：同一切片里删 SessionPrompt / processor；为了绿测试把 live 路径改成 mock；16 条一起开写。

### 2.5 已核对过的假锚点（写进 plan，不要再踩）

| 假的 | 真的 |
|---|---|
| 只 wrap `lsp/launch.ts` | 语言服务器在 `packages/opencode/src/lsp/server.ts` 里大量 `spawn` / `Process.spawn`。安装器 `go install` / `gem install` / `dotnet tool install` 标 `// sandbox:host` |
| PTY 走 AppProcess | PTY 走 node-pty `#pty`。`wrapSpawn` 改 argv，再交给 `#pty` |
| Ctrl+G = promote | TUI `ctrl+g` 已是 `messages_first`（兼 leader）。**禁止抢 Ctrl+G**。promote 走 HTTP；TUI 另绑未占用键或 slash |
| `FileMutation.rename` 已存在 | 不存在。W4 要新增 |
| `missingAgentPermissions` 已是否 | 今天是 `* allow`（`packages/core/src/permission.ts`）。W2 **同一 PR** 改成 deny，并修假 agent 测试 |
| job 完成 `SessionV2.prompt` | 会 `terminal.reset`，把 `/loop abort` 冲掉。必须 **synthetic + `resume: false`** |
| SessionStart 用进程内 `Set` | 重连丢。要 session 列/元数据 |
| `code-mode.ts` 留作 wrapper | 删出 V1 registry，core `execute` 是唯一广告口 |
| `agent === "plan"` 当写门 | 唯一真相是 `session.plan_mode`。`switchAgent("plan")` 只同步这列 |
| W6 把 overlay/btrfs probe 当产品 | 本 PR 只交 git。probe 可以打日志，`acquire` 不得选未实现后端 |
| inventory grep 当 Done | 回归用。Done 要 live：bash 在 Location 外 EROFS、host 文件不存在 |

---

## 3. Workstreams

每条统一四栏：**现状 / 要对齐的 ref / 做成什么样 / 以后填充**。`以后填充` 留给细 plan，这里只写约束。

### W1 — OS 级沙箱

**Status:** specced + executable plan

- Design: `docs/superpowers/specs/2026-08-15-os-sandbox-design.md`
- Plan: `docs/superpowers/plans/2026-08-15-os-sandbox.md`

Host probe already passed (bwrap 0.6.1: EROFS outside bind, EACCES on deny bind-over, ENETUNREACH with `--unshare-net`). Windows non-`off` is `Unsupported`. **Default is not `off`.** Wrap `lsp/server.ts` server spawns, not only `launch.ts`. Missing bwrap on Linux = fail, no permission-only fallback. Trust + `deny-host` land in this PR.

---

### W2 — Exec policy + V2 bash 树解析

**Status:** specced + executable plan

- Design: `docs/superpowers/specs/2026-08-15-exec-policy-design.md`
- Plan: `docs/superpowers/plans/2026-08-15-exec-policy.md`

Must land in the **same** `bash.ts` execute after W1. No Starlark. Policy-ask ignores Permission `* allow`. Missing AgentV2 → deny（今天 `missingAgentPermissions` 仍是 `* allow`，本 PR 翻掉）。Opaque：sandbox ≠ `off` → **deny**；仅 `off` 才 ask。V1 `packages/opencode/src/tool/shell.ts` parser **迁进 core**，不留第二份。

---

### W3 — 后台 bash

**Status:** specced + executable plan

- Design: `docs/superpowers/specs/2026-08-15-background-bash-design.md`
- Plan: `docs/superpowers/plans/2026-08-15-background-bash.md`

复用已有 `BackgroundJob`（`packages/core/src/background-job.ts` + opencode instance wrapper），不新建 `BashJob`。`promote` 已是「前台不再 wait」，不是新语义。W2 deny 不得 `start`。Job 完成 admit 必须 **synthetic + `resume: false`**。TUI **禁止 Ctrl+G**。必须 W1+W2 已合进同一 execute。

---

### W4 — V2 edit fuzzy + apply_patch move

**Status:** specced + executable plan

- Design: `docs/superpowers/specs/2026-08-15-edit-patch-design.md`
- Plan: `docs/superpowers/plans/2026-08-15-edit-patch.md`

V1 `replace()` 梯子 byte-for-byte 迁进 `packages/core/src/tool/edit-match.ts`（0.65 阈值不许“改进”）。`FileMutation.rename` **今天不存在**，本 PR 新增。`apply_patch` 去掉 move 硬拒。几乎不碰 `bash.ts`，可与 W1 交错。

---

### W5 — 用户 / 项目级 lifecycle hooks

**Status:** specced + executable plan

- Design: `docs/superpowers/specs/2026-08-15-lifecycle-hooks-design.md`
- Plan: `docs/superpowers/plans/2026-08-15-lifecycle-hooks.md`

唯一总线：live `ToolRegistry.settleWith`。禁止把 V1 `session/tools.ts` / `plugin.trigger` 当产品。Plugin 用 `Hooks.register`。Timeout/坏 JSON = deny。Folder trust **复用 W1 `Trust.Service`**。项目 hook 命令走 `wrapSpawn("workspace-child")`（故 W5 不得早于 W1）。TUI 必须列出已加载 hooks + 上次 deny，不是「API 先有、面板以后」。SessionStart 门闩要 **持久化**，不能只靠进程内 `Set`。

**现状:** 只有 plugin 内部 `ctx.tool.hook("execute.before")`。没有 `~/.opencode/hooks/`，没有 Claude/Cursor 兼容事件，不能用 shell 拦命令或改完 format。oh-my-agent 已经把 OpenCode 当被投影 vendor——没有一等 hooks，外部 harness 会继续绕过 runtime。

**Ref:** Grok 三层（global / project / plugin）+ Claude `settings.json` + Cursor `hooks.json`，可 block；Codex hooks crate + JSON schema；oh-my-agent 的 OpenCode in-process plugin 是兼容目标，不是安全模板。

**做成什么样（安全是关门条件，不是附录）:**

1. **一等事件（第一波就齐）:** `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `Stop` / `SubagentStart` / `SubagentStop`。缺事件就再开一版，不要先做一个“能跑的 before hook”糊弄过去。
2. **三层发现:** `~/.opencode/hooks/`、`<project>/.opencode/hooks/`、plugin 打包 hooks。合并顺序与冲突规则写死。
3. **兼容导入:** Claude `settings.json` / Cursor `hooks.json` 只做 **适配器**，内部规范是我们自己的 schema（版本字段、JSON Schema、strict unknown-key reject）。
4. **能 block:** `PreToolUse` 可 `allow | deny | ask`。deny 必须短路径失败，工具不得执行。
5. **信任边界:**
   - 全局 hooks：用户自己的，默认信任。
   - 项目 hooks：必须 **folder trust** 之后才加载。未信任项目 = 忽略项目 hooks，并在 TUI 明示。
   - plugin hooks：跟 plugin 同一权限/签名/来源策略，不能比 plugin 工具更宽。
6. **执行隔离:** 项目 hook 默认在 W1 sandbox + W2 policy 里跑。禁止项目 hook 静默拿到宿主无限制 shell。hook 超时、无网络（除非声明）、stdout 大小上限。
7. **默认 fail-closed:** hook 超时 / 非 0 / 无法解析 → **block** 对应工具（Grok 的 fail-open 明确不抄）。`SessionStart` 失败 → session 不进入可跑工具状态。提供显式 `unsafe.hooks.failOpen` 仅供 CI，默认关。
8. **防绕过:** 所有 live 工具结算（core builtins、DynamicTools/MCP、plugin tools、CodeMode 内调用）必须经过同一 hook 总线。禁止 V1 适配器另开一口。
9. **可审计:** 每次 hook 决策写 event（name、source、decision、duration）。TUI 能列出已加载 hooks 与上次 deny。
10. **威胁扫描:** 加载前扫 hook 脚本/命令，复用 `scanForThreatsInScope`。

**以后填充:** schema、matcher（工具名/argv 前缀）、command vs HTTP hook、与 oh-my-agent 投影的共存测试、密钥红线。

---

### W6 — Worktree engine

**Status:** specced  
Design: `specs/2026-08-15-worktree-engine-design.md` · Plan: `plans/2026-08-15-worktree-engine.md`  
本 PR **只交 git backend**。probe 可以探测 overlay/btrfs/reflink 并打日志，`acquire` 不得选用未实现后端当产品。`worktree-pool.ts` 换成 engine 调用，不留第二套 pool。Git spawn `// sandbox:host`。

### W7 — Compaction tighten

**Status:** specced  
Design: `specs/2026-08-15-compaction-tighten-design.md` · Plan: `plans/2026-08-15-compaction-tighten.md`  
Token trigger 在 `context-engine.ts`（今天 50%+30 steps）。Checkpoint / uncompact 不得弄坏 PromptTape keep-list。Live compact 入口是 runner + `session/compaction.ts`；W5 Pre/PostCompact 打同一入口。`uncompact` 直接 restore store，**禁止** `SessionV2.prompt`（会 reset loop abort）。

### W8a list_dir

**Status:** specced · `specs/2026-08-15-list-dir-design.md` · `plans/2026-08-15-list-dir.md`  
Reuse read’s ListPage. No `ls`.

### W8b Plan write gate

**Status:** specced · `specs/2026-08-15-plan-write-gate-design.md` · `plans/2026-08-15-plan-write-gate.md`  
唯一真相：`session.plan_mode`。`switchAgent("plan")` 只同步这列，bash **不得**用 agent id 当门。bash 必须走 W2 树解析（`printf > src/` 才是真绕过）。`FileMutation` 无 sessionID → 在 write/edit/apply-patch/**bash** 站点 assert。必须 W2 已合。

### W8c MCP tool_search

**Status:** specced · `specs/2026-08-15-mcp-tool-search-design.md` · `plans/2026-08-15-mcp-tool-search.md`  
>8 MCP tools: advertise search+use; settle still has real names for hooks.

### W8d CodeMode V2

**Status:** specced · `specs/2026-08-15-codemode-v2-design.md` · `plans/2026-08-15-codemode-v2.md`  
删 `experimentalCodeMode` 门。嵌套调用走 `settle`。**删除** V1 `code-mode.ts` 广告，不许留第二广告口。

### W8e Review loop

**Status:** specced · `specs/2026-08-15-review-loop-design.md` · `plans/2026-08-15-review-loop.md`  
不是 done-claim verifier。坏 JSON ≠ pass。Merge gate 依赖 W6；W6 未合则 gate 测 double，不假装已 merge。

### W8f repo_clone / overview

**Status:** specced · `specs/2026-08-15-repo-tools-design.md` · `plans/2026-08-15-repo-tools.md`  
Cache.ensure + **共享** `Net.denyHost`。overview bounded，不 bash。

### W8g Browser (min)

**Status:** specced · `specs/2026-08-15-browser-min-design.md` · `plans/2026-08-15-browser-min.md`  
Optional Host；默认 CI 无 Chromium。metadata URL 走共享 `Net.denyHost`。不是 computer_use。

### W8h Skills lock

**Status:** specced · `specs/2026-08-15-skills-lock-design.md` · `plans/2026-08-15-skills-lock.md`  
Install → quarantine → trust+scan → active。`file:` install 拒绝。项目 skills 走同一 `Trust.Service`。无 marketplace。

---

## 4. 跨条不变量

1. **一层 live 路径。** 新工具进 `packages/core/src/tool` + `BuiltInTools.node`。V1 模块只当迁出源，不接回 drain。
2. **一条 bash execute。** 见 §2.1。没有“先另写一条，W1 合了再接”。
3. **安全交叠。** `sandbox ∩ exec-policy ∩ hooks ∩ permission ∩ plan-gate`，任一 deny 即 deny。没有“hooks 过了就跳过 sandbox”。
4. **项目不可信直到 trust。** 一份 `Trust.Service`。未信任项目：忽略项目 hooks / 项目 skills / 项目 `exec-policy.toml` / 项目 `sandbox.toml`，并打点。
5. **缺能力不装死。** 内核不支持的 sandbox profile、Windows 非 `off`、未实现的 worktree 后端必须失败或显式拒绝，禁止 silently `off` / 假装 overlay。
6. **keep-list 不动。** tape origin-once、429 identical compiled、memory flush-on-compact、task_id resume、untrusted framing——新功能证明测试不得删这些。
7. **Loop abort 不被旁路冲掉。** 任何 synthetic admit（job 完成、hook 通知）必须 `resume: false`。`SessionV2.prompt` 且 `resume !== false` 会 `terminal.reset`。
8. **Hard bans 继续有效。** 不把 PromptTape 接回 V1 loop；不 rename `SessionV2`→`Session` 夹在这些 PR 里；不 finalize LLM bash/read/task 当成功；不用 Progress tail 当 Truncate；不 restore `runLoop`；不把 drain 包进 `Effect.uninterruptible`。

---

## 5. 明确不做（本路线图）

- 消息网关 / 多 IM 通道
- 语音、image/video 生成当核心工具
- Windows AppContainer（可后补）
- Codex Starlark execpolicy 原文、Guardian 强制二模型放行
- 把 oh-my-agent 30 角色人格做进 core
- 从零重写 compaction 替代 v3（只收紧）
- 开平行 SessionProcessor / 平行 bash

---

## 6. 填充记录

某条开始写 design 时，在这里挂上路径和日期。

| ID | Design | Detail plan | Status |
|---|---|---|---|
| W1 | `specs/2026-08-15-os-sandbox-design.md` | `plans/2026-08-15-os-sandbox.md` | specced |
| W2 | `specs/2026-08-15-exec-policy-design.md` | `plans/2026-08-15-exec-policy.md` | specced |
| W3 | `specs/2026-08-15-background-bash-design.md` | `plans/2026-08-15-background-bash.md` | specced |
| W4 | `specs/2026-08-15-edit-patch-design.md` | `plans/2026-08-15-edit-patch.md` | specced |
| W5 | `specs/2026-08-15-lifecycle-hooks-design.md` | `plans/2026-08-15-lifecycle-hooks.md` | specced |
| W6 | `specs/2026-08-15-worktree-engine-design.md` | `plans/2026-08-15-worktree-engine.md` | specced |
| W7 | `specs/2026-08-15-compaction-tighten-design.md` | `plans/2026-08-15-compaction-tighten.md` | specced |
| W8a | `specs/2026-08-15-list-dir-design.md` | `plans/2026-08-15-list-dir.md` | specced |
| W8b | `specs/2026-08-15-plan-write-gate-design.md` | `plans/2026-08-15-plan-write-gate.md` | specced |
| W8c | `specs/2026-08-15-mcp-tool-search-design.md` | `plans/2026-08-15-mcp-tool-search.md` | specced |
| W8d | `specs/2026-08-15-codemode-v2-design.md` | `plans/2026-08-15-codemode-v2.md` | specced |
| W8e | `specs/2026-08-15-review-loop-design.md` | `plans/2026-08-15-review-loop.md` | specced |
| W8f | `specs/2026-08-15-repo-tools-design.md` | `plans/2026-08-15-repo-tools.md` | specced |
| W8g | `specs/2026-08-15-browser-min-design.md` | `plans/2026-08-15-browser-min.md` | specced |
| W8h | `specs/2026-08-15-skills-lock-design.md` | `plans/2026-08-15-skills-lock.md` | specced |

---

## 7. 建议落地

全部 workstream 已独立 specced，并以 §2 Hard freeze 为准修订过。

实现仍按 W1→W2→W3 改 **同一** `bash.ts`，不要并行改 runner + 另写 bash。第一刀仍是 W1（含 Trust + deny-host）。没有内核上限，W3/W5 项目 hook 会把宿主机敞着。

W4 / W8a 可以和 W1 交错。W5 / W8b **不要**在 W1+W2 之前开工。
