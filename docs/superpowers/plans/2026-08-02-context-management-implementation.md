# 上下文压缩改造 Implementation Plan（Compaction v3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v2 compaction 从"字符串级切割 + 固定 4096 摘要"升级为"turn 级切割 + LLM 参与选择保留 + survival 计数 + 饱和预算 + 文件追踪 + 溢出接线"（设计见 `2026-08-02-context-management-design.md`，本 plan 是它的实施分解）。

**Architecture:** 纯函数层（切割/编号/解析/校验/预算——可单元测试）+ 编排层（纠错闭环，模型可注入）+ 持久层（compaction 消息扩展字段：survival/files）+ 接线层（llm.ts 溢出路径 + 配置）。所有改造在 `packages/core/src/session/compaction.ts` 及周边，不碰 v1。

**Tech Stack:** Effect、`Token.estimate`（现有）、LLM request（现有）、compaction 消息（`type=compaction`，message-updater 落库）

## Global Constraints

- 测试从 `packages/core` 跑：`TMPDIR=/home/huyongjun/tmp-opencode bun test`；现有 compaction 相关测试保持绿色
- 依赖：**本 plan 在 V2 转正（`2026-08-02-deprecate-v1-use-v2.md` Task 1-8）完成后执行**（改造的 compaction.ts/llm.ts 是 v2 运行路径）
- 不用 `as any`；选择逻辑做成可注入函数（mock 模型返回固定 `<selection>` 输出）
- commit：`feat(core): ...`，用户明确要求才 commit
- 设计决策引用：`2026-08-02-context-management-design.md`（D1-D15 + 纠错闭环 + survival + 缓存 + G3/G5 + recent 移除）

## 设计要点速览（实施依据）

- **切割**：turn 级为主；超大 turn（>2/3 选中限额）拆子 turn（<2/3）；toolCall+toolResult 成组永不分离；synthetic/system 独立编号；compaction 消息不编号
- **编号格式**：`[3] (2.1%) ×3 [User]: ...`（占比 = 项 token / 窗口；×N = survival）
- **预算**：摘要 `20_000·x/(x+272_000)`（x=contextWindow）；近期区 `min(10%, 20000)`；选中区 `<10%` 窗口 + 数量上限 10-20；触发 buffer `min(10%, 20000)`
- **一轮调用**：`<selection>[3,7,12b]</selection>` + 摘要正文（覆盖全部早期，含选中——D15）
- **纠错闭环**：≤1.5× 接受 → 重请求只重选（错误反馈写 prompt）→ 贪心截断（占比从大到小）/ 降级 Pi 方案（近期+全量摘要）
- **摘要调用**：`cache: "none"`（**本仓库原生 API**：`LLMRequest.cache: CachePolicy = "auto" | "none" | {...}`，`packages/llm/src/schema/options.ts:275`——即 Pi cacheRetention "none" 的等价物，终审 A-P0-3 定案）+ SUMMARIZATION_SYSTEM_PROMPT + `<conversation>` 包裹；失败一次重试
- **survival**：compaction 消息扩展字段 `survival: {项Key: count}`；项 Key = 编号项首条消息 messageID
- **文件追踪**：扫描 toolCall read/write/edit path → `files: {read, modified}` 存 compaction 消息 → 摘要末尾 XML
- **recent 移除**：select 返回/事件/schema/落库/呈现 5 处
- **溢出接线**：llm.ts 失败路径 `context_overflow` → `compactAfterOverflow` → `recovered: true`（TurnRetryState 一次去重）
- **ContextEngine proactive 分支——禁用**（D5 定案修正）：⚠️ 已核实 `llm.ts:320-325` 的 proactive 链路**实际已接通**（`shouldProactiveCompact` → 真调 `compactAfterOverflow` → `compact()` 记账）——之前"未接线"的说法有误。但触发条件**基于 IterationBudget 步数**（cap 90 步的 50% + 30 步间隔）**与 token 用量无关**（30 步爆满的会话永不触发、90 步空会话 45 步就压）——语义错位。**Task 10 增加：移除/禁用 `llm.ts:320-325` proactive 分支**（对齐 Pi：只留 compactIfNeeded 阈值 + recoverOverflow 溢出两触发）；`context-engine.ts` 文件保留（测试在用）

---

### Task 1: turn 级 select 重写（纯函数）—— 终审 A-P1-1 补规格

**Files:**
- Modify: `packages/core/src/session/compaction.ts`（`select` L128-159 替换为 turn 级版本）
- Test: `packages/core/test/session/compaction-select.test.ts`（新建）

**Interfaces:**
- Consumes: `SessionMessage.Message[]`（entries）、`config.tokens`（保留预算）
- Produces: `selectTurns(entries, budget) => { head: Entry[]（要压缩的早期项）, recent: Entry[]（近期区全量）, items: TurnItem[] }`——`TurnItem = { key: string（首消息 ID）, kind: "turn" | "subturn", label: "3" | "3a", tokens: number, survival: number, messages: Message[] }`

**切割算法伪代码（终审 A-P1-1，实施必须遵守）：**
```
groupMessages(entries):
  # toolCall↔toolResult 成组：assistant 消息的 tool-call part + 对应 tool-result 消息 = 一个组
  # 组内不可切（与 Pi isCutPointMessage 等价约束）
  return messageGroups          # 每组含 1+ 消息，组首可切、组中不可

turns(groups):
  # 切 turn 边界：user/synthetic 消息开新 turn；其余归入当前 turn
  # 会话开头非 user/synthetic（system 等）→ 独立编号组（不绑第一个 user）

selectTurns(entries, budget):
  groups = groupMessages(entries)
  turns = turns(groups)
  recent = []                    # 近期区：从尾部倒序累加
  for turn in reversed(turns):
    if recentTokens + turn.tokens <= min(10% window, 20000):
      recent.prepend(turn)       # 整 turn 进近期区
    else:
      break                      # ⚠️ 近期区 cut 强制落在 turn 起点（终审 B9 定案 (A)）
                                  # 绝不 mid-turn 切近期区——被切前缀需专用语境，成本高
  head = turns - recent          # 要压缩的早期
  for turn in head: 编号（超大 turn > 2/3 选中限额 → 按组拆 subturn，每片 < 2/3）
  return { head, recent, items }
```

**禁止事项（验收测试必须锁）：**
- ❌ 禁止字符串级 slice 切割（现 select L144-147 的 `slice(0, -remaining)` 行为——必须整体移除）
- ❌ 切点不得落在 toolCall/toolResult 组中间（组中不可切）
- ❌ 近期区不得 mid-turn 切（cut 强制 turn 起点）

- [ ] **Step 1: 写失败测试**：turn 切分（user 边界）、toolResult 组绑定（切点不在组中）、**近期区 cut 强制 turn 起点**（mid-turn 场景：turn 超预算时整 turn 进 head 而非半切）、超大 turn 拆子 turn（>2/3 选中限额 → 多个 <2/3 的子项）、synthetic/system 独立编号、**字符串 slice 行为不存在**（回归测试）
- [ ] **Step 2: 实现 `selectTurns`**（按伪代码）
- [ ] **Step 3: 跑测试**：全绿
- [ ] **Step 4: Commit**（用户确认后）

### Task 2: 编号项生成（编号/占比/×N）

**Files:**
- Modify: `compaction.ts`（新增 `formatNumberedItems`）
- Test: `compaction-select.test.ts` 扩展

**Interfaces:**
- Consumes: `TurnItem[]` + contextWindow + survival 映射
- Produces: `formatNumberedItems(items, contextWindow) => string`（`[3] (2.1%) ×3 [User]: ...` 文本）+ `survival` 读入（从 compaction 消息字段）

- [ ] **Step 1: 写失败测试**：编号/占比（= tokens/contextWindow 百分比）/×N 标注格式；survival 从外部映射注入
- [ ] **Step 2: 实现**：占比计算 + 格式串
- [ ] **Step 3: 跑测试** + Commit

### Task 3: 选择 prompt 构建（buildPrompt v3）

**Files:**
- Modify: `compaction.ts`（`buildPrompt` L161-168 扩展 + `SUMMARIZATION_SYSTEM_PROMPT` + `<conversation>` 包裹）
- Test: `compaction-buildprompt.test.ts`（新建，snapshot）

**Interfaces:**
- Consumes: `formatNumberedItems` 输出、previousSummary（compaction 消息 summary）、全部早期 serialize
- Produces: 选择+摘要一体 prompt：`[系统提示（不要对话，只输出结构化摘要+<selection>）] + [SUMMARY_TEMPLATE] + [previousSummary 增量] + [编号列表（含占比/×N）] + [<conversation> 全历史</conversation>]`

- [ ] **Step 1: 写失败测试**：prompt 结构（固定段在前/编号在末/`<selection>` 输出要求明确写死）；摘要覆盖全部早期（含选中——D15）；增量 previousSummary 存在时用更新模板，**snapshot 锁更新规则关键字（PRESERVE/ADD/UPDATE——终审 A-P1-2）**
  - **注意（Momus P1-3）**：buildPrompt 的输入在 Task 6/7 后会扩展（survival 标注、files XML、recent 移除）——本 Task 的 snapshot 测试**只锁 prompt 骨架**（段顺序/标签/系统提示），不锁 previousSummary/recent 的具体拼接段，避免 Task 6/7 后测试返工
- [ ] **Step 2: 实现 buildPrompt v3** + SUMMARIZATION_SYSTEM_PROMPT + `<conversation>` 包裹 serialize 输出
  - **增量摘要规则（终审 A-P1-2，对齐 Pi UPDATE_SUMMARIZATION_PROMPT 等价强度）**：previousSummary 存在时，prompt 必须包含三条显式规则——**PRESERVE**（保留所有仍然成立的既有信息，不因空间裁剪）、**ADD**（并入本轮新增事实/决策/文件操作）、**UPDATE**（更新 Progress 与 Next Steps 的过期项）；禁止仅一句 "merge" 式弱指令
  - **缓存（终审 A-P0-3）**：摘要 LLM 请求用 `cache: "none"`（`LLMRequest.cache` CachePolicy 原生支持，`packages/llm/src/schema/options.ts:275`）；不传主会话的 `promptCacheKey`；SUMMARIZATION_SYSTEM_PROMPT 走 `LLM.request({ system: [...] })` 系统槽（不塞进 user 正文唯一位置）；正文仍 `<conversation>` 包裹
- [ ] **Step 3: 跑测试**（snapshot 固定骨架）+ Commit

### Task 4: 选择输出解析与校验（纯函数）

**Files:**
- Modify: `compaction.ts`（新增 `parseSelection` / `validateSelection`）
- Test: `compaction-selection.test.ts`（新建）

**Interfaces:**
- Consumes: 模型输出文本 + `TurnItem[]` + 选中限额（10% 窗口）+ 数量上限（10-20）
- Produces: `parseSelection(output) => { ok: true, selected: string[] } | { ok: false, errors: string[] }`（错误：格式错/编号不存在/超预算——含"超多少、超 1.5× 否"判定）

- [ ] **Step 1: 写失败测试**：`<selection>` 标签位置容忍（开头/中间/末尾）；JSON 数组解析；编号存在性校验；预算校验（≤1.5× 通过 / >1.5× 标记需重选 / 超数量上限）
- [ ] **Step 2: 实现**：标签定位（indexOf，N4）+ JSON 解析 + 校验三件套
- [ ] **Step 3: 跑测试** + Commit

### Task 5: 纠错闭环编排（模型可注入）

**Files:**
- Modify: `compaction.ts`（`compactAfterOverflow` L172-224 重写编排）
- Test: `compaction-retry.test.ts`（新建，mock 模型）

**Interfaces:**
- Consumes: `parseSelection`/`validateSelection`/`buildPrompt v3`/LLM 调用（注入）
- Produces: 完整闭环：第一次调用（选择+摘要）→ 校验 → ≤1.5× 接受 / >1.5× 重请求只重选（错误反馈 prompt）→ 二次仍超贪心截断（占比从大到小）/ 格式/编号错重请求 → 仍失败降级 Pi 方案（近期+全量摘要）→ 摘要失败一次重试

- [ ] **Step 1: 写失败测试**（mock LLM 输出序列）：正常路径 / 1.5× 内接受 / 超 1.5× 重选后合规 / 二次仍超贪心截断 / 格式错重选后合规 / 两次格式错降级 Pi / 摘要失败重试后成功 / 摘要两次失败降级
- [ ] **Step 2: 实现闭环编排**（重请求 prompt = 原 prompt + 错误反馈段在末尾——缓存设计约定）
  - **调用次数上限（审计 P1-2）**：闭环总 LLM 调用上限 **4 次**（1 选择+摘要 + 1 重选 + 1 摘要重试 + 1 兜底）；超过直接降级 Pi 方案。理由：`compactAfterOverflow` 可能在 `recoverOverflow` 路径（llm.ts:394-402，`uninterruptibleMask` 内）被调用，多次调用会阻塞 drain——上限保证阻塞时间有界
- [ ] **Step 3: 跑测试** + Commit

### Task 6: 摘要预算 MM 公式 + recent 移除 + 总预算约束（审计 P1-1）

**Files:**
- Modify: `compaction.ts`（`SUMMARY_OUTPUT_TOKENS` L15 → MM 公式；`summaryOutput` L183）
- Modify: `packages/schema/src/session-event.ts:428`（`Compaction.Ended` 去 `recent`）
- Modify: `message-updater.ts:385`（去 recent 落库）
- Modify: `to-llm-message.ts:160`（checkpoint 呈现去 `<recent-context>`）
- Modify: `compaction.ts:221`（事件不带 recent）
- Test: 现有测试修正 + 预算公式单测

**Interfaces:** `summaryBudget(contextWindow) = 20_000 * x / (x + 272_000)`（取整）

**总预算约束公式（审计 P1-1 + 终审 A-P0-2 定案）：**
```
summary_tokens + selected_original_tokens + recent_tokens + system_tools_tokens ≤ contextWindow - buffer
```
- **maxOutput 不参与**（D13 定案，终审确认方案 a）——与 `compactIfNeeded` 现有语义 `context - max(output, buffer)` 统一用 buffer 作安全余量；不再出现 `- maxOutput`
- 验算（200K 窗口）：近期 20K + 选中 <20K + 摘要 8.5K + system/tools ~10K = ~58.5K ≤ 200K-buffer ✅；小窗口（32K）：3.2K + <3.2K + 2.1K + 10K ≈ 18.5K ≤ 32K ✅
- 若验算超约束（极端配置）→ select 阶段按优先级收缩（近期区优先保，选中区收缩到 budget 内）

- [ ] **Step 1: 写失败测试**：预算公式锚点（128K→6400/272K→10000/1M→15700/2M→17600，±5%）
- [ ] **Step 2: 实现公式** + recent 5 处移除（grep 确认无遗漏）
- [ ] **Step 3: 跑测试**（现有 compaction 相关修正）+ Commit

### Task 7: survival 持久化

**Files:**
- Modify: `packages/schema/src/session-message.ts:192-198`（`Compaction` 消息：去 `recent`，加 `survival: Schema.Record(Schema.String, Schema.Number)`——已核实结构 `{type, reason, summary, recent, ...Base}`）
- Modify: `message-updater.ts:373-385`（compaction.ended 落库带 survival）
- Modify: `compaction.ts`（压缩时读取 survival → 更新被选中/近期项 +1 → 写回事件）
- Test: `compaction-survival.test.ts`（集成：压缩 → 落库 → 下轮读取）

**Interfaces:** `survival: Record<项Key, number>`（项 Key = 编号项首消息 messageID）；读取自最近 compaction 消息；更新：选中项 +1、近期区项 +1、未选中消失
**审计 P1-3 判定**：compaction.ts:177 的 `entries.find(...)` 不改 findLast 也可行——`entriesForRunner` 从 `latestCompaction.seq` 起读（history.ts），entries 中至多一个 compaction 消息，find/findLast 等价；但改 findLast 为防御性写法，成本为零（执行时顺手改）

- [ ] **Step 1: 写失败测试**：落库 → 重读 → 计数累积；选中/近期 +1；未选中不再出现
- [ ] **Step 2: 实现**：字段扩展 + 读写
- [ ] **Step 3: 跑测试** + Commit

### Task 8: 文件追踪（G5）

**Files:**
- Modify: `compaction.ts`（新增 `extractFileOps`）
- Modify: message-updater/schema（compaction 消息 `files: {read: string[], modified: string[]}` 字段）
- Test: `compaction-files.test.ts`（新建）

**Interfaces:** `extractFileOps(messages, prevFiles?) => { read: string[], modified: string[] }`——扫描 assistant toolCall（read/write/edit 的 path 参数）+ 从上次 compaction 消息继承合并（去重）；输出摘要末尾 XML
**注意（Momus P2 + 终审 A-P2-4）**：项 Key 沿用 Task 7 的约定（编号项首消息 messageID），文件累积的继承来源 = 上次 compaction 消息的 `files` 字段（与 survival 同载体，一套 Key 体系）；**computeFileLists 语义对齐 Pi（utils.ts:62-66）**：`modified = edit ∪ write`，`read = 只读集合 − modified`（**写过的文件不进 read 列表**）——Task 8 测试锁此语义

- [ ] **Step 1: 写失败测试**：read/write/edit path 提取；跨压缩累积（继承+合并去重）；XML 格式
- [ ] **Step 2: 实现** + 字段落库
- [ ] **Step 3: 跑测试** + Commit

### Task 9: 溢出接线验证（不是实现！）—— 审计 P0-5 重写

**⚠️ 已核实（llm.ts:394-402）：溢出接线已完整存在**——`recoverOverflow && !publisher.hasAssistantStarted() && isContextOverflowFailure(...) && restore(recoverOverflow(...))` → `Effect.die(continueAfterOverflowCompaction)`，注释明说"不走 onFailover"；`runTurnAttempt` 第 5 参数 `recoverOverflow` 由 `runTurn` 传入 `compaction.compactAfterOverflow`（L523）；`runAfterOverflowCompaction` 二次溢出防递归已实现（L507）。**本 Task 从"实现"改为"验证 + 升级联动"**。

**Files:**
- Modify: 无（接线不改）
- Test: `packages/core/test/runner/llm-overflow-compaction.test.ts`（新建——验证现有接线在新 compaction 逻辑下仍工作；core test 惯例全 .ts）

- [ ] **Step 1: 写集成测试**：mock LLM 流溢出失败 → 断言走 recoverOverflow 路径（触发 `compactAfterOverflow` 新逻辑——turn 级 select + LLM 选择）→ `ContinueAfterOverflowCompaction` 被捕获 → 重放后历史已压缩；二次溢出同轮 → 防递归 die
  - **模型切换说明（终审 §2/3 定案，不实现）**：Pi 的 sameModel 门闩（agent-session.ts:1962-1967）防御的是"**历史 overflow 消息在下次 prompt 被再次检查**"——v2 架构下 `models.resolve` 在 turn 开头固定 model（llm.ts:277），recoverOverflow 仅在**同 turn 流失败**时触发（llm.ts:394-402），从不重扫历史 overflow → **sameModel 不适用，不实现**。切窗行为由 compactIfNeeded 用当前 `model.route.defaults.limits.context` 阈值驱动（已覆盖，见 Task 6）
- [ ] **Step 2: 确认链路**：Task 5 重写 `compactAfterOverflow` 后，llm.ts:394-402 的调用签名 `{sessionID, entries, model, request}` 不变即可无缝联动
- [ ] **Step 3: 跑测试**（现有 `llm-loop-control.test.ts` 保持绿）+ Commit

### Task 10: 配置项 + 摘要失败重试 + proactive 禁用

**Files:**
- Modify: `packages/core/src/config/compaction.ts`（加 `select: { enabled, budget, retry }` + `summary` 公式参数）
- Modify: `compaction.ts`（读配置；摘要失败一次重试）
- Modify: `packages/core/src/session/runner/llm.ts`（**移除 `llm.ts:320-325` proactive 分支**——触发条件基于迭代步数与 token 无关，禁用对齐 Pi）
- Test: 配置解析测试

**Interfaces:** `compaction.select.enabled`（默认 true）/ `select.budget`（默认 0.10）/ `select.retry`（默认 1）/ `keep.recent`（默认 min(10%, 20000)）/ `summary.max_tokens`（默认 L=20000, K=272000）

- [ ] **Step 1: 写失败测试**：配置默认值 + 覆盖；摘要失败重试一次；proactive 分支移除后 `shouldProactiveCompact` 不再被调用（或条件恒 false）
- [ ] **Step 2: 实现**（配置 + 重试 + 移除分支）
- [ ] **Step 3: 跑测试**（`llm-loop-control.test.ts` 若依赖 proactive 分支需同步修正——先跑基线确认）+ Commit

---

## 执行顺序与验证

```
Task 1 → 2 → 3 → 4 → 5（纯函数层：切割→编号→prompt→解析→闭环）
Task 6 → 7 → 8（预算/持久化：MM 公式 + survival + 文件）
Task 9 → 10（接线/配置）
```

- Task 1-5 是纯函数/可注入，无运行路径依赖，可先行
- Task 6-8 依赖 compaction 消息 schema（Task 6 先动 schema 再动消费方）
- Task 9 依赖 V2 转正（llm.ts 是 v2 运行路径）
- 每个 Task 完成后：`TMPDIR=/home/huyongjun/tmp-opencode bun test packages/core/test`（相关子集）
- 全部完成后：真实 TUI 长会话 E2E 冒烟（触发压缩，人工检查：选中质量/编号占比/×N/摘要质量/文件 XML）
