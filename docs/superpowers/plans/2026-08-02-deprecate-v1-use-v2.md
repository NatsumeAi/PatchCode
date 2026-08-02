# 彻底弃用 V1、V2 转正 Implementation Plan（完整版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 V2 Session Core（`SessionV2.prompt` → `SessionRunner`）成为唯一运行路径，HTTP/TUI/子代理全部切到 V2，V1（`packages/opencode/src/session/*` 的 `SessionPrompt.runLoop` 主路径）彻底退役。

**Architecture:** 现状双轨：HTTP `session.prompt`/`prompt_async`/`command`/`shell`/`revert` 全部指向 v1 `SessionPrompt.Service`（实际运行）；v2（`SessionV2` + `SessionRunner`/`runner/llm.ts`）已注册进 server 进程（`SessionV2.node`/`SessionExecution.node`）但 `SessionV2.prompt` 无 HTTP 调用方。本 plan 把 HTTP 入口逐个切到 `SessionV2` 接口，功能等价验证后摘除 v1 服务注册。loop-control 8 机关（挂在 v2 runner hooks）随 v2 转正自动激活，零改动。

**Tech Stack:** Effect（v2 全 Effect 服务）、`@opencode-ai/schema/prompt-input`（v2 prompt 输入）、HTTP API（effect/unstable/httpapi）、SessionV2（`packages/core/src/session.ts`）、SessionRunner（`packages/core/src/session/runner/llm.ts`）

## Global Constraints

- 测试从包目录跑（`packages/opencode` / `packages/core`）；`TMPDIR=/home/huyongjun/tmp-opencode`（根分区满）
- 不删 v1 代码文件（退役 = 摘运行路径）；不引入新依赖
- 不用 `as any`；Effect 遵循仓库 AGENTS.md（`Effect.fn`、`Effect.forkIn(scope)`）
- commit：`feat/fix(core|opencode): ...`，用户明确要求才 commit
- **上下文管理压缩改造不在本 plan**（见 `2026-08-02-context-management-design.md`，作为 Task 9 的输入）
- 每个 Task 独立可验证；**四个"停下报告"点**：Task 3（subtask 映射）、Task 6（子代理异步化方案）、Task 7（TUI 事件流）、Task 8（v1 独有功能失活：reminders/summarize/SessionRunState）
- 发现 v1 有 v2 无的功能缺口 → 停下报告，不自行补 v2

## 关键映射事实（已调研，实施时直接用）

### 输入映射（v1 → v2）

| v1 `SessionPrompt.PromptInput`（prompt.ts:1613） | v2 `SessionV2.prompt` 输入 | 处理 |
|---|---|---|
| `sessionID` | `sessionID` | 直通 |
| `messageID` | `id?: SessionMessage.ID` | 直通 |
| `model`（临时指定） | **无**（v2 用 session.model） | **先 `switchModel`** 再 prompt；或接受 session 当前模型（默认行为） |
| `agent`（临时指定） | **无**（v2 用 session.agent） | **先 `switchAgent`** 再 prompt |
| `variant` | 无 | 忽略（v2 模型 variant 在 session.model.variant） |
| `noReply` | 无 | 映射 `delivery` 语义或忽略（TUI 未用，确认） |
| `format` | 无 | 忽略（v2 无 json_schema 模式）——**确认 TUI 是否用** |
| `system` | 无 | 忽略（v2 系统提示走 ContextEpoch） |
| `tools`（deprecated） | 无 | 忽略 |
| `parts[].text` | `prompt.text` | 直通 |
| `parts[].file` | `prompt.files[]`（FileAttachment：`{uri, name?, description?, source?}`，`schema/prompt-input.ts:8-13`） | 映射（v1 FilePartInput 字段 → uri/name；source 保持） |
| `parts[].agent`（AgentPart） | `prompt.agents[]`（AgentAttachment） | 映射 |
| `parts[].subtask`（SubtaskPart） | **无** | **Task 3 专题** |

### 输出映射（v1 → v2）

| v1 | v2 | 影响 |
|---|---|---|
| `prompt()` 返回 `SessionV1.WithParts`（**同步含结果**） | `SessionV2.prompt()` 返回 `SessionInput.Admitted`（**异步 wake**） | **Task 6 子代理的核心改动**；HTTP `prompt`（同步端点）行为变化——TUI 用 `session.prompt`（TUI component/prompt/index.tsx:1094），需验证异步返回下的客户端行为（消息落库由事件驱动，TUI 靠事件流刷新，prompt 返回体主要用于错误/确认） |
| `promptSvc.shell()` | `SessionV2.shell()` —— **stub**（session.ts:387-389） | **非直通**——见 Task 2 停下报告点 |
| `promptSvc.command()`（subtask） | 无 | Task 3 |
| `revertSvc.revert/unrevert` | `SessionV2.revert.stage/clear/commit` | unrevert = `clear`（语义对照确认） |
| `compactSvc.create + promptSvc.loop` | `SessionV2.compact({...})` —— **stub**（session.ts:417-420） | **非直通**——见 Task 5 停下报告点；且该组合实为 **summarize handler**（非独立 compact 端点） |
| `prompt.cancel(sessionID)`（control-plane/workspace.ts:584） | `SessionV2.interrupt(sessionID)` | 直通 |

### 子代理 ops（Task 6 基础）

v1 `ops` 工厂（prompt.ts:171-178）：`cancel / resolvePromptParts / prompt`（`TaskPromptOps`）。
v2 化后：`resolvePromptParts` 不变（本地拼 parts）；`prompt` 改调 `SessionV2.prompt`（admit + wake）→ **子代理结果获取改异步**：admit 后 `session.wait(childSessionID)`（v2 wait 等 drain 结束）或订阅子会话事件；`cancel` → `SessionV2.interrupt`。

### 事件流（Task 7 重点）

- v1：`EventV2Bridge`（`@opencode/EventV2Bridge`）把 v1 SessionEvent 转 EventV2 给 client
- v2：`SessionV2.events/history`（durable DurableEvent stream，`session.ts:133`）
- TUI 依赖的客户端事件（message 增量/状态/tool 事件）在 v2 路径下由 `SessionRunner` 的 `publish-llm-event.ts` + durable 事件投影产生——**Task 7 必须端到端验证 TUI 全功能事件流**

### v2 未实现清单（全库 stub 扫描——session.ts 逐方法核实）

**4 个 stub（直接抛 OperationUnavailableError）**：
| 方法 | 位置 | 影响 |
|---|---|---|
| `shell` | session.ts:387-389 | Task 2 停下报告点 |
| `skill` | session.ts:390-392 | **Task 3 注意**：slash skill 命令若映射到 SessionV2.skill 会撞 stub |
| `compact` | session.ts:417-420 | Task 5 停下报告点 |
| `wait` | session.ts:421-424 | Task 6 已改用事件订阅 |

其余全部实装：create/get/list/messages/message/context/events/history/prompt/switchAgent/switchModel/active/resume/interrupt/revert.{stage,clear,commit}

### HTTP 端点 × 归属矩阵（27 端点全量核实）

| 端点 | 服务 | 归属 |
|---|---|---|
| list / status / get / children / todo / diff / messages / message / create / delete / update / fork / share / unshare | v1 CRUD 层（session/todo/summary/share） | **保留**（不摘除——数据层 CRUD，TUI 依赖） |
| **abort** | **`promptSvc.cancel`（v1 运行路径）** | **切换 → `SessionV2.interrupt`**（⚠️ 补审发现：plan 原只覆盖 control-plane/workspace.ts 的 cancel，HTTP abort 端点遗漏——**归入 Task 7**） |
| summarize | `compactSvc.create + promptSvc.loop` | Task 5 stub 决策 |
| prompt / prompt_async | `promptSvc.prompt` | Task 1 切换 |
| command | `promptSvc.command` | Task 3 |
| shell | `promptSvc.shell` | Task 2 stub 决策 |
| revert / unrevert | `revertSvc` | Task 4 |
| permission.respond | `permissionSvc.reply` | Task 4 验证 |
| deleteMessage / part.delete / part.update | v1 Session CRUD | 保留 |
| init | 待 Task 7 确认（workspace 初始化，不涉运行路径） | 确认归属 |

**摘除范围 = 运行路径服务（SessionPrompt/compactSvc 相关）；保留范围 = CRUD 数据层。**

### v1 独有运行路径功能（转正后失活风险，逐一确认）

| v1 功能 | 位置 | v2 等价 | 处置 |
|---|---|---|---|
| `SessionReminders.apply`（对话中插入切换提醒） | prompt.ts:1207 每轮调用 | **无**（v2 runner 无 reminders） | 转正后失活——**需用户决策：接受失活 / 移植 / 后置**（Task 8 停下报告点） |
| `summary.summarize`（step==1 自动摘要） | prompt.ts:1280 | **无**（v2 无 step-1 摘要钩子） | 同上 |
| `SessionRunState`（运行态协调器：assertNotBusy/cancel/ensureRunning） | run-state.ts，被 revert.ts 等消费 | v2 用 `SessionExecution.interrupt` + `SessionV2.revert` 部分覆盖；cancelBackgroundJobs/ensureRunning 无直接对应 | Task 8 逐一标注"v2 等价=...或停下报告" |
| `permission.respond`（HTTP 端点） | groups/session.ts:403 → `permissionSvc.reply` | v2 有 `PermissionV2`/`QuestionV2`（llm.ts 已处理 DeclinedError/RejectedError） | **Task 4 一并验证**：v2 路径下权限问答的回复是否走同一 HTTP 端点（Permission.Service 是否 v1/v2 共用）——不共用的部分停下报告 |

---

### Task 1: HTTP prompt / prompt_async 切到 SessionV2.prompt

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`（`prompt`/`promptAsync`）
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`（`PromptPayload`）
- Test: `packages/opencode/test/` HTTP 层现有 prompt 测试 + 新增 v2 断言

**Interfaces:**
- Consumes: `SessionV2.Service.prompt({ sessionID, prompt: PromptInput.Prompt, delivery?, resume? })` → `Admitted`
- Produces: 无 v1 依赖的 `prompt`/`promptAsync` handler

- [ ] **Step 1: 基线**：跑现有 HTTP prompt 测试（`TMPDIR=/home/huyongjun/tmp-opencode bun test` from `packages/opencode`），记录 v1 行为
- [ ] **Step 2: 写失败测试**：`session.prompt` 提交 → 断言 `SessionInputTable` 出现 admitted 行 + `SessionEvent.Prompted` 发出 + 消息经 `SessionMessageTable` 投影
- [ ] **Step 3: 实现切换**：`promptSvc.prompt` → `v2Svc.prompt`；payload 映射（text/files/agents，model/agent → 先 switchModel/switchAgent）；`promptAsync` 同步切
- [ ] **Step 4: 跑测试** + 真实 TUI 冒烟（tmux 起 `bun dev`，发消息，确认消息上屏、事件流正常）
- [ ] **Step 5: 检查 TUI 同步端点的客户端行为**：TUI `sdk.client.session.prompt`（component/prompt/index.tsx:1094）返回体依赖——v1 返回 `WithParts`（同步含结果）切 v2 `Admitted`（异步）后，检查 TUI 是否依赖返回体结构。**验收失败标准（终审 A-P1-5）**：grep `session.prompt` 的返回类型消费方 + `WithParts` 引用——若 TUI/SDK 依赖同步 WithParts 结构（非事件驱动刷新）→ **停下报告**；`sdk/client` 类型定义如需同步调整，按 AGENTS.md 用 `./packages/sdk/js/script/build.ts` 再生成
- [ ] **Step 6: Commit**（用户确认后）

### Task 2: shell —— ✅ 用户决策：a 实现（SessionV2.shell 从 stub 实装）

**Files:**
- Modify: `packages/core/src/session.ts`（`shell` L387-389 从 stub 实装）
- Modify: `packages/core/src/session/input.ts` 或新增 shell 输入路径（调研后定）
- Modify: `handlers/session.ts`（`shell` handler → `v2Svc.shell`）
- Test: 现有 shell 测试 + 新增 v2 断言

**实现方向（调研后细化）：**
- v1 语义：`shellImpl`（prompt.ts:478）= 创建 user 消息（含 shell part）→ `handle.process` 按 shell 处理器执行命令
- v2 现状：`SessionInput` **只支持 prompt 类型**（`{prompt, delivery}`，delivery 仅 steer/queue，`schema/session-input.ts:19-20`）——**无 shell 输入类型**
- 实现路径二选一（执行者调研后产出方案）：
  - (i) **SessionInput 扩展 shell 类型** + runner 处理分支（原生化，动 durable schema——影响面大，方案需停下确认）
  - (ii) **复用现有消息注入机制**：创建 shell 类型 SessionMessage + 通知 runner（不动 schema）
- **调研点**：v1 shell part 的 processor 执行链（命令怎么执行、结果怎么回）、v2 runner 是否已有 shell 消息处理（message-updater 有 shell.started/ended 投影——查 runner 消费）

- [ ] **Step 1: 调研产出方案**（(i)/(ii) + v1 shell part 执行链）→ 停下确认
- [ ] **Step 2: 写失败测试**：`session.shell` → 断言 shell 消息落库 + 命令执行
- [ ] **Step 3: 实现**（SessionV2.shell + handler 切换）
- [ ] **Step 4: 跑测试 + TUI 冒烟**（TUI shell 交互）
- [ ] **Step 5: Commit**（用户确认后）

### Task 3: command / subtask 映射（停下报告点 1）

**Files:** Read `prompt.ts`（`handleSubtask` L282、runLoop L1171）；Read `schema/prompt-input.ts`（agents）；Modify `handlers/session.ts`（`command`）

- [ ] **Step 1: 摸清 v1 command 语义**：`promptSvc.command` 触发链（slash → SubtaskPart），列全部 command 类型（/plan /explore 等）
- [ ] **Step 2: 映射评估**：v2 `PromptInput.Prompt.agents`（AgentAttachment）能否覆盖 subtask；**skill 命令走 prompt 文本展开**（v1 `_expandSkillCommand` prompt.ts:1154 逻辑——用户已决策 skill 后置，`SessionV2.skill` stub 不实现，skill 命令映射到 prompt 展开文本）。**产出映射表**
- [ ] **Step 3: 可等价部分切换** + 测试
- [ ] **Step 4: 不能等价的** → **停下报告用户决策**（不自行实现）
- [ ] **Step 5: Commit**（用户确认后）

### Task 4: revert / unrevert + permission.respond 验证

**Files:** Modify `handlers/session.ts`（`revert`/`unrevert`）；Read `session.ts:171-180`（stage/clear/commit）

- [ ] **Step 1: 语义对照**：v1 `revertSvc.revert/unrevert`（`packages/opencode/src/session/revert.ts`——**opencode 自己的 SessionRevert**，unrevert = 恢复已 revert 的消息）vs v2 `stage/clear/commit`（`session.ts:171-180` 调 **core 的 SessionRevert**——两个不同实现）。**产出语义对照表**：v1 unrevert ↔ v2 的哪个（clear？commit？），若语义不等价 → 停下报告
- [ ] **Step 2: 写失败测试 + 切换**（按对照结果映射）
- [ ] **Step 3: permission.respond 端到端验证**（审计 P0-4）：v2 路径下权限问答（`PermissionV2.DeclinedError`/`QuestionV2`，llm.ts:157）是否仍走同一 HTTP `permission.respond` 端点 + v1 `Permission.Service`（handlers/session.ts:362-378）——**验证通路；若 v2 用独立权限机制 → 停下报告**
- [ ] **Step 4: 跑测试 + TUI 冒烟**（TUI revert 交互：revert 后 unrevert 恢复消息）
- [ ] **Step 5: Commit**（用户确认后）

### Task 5: summarize / 手动压缩 —— ✅ 用户决策：compact 实现（summarize 映射）

**Files:**
- Modify: `packages/core/src/session.ts`（`compact` L417-420 从 stub 实装）
- Modify: `handlers/session.ts` **summarize handler（L273-293）**（⚠️ 之前误标为"compact 触发段"，实锤：`summarize = compactSvc.create + promptSvc.loop`，两个都是 v1 服务；**无独立 session.compact 端点**——手动压缩 = summarize 端点 或 消息内 CompactionPart）
- Test: 新增 compact/summarize 测试

**实现方向（调研后细化）：**
- v1 语义：`compactSvc.create`（compaction.ts:513-536）= 创建 user 消息 + `CompactionPart`（`type:"compaction", auto, overflow`）→ `promptSvc.loop` 触发 runLoop 处理
- v2 简化路径（推荐）：**`SessionV2.compact` = 直接调 `compaction.compactAfterOverflow`**（构造当前历史 entries + 最小 request）→ 成功则落 compaction 消息 → **无需 wake**（v2 询价式：下轮 `entriesForRunner` 从 compaction.seq 起自然变小）——实现细节执行者调研（compactAfterOverflow 的 entries/request 来源；与 Task 9 溢出接线的复用）
- summarize 映射：`SessionV2.compact`（v1 的"清理+压缩+摘要" → v2 压缩即摘要）
- **注意**：自动压缩不受影响（llm.ts:318/L321/L394-402 不经 SessionV2.compact）

- [ ] **Step 1: 调研产出方案**（compactAfterOverflow 调用来源 + summarize 映射细节）→ 停下确认
- [ ] **Step 2: 写失败测试**：`session.summarize` → 断言 `Compaction.Started/Ended` 事件 + compaction 消息落库
- [ ] **Step 3: 实现**（SessionV2.compact + summarize handler 切换）
- [ ] **Step 4: 跑测试 + TUI 冒烟**（手动压缩交互）
  - **验收（终审 A-P1-6）**：`Compaction.Ended` durable 事件落库 → **下一轮历史从 compaction.seq 起**（`entriesForRunner` 变小）→ TUI 出现 `<conversation-checkpoint>` 消息；手动压缩后立刻再发 prompt 不连环压缩
- [ ] **Step 5: Commit**（用户确认后）

### Task 6: task.ts 子代理迁移到 SessionV2（停下报告点 2）

**Files:** Modify `packages/opencode/src/tool/task.ts`（`TaskPromptOps`、`runTask` L269-288、`inject` L290-347）；Modify `packages/opencode/src/session/prompt.ts`（`ops` 工厂 L171-177）；Test: `packages/opencode/test/tool/task.test.ts`（1400 行行为锁测试）

**Interfaces:** `TaskPromptOps` v2 版：`resolvePromptParts`（不变）+ `prompt`（返回 Admitted）+ `cancel`（→ interrupt）+ **`waitForCompletion(sessionID)`（新增：admit 后等待子代理完成并取最终文本）**

**⚠️ 已核实（plan 定案）：`SessionV2.wait` 是 stub**（`session.ts:421-424`，直接抛 `OperationUnavailableError`）——**wait 方案不可用**。子代理结果获取**必须走事件订阅**：
- 方案（推荐）：admit 后订阅子会话 DurableEvent 流（`SessionV2.events(childSessionID)`）——监听 `Step.Ended`/最终 assistant 文本事件；或轮询 `SessionV2.messages(childSessionID)` 直到出现最终 assistant 消息（简单但多一次轮询）
- 执行者 Step 1 从两个子方案（事件订阅 vs 轮询）选一并产出细节，**不再考虑 wait**

- [ ] **Step 1: 方案产出（停下报告点 2）**：事件订阅方案细化——订阅 `SessionV2.events` 监听哪些事件类型、超时、与 `SubagentCompleted` 双路径防重的交互；**产出方案 → 停下报告用户确认 → 再继续**
- [ ] **Step 2: 按方案写失败测试**（子代理完成 → 事件/结果回传）
- [ ] **Step 3: 实现**：`runTask` = admit + wait + 取子代理最终文本；`inject`（后台通知）保持（它已经是 `ops.prompt` 注入父会话）
- [ ] **Step 4: 跑 task.test.ts 全量 + TUI 冒烟**（真实起子代理任务）
- [ ] **Step 5: Commit**（用户确认后）

**不变量：** `SubagentCompleted/Failed` 双路径防重逻辑（promotion 通知 vs foreground release）原样保留，只换 prompt 通道

### Task 7: server 组装切换 + TUI 事件流验证（停下报告点 3）

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`（**完整路径**——注意仓库另有一个 `packages/opencode/src/server/server.ts`（227 行），以下行号全部属于 httpapi/server.ts：摘 `SessionPrompt.node` L246；确认 `SessionV2.node` L299 / `SessionExecution.node` L301 / `EventV2Bridge.node` L240）
- Modify: `packages/opencode/src/control-plane/workspace.ts`（`prompt.cancel` → `SessionV2.interrupt`，L584）
- Modify: `handlers/session.ts` **`abort` handler**（`promptSvc.cancel` → `SessionV2.interrupt`——补审发现的遗漏端点）
- **审计 P0-4 补充——CRUD 端点归属确认**：`deleteMessage`/`part.delete`/`part.update` handler（handlers/session.ts:380-411）调 v1 `Session.Service.removeMessage/removePart/updatePart`——**确认摘除范围**：`SessionPrompt` 等运行路径服务摘除；**`Session.Service`（数据层 CRUD）等保留**（list/get/messages/todo/diff 等端点继续用）。执行时对每个 handler 标注"保留（CRUD）"或"切换/停下报告"
- Test: 全仓 grep `SessionPrompt` 剩余消费者

- [ ] **Step 1: 摘 `SessionPrompt.node`**：全仓 grep `SessionPrompt` 剩余消费者（workspace.ts 已映射 interrupt）
- [ ] **Step 2: TUI 事件流端到端验证**：发消息/工具调用/子代理/状态变化 → TUI 全部正常显示（**缺失即停下报告**）
- [ ] **Step 3: 全量测试**：`packages/opencode` + `packages/core` 相关 + TUI 全功能冒烟（发消息/子代理/命令/compaction/revert/shell）+ **loop-control 激活验证**：`/loop status`（loop 命令走 v2 SessionRuntime——v1 时已有命令分发，v2 转正后确认 session 级 instance 的 status/budget/goal 命令输出正常；verifier/WorkerState 随 v2 runner 激活，观察 `SubagentCompleted` 事件驱动 worker 状态）
- [ ] **Step 4: Commit**（用户确认后）

### Task 8: v1 退役收尾（停下报告点 4）

**Files:** 运行路径引用清理（server.ts 后剩余）

- [ ] **Step 1: 全面 grep**：`SessionPrompt`/`SessionCompaction`/`SessionRunState`/`SessionReminders`/`SessionSummary`（含 `summary.summarize`）/`SessionRunState` 的 v1 session 服务运行路径剩余引用
- [ ] **Step 2: 逐一处置**：每个命中标注"v2 等价 = ..."（对照"v1 独有运行路径功能"表）或**停下报告**（reminders/summarize/SessionRunState 无 v2 等价的功能 → 用户决策：接受失活 / 移植 / 后置）
- [ ] **Step 3: 验证**：`bun dev` 启动日志无 v1 session 服务加载（或保留加载但无调用方——用户偏好）
- [ ] **Step 4: 全量回归 + 报告**
- [ ] **Step 5: Commit**（用户确认后）

### Task 9: 上下文管理改造（依赖 context-management-design.md）

**依赖声明：** 本 Task 由 `docs/superpowers/plans/2026-08-02-context-management-design.md` 驱动（已完成设计定案：turn 级切割/模型选择/survival/饱和预算/纠错闭环/文件追踪/溢出接线）。V2 转正（Task 1-8）完成后，把该设计转 writing-plans 实施。**本 Task 在 V2 转正完成前不动作。**

---

## 执行顺序与验证依赖

```
Task 1 → Task 2（shell 实现，方案调研停下确认）→ Task 3 → Task 4 → Task 6 → Task 7 → Task 8
              ↘ Task 5（compact 实现，方案调研停下确认）——可与 Task 2 并行调研
  │
  └──────────── TUI 冒烟在每步做（发消息/对应功能）
Task 7 全量回归通过 = V2 转正完成 → Task 9（上下文管理）开始
```

**决策记录（用户已拍板）**：shell = a 实现（TUI shell 常用）、compact = a 实现（手动压缩+summarize 必需）、skill = c 后置（走 prompt 文本展开，SessionV2.skill 保持 stub）、wait = 不实现（Task 6 事件订阅）。
**剩余停下报告点**：Task 2/5 的实现方案选型（调研后确认）、Task 3 subtask 映射、Task 6 事件订阅方案、Task 7 TUI 事件流、Task 8 v1 独有功能失活。

每个 Task 的"停下报告点"触发时：记录 v1/v2 行为差异 + 缺口 → 报告用户 → 等决策（不自行补 v2）。
