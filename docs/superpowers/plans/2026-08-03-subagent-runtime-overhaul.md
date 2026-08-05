# 子代理系统大改 Implementation Plan（注册表 + 定义层 + 预算 + 结构化契约）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 V2 子代理从"能 spawn、前台假等待、后台丢结果、无深度/权限/通知"的 20% 骨架，改造成具备运行时注册表、结构化结果契约、深度/并发/预算控制、resume 身份校验、生命周期 hook、继承式定义层的成熟子代理系统。

**Architecture:** 改造全部落在已核实的 V2 活路径上：`core/src/tool/task.ts`（薄壳工具）→ `opencode/src/tool/v2-host-bridges.ts`（子代理 spawn 主逻辑）→ `core/src/agent.ts`（AgentV2 注册表）→ `core/src/session/store.ts`（SessionStore 持久化）+ `core/src/session/execution.ts`（drain 控制）+ `opencode/src/background/job.ts`（后台任务）。新增 `core/src/session/subagent-registry.ts` 作为运行时真相源（pending/active/completed 三表），EventBus 事件降级为投影。定义层在 `core/src/config/agent.ts`（ConfigAgent.Info schema）+ `core/src/config/plugin/agent.ts`（ConfigAgentPlugin 解析）加继承/覆盖优先级/capability/workspace。

**Tech Stack:** Effect（全部服务）、Schema（effect schema）、`@opencode-ai/core`（core 层）、`@opencode-ai/opencode`（host 桥接层）、Bun test

## Global Constraints

- 测试从包目录跑（`packages/core` / `packages/opencode`），不跑 repo root
- 不引入新依赖；不用 `as any`；Effect 遵循仓库 AGENTS.md（`Effect.fn`、`Effect.forkIn(scope)`、`Schema.TaggedErrorClass`）
- 只改活路径文件，不碰未接线死代码（见基线事实 §0）
- 与既有 plan 衔接：`docs/superpowers/plans/2026-08-02-deprecate-v1-use-v2.md` 已定案 V2 转正、v1 退役；本 plan 只做 V2 子代理
- commit：`feat(core|opencode): ...`，用户明确要求才 commit
- 每个 Task 独立可验证（TDD：先写失败测试）

### 🔴 禁止平行实现（最高优先级，所有 Task 必须遵守）

**任何新功能必须建立在现有 V2 活实现之上，禁止绕过现有实现另建平行通道。** 违反此约束的 Task 将被拒绝。逐项规则：

1. **一份逻辑一个主人**：凡已有活实现（BackgroundJob / max-steps / PermissionV2 / ToolRegistry.materialize / SessionStore / SessionInput.admit / execution.wake），只接线、只扩展，不新建同名/同职责的平行服务。**注意：`BackgroundJob.onPromote` 是"前台→后台转换"专用（promote() 对 background:true 的 job 直接返回不调 onPromote；纯后台 spawn 无人调 promote）——后台完成通知必须用 fork `background.wait` 观察纤维，不得依赖 onPromote。**
2. **迁移复用优先于新写**：v1 残留中被证明逻辑正确且唯一的函数（`deriveSubagentSessionPermission`、`buildForkPrompt`），**迁移到 core 改名 + 改类型签名**，禁止从零重写一份语义相同的函数。
3. **状态单主人**：子代理状态（pending/active/completed/lost）只存在 `SubagentRegistry`；`BackgroundJob` 只做执行结果传递（wait/promote/onPromote）。**终态读取方向（审计修正）**：core 全局 registry **不 dep `BackgroundJob.node`**（opencode 侧是 InstanceState per-directory 作用域，core 直接 dep 会拿到被遮蔽实例）——**host（v2-host-bridges）读 job 终态，经 `transition(..., patch)` 参数传入 registry**。禁止两处各存一份。
4. **TUI 渲染不平行**：`run/tool.ts` 已按工具名分发（`ctx.name === "task"`），删 v1 工具栈时只把类型引用换成 core 的，**禁止新建一份 V2 版 TUI 渲染**。
5. **事件不平行**：新增 `SessionEvent.Subagent.*` 走 EventV2 活路径；`loop-control/event-bus.ts` 的 `SubagentCompleted/Failed`（v1 死代码）**不碰、不迁移、不消费**。
6. **配置不平行**：定义层只改 `core/src/config/plugin/agent.ts`（V2 ConfigAgentPlugin），禁止新建第二个 agent loader。
7. **per-agent 预算不平行**：cap 耗尽机制用现成 `max-steps.ts`（MAX_STEPS_PROMPT 强制文本收尾已实装），只把耗尽标记接进 structured 返回；禁止新建迭代预算执行器。

---

## §0 基线事实（已核实，实施时直接用）

### 活路径（子代理相关）

```
V2 Session.prompt → SessionRunner（core/src/session/runner/）
  → ToolRegistry.materialize（core/src/tool/registry.ts）
    → BuiltInTools.node ← TaskTool.node（core/src/tool/task.ts，137 行薄壳：permission.assert + HostService.run）
      → TaskTool.HostService.run ← taskHostLayer（opencode/src/tool/v2-host-bridges.ts，232 行：全部 spawn 逻辑）
        → AgentV2（core/src/agent.ts + core/src/plugin/agent.ts 内置 7 agent + core/src/config/plugin/agent.ts 用户 agent）
        → SessionStore.create 子 session + SessionInput.admit + execution.wake/resume
        → BackgroundJob（opencode/src/background/job.ts → core/src/background-job.ts）
```

### 已确认缺口（本 plan 要修的）

| # | 缺口 | 位置 |
|---|---|---|
| G1 | 前台 `promptAndWait` 假等待：`execution.resume` 非阻塞 + `store.context` 立即返回 | v2-host-bridges.ts:160-172, 201 |
| G2 | 后台完成无通知：`background.start` 后结果从不 inject 回父 | v2-host-bridges.ts:174-199 |
| G3 | 无深度守卫：子可无限嵌套 | v2-host-bridges.ts run 全流程 |
| G4 | 无并发上限 | 同上 |
| G5 | 子 session 创建时不设 permission（无 writable 继承、无 capability 过滤） | v2-host-bridges.ts:125-148 |
| G6 | 无心跳/失联检测 | 无 |
| G7 | 结果契约 = `lastAssistantText` 字符串，无结构化字段 | v2-host-bridges.ts:57-69, 202 |
| G8 | resume（task_id）无身份校验 | v2-host-bridges.ts:110-113 |
| G9 | 无生命周期 hook | 无 |
| G10 | 定义层无继承/覆盖优先级/capability/workspace | config/agent.ts + plugin/agent.ts |
| G11 | fork 模式缺失（子会话从空开始，无父历史继承） | v2-host-bridges.ts:163 |

### 可用现成机制（不要重造）

- `execution.active: Effect<ReadonlySet<SessionID>>` —— 进程活跃 drain 集合（天然活跃信号，供失联检测）
- `BackgroundJob` wait/extend/promote/cancel —— 后台任务完整；**onPromote 是"前台→后台转换"专用**（promote() 对 `metadata.background===true` 的 job 直接返回不调 onPromote；纯后台 spawn 无人调 promote）——**后台完成通知不能用 onPromote**，用 fork `background.wait` 观察纤维
- `AgentV2.Info.steps` —— per-agent 迭代上限字段**已接线**（llm.ts:571 `isLastStep`，最后一步 toolChoice:"none" + MAX_STEPS_PROMPT 注入）
- `SessionStore.get` —— parentID 已在 session row；**SessionStore 无 create**（只有 get/context/runnerContext/message——子 session 创建走 `SessionV1.Event.Created` 发布 + projector 落库，见 v2-host-bridges.ts:125-157）
- `PermissionV2` —— 权限系统；**`configured()` 只读 `agent.permissions` + savedRules，session.permission 列无人消费**（permission.ts:141-149）——Task 4 必须扩展它
- `core/src/session/runner/max-steps.ts` —— 已实装（llm.ts:571-582）
- **loop-control 死活精确清单**（前置裁决）：`IterationBudget.consume` + real hooks（WorkerState/EventBus/Terminal）**活**（llm.ts 每 turn 调用）；`acquireAgentGuard/activeCap` **V2 死**（唯一生产消费者 v1 task.ts）；`SubagentCompleted/Failed` 事件**消费端活（loop-control-host.ts:139-148）、发布端死**（仅 v1 task.ts 链发布）——v1 退役后自然无发布方，**不桥接是有意决策**；heartbeat/spawn-edge/promotion-guard/circuit-breaker/doom-loop/task-hook **死/残留**

---

## 文件结构（本 plan 创建/修改）

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/core/src/session/subagent-registry.ts` | 运行时注册表：pending/active/completed 状态 + cancel_token + 快照 + 心跳 watcher + 事件投影（**makeGlobalNode，与 IterationBudget 同级**） | **Create** |
| `packages/core/src/session/subagent-lifecycle.ts` | data-only contributor hook 注册表（onSpawn/Start/Turn/Complete/Fail/Abort/HeartbeatLost/SessionIdle） | **Create** |
| `packages/core/src/session/subagent-identity.ts` | resume 身份校验（parentID/type/persona/model 源锁定）+ AgentPath 式 address 生成（预留 sibling） | **Create** |
| `packages/core/src/tool/task.ts` | 薄壳升级：结构化 Output schema、per-agent budget acquire、并发软上限检查、capability 校验 | **Modify** |
| `packages/opencode/src/tool/v2-host-bridges.ts` | spawn 主逻辑升级：深度守卫、权限继承（writable/capability）、注册表接线、前台真等待、后台通知 inject、resume 校验、fork 模式 | **Modify** |
| `packages/core/src/config/agent.ts` | ConfigAgent.Info schema：加 extends/覆盖来源/capability/workspace | **Modify** |
| `packages/core/src/config/plugin/agent.ts` | ConfigAgentPlugin 解析：继承合并、优先级链、来源元数据 | **Modify** |
| `packages/core/src/agent.ts` | AgentV2.Info 补充（如需）或透传 capability | **Modify** |
| `packages/core/test/session/subagent-registry.test.ts` | 注册表状态机测试 | **Create** |
| `packages/core/test/tool/task.test.ts`（core 版） | 薄壳行为测试 | **Create** |
| `packages/opencode/test/tool/v2-task-host.test.ts` | host bridge 端到端行为测试 | **Create** |
| `packages/core/test/session/subagent-identity.test.ts` | resume 校验测试 | **Create** |
| `packages/core/test/config/agent-plugin.test.ts` | 继承/优先级/来源解析测试 | **Create** |

---

## Task 1: SubagentRegistry —— 运行时真相源（G1/G4/G6 地基）

**Files:**
- Create: `packages/core/src/session/subagent-registry.ts`
- Create: `packages/core/test/session/subagent-registry.test.ts`
- Modify: `packages/core/src/session/runtime.ts`（SessionRuntime bundle 挂注册表，与 IterationBudget 同级）

**⚠️ 不平行约束（全局约束 3）**：`BackgroundJob`（core/src/background-job.ts）已管 `running/completed/error/cancelled` 执行状态。**分工**：注册表管子代理生命周期（pending/active/lost + cancel_token + 心跳 + 计数）；`BackgroundJob` 管执行结果传递（wait/promote/onPromote）。**终态读取方向（审计修正）**：core 全局 registry **不 dep `BackgroundJob.node`**——opencode 侧 BackgroundJob 是 InstanceState per-directory 作用域（opencode/src/background/job.ts:17-35），core 全局 registry 若直接 dep 会拿到被遮蔽前的错误实例。正确做法：**host（v2-host-bridges）读 job 终态，经 `transition(..., patch)` 参数传入 registry**——状态单主人由 host 侧保证。**cancel 语义（审计修正）**：registry.cancel 只做状态迁移（标 cancelled），实际中断由 host 执行 `background.cancel(childID)` + `execution.interrupt`——core registry 调不到 opencode 服务。

**Interfaces:**
- Consumes: `SessionSchema.ID`、`Effect`、`SynchronizedRef`
- Produces:
```ts
export const SubagentStatus = Schema.Literals(["pending", "active", "completed", "failed", "cancelled", "lost"])
export const SubagentRecord = Schema.Struct({
  childSessionID: SessionSchema.ID,
  parentSessionID: SessionSchema.ID,
  subagentType: Schema.String,
  status: SubagentStatus,
  createdAt: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  finishedAt: Schema.optional(Schema.Number),
  cancelToken: Schema.String,
  lastHeartbeatAt: Schema.Number,
  turnCount: Schema.Number,
  toolCallCount: Schema.Number,
  tokensUsed: Schema.Number,
  error: Schema.optional(Schema.String),
  resumeFrom: Schema.optional(Schema.String),
  address: Schema.String,          // "/root/<task>"; sibling 通信预留
})
export interface Interface {
  readonly register: (input: { parentSessionID; childSessionID; subagentType; address }) => Effect.Effect<SubagentRecord>
  readonly transition: (childSessionID, to: SubagentStatus, patch?: Partial<...>) => Effect.Effect<void>
  readonly touchHeartbeat: (childSessionID, snapshot: { turnCount; toolCallCount; tokensUsed }) => Effect.Effect<void>
  readonly get: (childSessionID) => Effect.Effect<SubagentRecord | undefined>
  readonly list: (filter?: { parentSessionID?; status? }) => Effect.Effect<SubagentRecord[]>
  readonly snapshot: Effect.Effect<ReadonlyArray<SubagentRecord>>   // 深拷贝，供 TUI
  readonly activeCount: Effect.Effect<number>
  readonly activeCountByType: (subagentType: string) => Effect.Effect<number>
  readonly cancel: (childSessionID) => Effect.Effect<void>
  readonly startWatcher: Effect.Effect<void>   // 失联检测循环
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SubagentRegistry") {}
export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [EventV2.node] })
```

- [ ] **Step 1: 写失败测试**（`packages/core/test/session/subagent-registry.test.ts`）：注册→active→completed 全状态迁移；transition 非法迁移抛 `InvalidTransition`；cancel 传播；snapshot 深拷贝不共享引用；activeCount 计数
- [ ] **Step 2: 跑测试确认失败**：`cd packages/core && bun test test/session/subagent-registry.test.ts` → FAIL（module not found）
- [ ] **Step 3: 实现 `make`**：SynchronizedRef 三表（pending/active/completed 合并为一张 Map + status 字段即可，简化）；`transition` 用 `SynchronizedRef.updateEffect` 原子改；`touchHeartbeat` 更新 lastHeartbeatAt + 快照计数
- [ ] **Step 4: 实现 `startWatcher` 失联检测**：`Effect.repeat(Schedule.spaced(Duration.seconds(30)))` 每 30s 对 active 记录检查 `Date.now() - lastHeartbeatAt > 90_000` → 标 `lost` + publish EventV2 事件（见 Task 5 事件定义）；`Effect.forkScoped` 启动
- [ ] **Step 5: 跑测试通过**：`cd packages/core && bun test test/session/subagent-registry.test.ts` → PASS
- [ ] **Step 6: 挂 node（审计修正——不进 SessionRuntime instance）**：注册表用 `makeGlobalNode`（与 `background-job.ts:379`、`store.ts:63`、`runtime.ts:196`、`iteration-budget.ts:240` 一致）。**不要**挂进 `runtime.ts` 的 per-session `makeInstance` 束（那是每 drain 一个实例，如 iteration-budget.ts:105 在束内 `yield* IterationBudget.make`）——注册表是进程全局三表，跨 session 共享。正确挂法：全局 node + **消费方 deps**（`taskHostNode`、TUI 读取点、core task.ts 用 `serviceOption`——同 v2-host-bridges.ts:86-87 取 SessionExecution 的既有模式）；确认 `layerForTest` 可注入
- [ ] **Step 7: typecheck + Commit**

---

## Task 2: 前台真等待 + 结构化结果契约（G1/G7 核心）

**Files:**
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（`promptAndWait` 改为真等待；返回结构化字段）
- Modify: `packages/core/src/tool/task.ts`（Output schema 加 structured 字段；**Host.run 返回类型同步扩展**——task.ts:63-69 的 Host 接口必须加 structured，只改 Output 不够）
- Create: `packages/opencode/test/tool/v2-task-host.test.ts`

**Interfaces:**
- Consumes: `SubagentRegistry`（Task 1）、`SessionStore.context`（v2-host-bridges **已有 store 依赖**，无需加 SessionV2 deps）、`EventV2`
- Produces:
```ts
// core TaskTool.Output 扩展（保持向后兼容：title/output 必填，新增可选）
export const Output = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  task_id: Schema.String.pipe(Schema.optional),
  sessionID: Schema.String.pipe(Schema.optional),
  background: Schema.Boolean.pipe(Schema.optional),
  structured: Schema.optional(Schema.Struct({
    // exit 字面量集（审计修正：含 running——后台 spawn 返回时 job 刚启动未完成）
    exit: Schema.optional(Schema.Literal(["running", "completed", "failed", "cancelled", "timeout", "budget_exhausted"])),
    turns: Schema.optional(Schema.Number),
    usage: Schema.optional(Schema.Struct({ input: Number, output: Number, cost: Number })),
    error: Schema.optional(Schema.String),
    resumeFrom: Schema.optional(Schema.String),   // childSessionID，供续跑
  })),
})
// v2-host-bridges 内部
const waitForCompletion = (childID: SessionID, timeoutMs: number) =>
  Effect.Effect<SessionMessage.Message[] | undefined>
  // 真等待：轮询 store.context(childID)（现有依赖，SessionStore.context = SessionHistory.load）
  // 直到最后一条 assistant 消息 time.completed 存在或超时
```

- [ ] **Step 1: 写失败测试**（`v2-task-host.test.ts`）：用**测试 layer 注入**（先例 opencode/test/tool/task.test.ts 的 layer 模式、runtime.ts:194 layerForTest——**不用 mock/globalThis**，遵守仓库测试规范）构造 SessionStore/execution/AgentV2 测试层，断言前台 task 返回的 `structured.exit === "completed"` 且 output 含子代理最终文本；后台 task 返回 `background: true` + `task_id` + `structured.exit === "running"`（审计修正：后台 spawn 返回时未完成，**不得**标 completed）
- [ ] **Step 2: 跑测试确认失败**：`cd packages/opencode && bun test test/tool/v2-task-host.test.ts` → FAIL（structured 不存在）
- [ ] **Step 3: 实现 `waitForCompletion`**：循环 `store.context(childID)`（`Effect.repeat(Schedule.spaced(Duration.millis(500)))` 内轮询，**复用现有 store 依赖，不加 SessionV2**），终止条件：最后一条 assistant 消息 `time.completed` 已存在；超时（`Effect.timeoutFail`，默认 30min 可配）返回 timeout 标记。轮询方案（deprecate plan 定案：`SessionV2.wait` 是 stub 不可用，事件订阅 vs 轮询二选一——**选轮询**，简单可靠，测试友好）
- [ ] **Step 4: 实现结构化返回（审计修正）**：前台：`structured: { exit, turns: registry.get(childID)?.turnCount, usage, resumeFrom: childID }`；**后台：`structured: { exit: "running", resumeFrom: childID }`**（完成态由 Task 5 的注入消息携带，不在此处标 completed）
- [ ] **Step 5: 跑测试通过 + 回归**：`bun test test/tool/v2-task-host.test.ts` + `cd packages/core && bun test test/tool/task.test.ts`
- [ ] **Step 6: typecheck + Commit**

---

## Task 3: 深度守卫 + 并发软上限（G3/G4）

**Files:**
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（run 开头）
- Modify: `packages/core/src/tool/task.ts`（execute 开头 + 动态描述）
- Create: `packages/core/test/tool/task-budget.test.ts`

**Interfaces:**
- Consumes: `SubagentRegistry.activeCount`、`SubagentRegistry.activeCountByType`（⚠️ core `Config.Info` **无** `subagent_depth` 字段——已核实，深度上限用模块常量 `MAX_SUBAGENT_DEPTH = 1`，对齐 grok-build 的常量做法；不做配置项，YAGNI）
- Produces:
```ts
// task.ts execute 开头（core 层，薄壳内可做）
// 审计修正：以下阶梯是并发（concurrency）上限，命名用 CONCURRENCY_* 而非 DEPTH_*
const CONCURRENCY_SOFT_CAP = 4, CONCURRENCY_HARD_CAP = 7
const checkSpawnBudget = (registry, subagentType) => Effect.Effect<void>
// 阶梯语义：
//   active < 4          → 放行
//   4 <= active < 7     → 放行但 description 提示"当前已有 N 个子代理运行，如非必要请减少并行"
//   active >= 7         → ToolFailure("Too many active subagents (N). Solve the task yourself or wait.")
// 同类上限（可选配置）：activeCountByType(type) >= 2 → 同类型拒绝
// 注（审计）：IterationBudget.acquireAgentGuard/activeCap 在 V2 无消费者（唯一生产消费者是 v1 task.ts:362），
//   本表另建并发计数是有意决策——防后人误判平行
```

- [ ] **Step 1: 写失败测试**（`task-budget.test.ts`）：注册表 active=7 时 execute 抛 ToolFailure；active=4 时放行且 description 含提示；同类 count>=2 拒绝
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `checkSpawnBudget`**：core task.ts execute 里 `SubagentRegistry` serviceOption（无注册表则跳过——保持薄壳可独立测试）；读 `activeCount` 阶梯判断
- [ ] **Step 4: 动态描述**：`description` 改为函数（`Tool.make` 支持时用闭包读 registry；不支持则改为 execute 内 `ToolFailure` 带提示——**先做硬拒绝版，动态描述后置**，避免阻塞）
- [ ] **Step 5: 深度守卫（v2-host-bridges）**：`store.get(parentID)` 后沿 parentID 链上溯计数 depth（循环最多 10 次防环），`depth >= MAX_SUBAGENT_DEPTH (1)` → ToolFailure("Subagent depth limit reached")
- [ ] **Step 6: 跑测试通过 + 回归**
- [ ] **Step 7: typecheck + Commit**

---

## Task 4: 子权限继承 + capability 过滤（G5）

**Files:**
- Create: `packages/core/src/session/subagent-permissions-v2.ts`（**迁移 v1 函数**，见下）
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（子 session 创建时写 permission）
- Create: `packages/opencode/test/tool/v2-task-permission.test.ts`

**⚠️ 不平行约束（全局约束 2）**：v1 已有 `deriveSubagentSessionPermission`（`packages/opencode/src/agent/subagent-permissions.ts`，50 行）。其唯一引用是 v1 `opencode/src/tool/task.ts`（死路径）。**本 Task = 迁移复用**：把该函数**移动**到 `core/src/session/subagent-permissions-v2.ts`。

**🔴 P0 前置（审计发现——不修则 G5 落空）**：`PermissionV2.configured()`（permission.ts:141-149）只读 `agent.permissions` + savedRules，**session.permission 列无任何 V2 执行消费点**。写了 session.permission 也没人读。必须追加：
- **扩展 `PermissionV2.configured`** 合并 session 作用域规则（约束 1 允许"只扩展"）：`configured(sessionID, agentID)` 内把 `sessions.get(sessionID).permission`（V1 Ruleset）**就地转换**为 V2 形状并合并进返回 rules。
- **✅ 存储载体决策（用户已确认：d —— configured 就地转换，2026-08-03）**：不迁移 SessionTable.permission 列类型（保持 `PermissionV1.Ruleset`——sql.ts:50）、不塞 metadata 列、不用 PermissionSaved 通道（已核实：那是"用户 allow-always 审批记忆"的项目级表，permission/saved.ts，语义不对）。改动集中在 `configured()` 一个函数 + 一个 V1→V2 规则转换器（~10 行：`{permission,pattern,action}` → `{action,resource,effect}`），无存储迁移风险。
- **✅ writable 派生决策（用户已确认：a —— 纯 ruleset 派生，2026-08-03）**：不给 AgentV2.Info 加 writable 字段（schema 零改动）；`isWritable = evaluate("edit", "*", subagent.permissions).effect === "allow"`（v1 默认分支逻辑，去掉 v1 的 `subagent.writable` 显式字段分支）。

**⚠️ 迁移量上调（审计）**：v1 `{permission, pattern, action}` → V2 `{action, resource, effect}` 是**规则形状改写**，非改名。且 `test/agent/subagent-permissions-write-deny.test.ts` 和 `test/agent/plan-mode-subagent-bypass.test.ts` **两个**测试消费者都要处理（plan 原只列前者）。

**Interfaces:**
- Consumes: `AgentV2.Info.permissions`、`PermissionV2.merge`、`PermissionV2.configured`（**扩展点**）、v1 `deriveSubagentSessionPermission` 逻辑（迁移源）
- Produces:
```ts
// 迁移自 v1 subagent-permissions.ts（规则形状改写 V1→V2 + capability 扩展）
export const deriveV2Permission = (input: {
  parentPermissions: PermissionV2.Ruleset
  subagent: AgentV2.Info
  capability?: "read-only" | "read-write" | "execute" | "all"
}) => PermissionV2.Ruleset
// 语义（v1 同款 + capability）：
// 1. 继承父的 deny + external_directory 规则（硬上限）
// 2. 默认 deny todowrite/task（除非子自身允许——递归守卫）
// 3. writable 派生：子自身 edit 允许 → writable；否则 deny edit + bash（v1 同款）
// 4. capability="read-only" → 额外 deny edit/write/apply_patch/bash 全部写路径
//    capability="read-write" → deny bash（可写但不可执行 shell）
//    capability="execute"    → 允许 bash 但 deny edit/write
//    capability="all"        → 不额外过滤（默认）
```

- [ ] **Step 1（✅ 决策已定案，2026-08-03 用户确认）**：存储载体 = d（configured 就地转换 V1→V2）；writable = a（ruleset 派生）。无停下报告点，直接实施
- [ ] **Step 2: 写失败测试**：read-only 子代理 session permission 含 edit/bash deny；read-write 含 bash deny 但 edit allow；writable 派生正确；父 deny 继承（**迁移后行为与 v1 测试断言一致**——`subagent-permissions-write-deny.test.ts` + `plan-mode-subagent-bypass.test.ts` 两个测试的断言都复用）
- [ ] **Step 3: 跑测试确认失败**
- [ ] **Step 4: 迁移 `deriveV2Permission`**：从 `opencode/src/agent/subagent-permissions.ts` 移动函数到 `core/src/session/subagent-permissions-v2.ts`，**规则形状改写** V1→V2（{permission,pattern,action} → {action,resource,effect}），加 capability 分支；`isWritable` 用 ruleset 派生（edit allow → writable，去掉 v1 writable 字段分支）。**逻辑主体（继承/递归守卫）保留**
- [ ] **Step 5: 扩展 `PermissionV2.configured`**（P0 落地）：`configured(sessionID, agentID)` 读 session 行 permission（V1 Ruleset）→ 就地转换 V2 形状 → 合并进返回 rules（父规则在前、子规则在后，findLast 生效）；新增 V1→V2 规则转换器（~10 行）；更新 permission.ts 测试
- [ ] **Step 6: v2-host-bridges 接线**：子 session 创建时（v2-host-bridges.ts:125-148 的 `SessionV1.SessionInfo.make({...})`）把 `deriveV2Permission(...)` 写入 SessionInfo.permission（V1 形状——deriveV2Permission 输出需转回 V1 形状，或直接以 V1 形状实现输出：**实施者注意**：deriveV2Permission 内部可用 V2 语义，落库时转 V1 形状存入 permission 列，configured 读取时再转回——转换器双向）
- [ ] **Step 7: 跑测试通过 + 回归**（两个 v1 测试在新位置继续绿 + permission 测试）
- [ ] **Step 8: typecheck + Commit**

---

## Task 5: 后台完成通知（G2）+ 失联处理（G6）

**Files:**
- Modify: `packages/core/src/session/subagent-registry.ts`（lost 事件发布）
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（后台完成 inject 父）
- Modify: `packages/schema/src/session-event.ts`（新增 Subagent 事件）
- Create: `packages/opencode/test/tool/v2-task-background.test.ts`

**Interfaces:**
- Consumes: `EventV2.publish`、`SessionInput.admit` + `execution.wake`（**不用 SessionV2.prompt**——taskHostLayer 显式回避 SessionV2 防循环，v2-host-bridges.ts:74；用 promptAndWait 同款组件 v2-host-bridges.ts:163-169）
- Produces（schema 新增，`packages/schema/src/session-event.ts`）：
```ts
// SessionEvent.Subagent 命名空间（对齐 Shell 命名空间模式）
export namespace Subagent {
  export const Completed = Event.define({ type: "session.next.subagent.completed",
    schema: { ...Base, childSessionID: String, subagentType: String,
      output: String, usage: Schema.optional(...), resumeFrom: String } })
  export const Failed = Event.define({ type: "session.next.subagent.failed",
    schema: { ...Base, childSessionID: String, subagentType: String, error: String, resumeFrom: String } })
  export const HeartbeatLost = Event.define({ type: "session.next.subagent.heartbeat_lost",
    schema: { ...Base, childSessionID: String } })
  export const Started = Event.define({ type: "session.next.subagent.started",
    schema: { ...Base, childSessionID: String, subagentType: String, parentSessionID: String } })
}
// 注册到 Definitions inventory（event-manifest.test.ts 同步更新——沿用 Shell.Progress 加入的先例）
// 审计补充：durable vs live-only 需决策——DurableDefinitions 是独立 inventory（session-event.ts:483）；
// 先例 shell.progress 是 live-only（不入 durable）。Subagent 四事件是否进 durable stream（影响 replay/SDK 面）
// 由实施者 Step 1 决策：建议 Completed/Failed 进 durable（结果可回放），Started/HeartbeatLost 只 live-only。
// 注意：manifest 测试有两处——schema/test/event-manifest.test.ts 和 opencode/test/event-manifest.test.ts，都要更新。
```

- [ ] **Step 1（决策）**：durable vs live-only 分配（建议：Completed/Failed durable，Started/HeartbeatLost live-only）→ 产出记录
- [ ] **Step 2: 写失败测试**（`v2-task-background.test.ts`）：后台 task 完成后父会话收到 inject 消息（含 `<task_result>` 结构化信封）；失败收到 `<task_error>`
- [ ] **Step 3: 跑测试确认失败**
- [ ] **Step 4: schema 新增 Subagent 事件** + 更新**两处** manifest 测试（`schema/test/event-manifest.test.ts` + `opencode/test/event-manifest.test.ts`，复用 Shell.Progress 加入时的断言模式）
- [ ] **Step 5: 实现后台通知（审计修正——不用 onPromote）**：`background.start` 后 **fork 一个 `background.wait({id: childID})` 观察纤维**（Effect.forkScoped 进 session scope，先例 v2-host-bridges.ts:296 forkIn）；wait 返回后：构造信封文本（codex InterAgentCommunication 风格：`<task id=... state=completed><task_result>output</task_result></task>`）→ `SessionInput.admit(db, events, {sessionID: 父, ...})` + `execution.wake(父)` 注入**父会话**（synthetic 文本消息，agent 用父当前 agent）+ `SubagentRegistry.transition(completed, patch)`（patch 含 job 终态，host 侧传入——见 Task 1 方向修正）+ publish `Subagent.Completed`。**onPromote 只留给 Task 8 前台转后台路径**
- [ ] **Step 6: 实现失联处理**：`startWatcher` 每 30s 检查 active 记录：`execution.active`（**现有 V2 信号**，`Effect<ReadonlySet<SessionID>>`）不含 childID 且注册表 `lastHeartbeatAt` 超 90s → 标 `lost` + publish `Subagent.HeartbeatLost`；v2-host-bridges 订阅该事件（EventV2 订阅）→ 父会话 inject `<task_error>subagent lost</task_error>` + `background.cancel(childID)`。**心跳来源**：前台/后台子代理运行期间，`touchHeartbeat` 由 `waitForCompletion` 轮询循环顺带调用（轮询即心跳，不新增独立心跳机制——**不平行**）；execution.active 作为 drain 活跃的权威信号
- [ ] **Step 7: 跑测试通过 + 回归**（`packages/schema` 测试、`packages/core` 测试）
- [ ] **Step 8: typecheck + Commit**
- **备注（审计）**：v1 退役后 loop-control real hooks 的 `SubagentCompleted/Failed` 消费分支（loop-control-host.ts:139-148）失去发布方——**不桥接是有意决策**（新设计前台 drain 忙等、后台 drain 结束，WorkerState 唤醒语义用不上），在代码注释中明说防误判。

---

## Task 6: resume 身份校验（G8）+ SubagentIdentity

**Files:**
- Create: `packages/core/src/session/subagent-identity.ts`
- Create: `packages/core/test/session/subagent-identity.test.ts`
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（task_id 分支接校验）

**Interfaces:**
- Consumes: `SessionStore.get`、`AgentV2.get`
- Produces:
```ts
export class ResumeIdentityMismatch extends Schema.TaggedErrorClass<ResumeIdentityMismatch>()(
  "Subagent.ResumeIdentityMismatch",
  { childSessionID: Schema.String, reason: Schema.String },
) {}
export const validateResumeIdentity = (input: {
  child: SessionSchema.Info          // 目标 session
  parentSessionID: SessionSchema.ID
  subagentType: string
  requestedModel?: { modelID; providerID }
}) => Effect.Effect<void, ResumeIdentityMismatch>
// 校验三点（AgentV2 无 persona 概念——已核实 schema，persona 校验留到定义层引入 persona 时再加）：
// 1. child.parentID === parentSessionID（只能续自己 spawn 的）
// 2. child.agent === subagentType（agent 名匹配）
// 3. model 源锁定：requestedModel 若与 child.model 不同 → 忽略请求、用 child 的（soft-ignore，不报错）
// 审计备注：requestedModel 目前无来源（TaskTool.Input 无 model 字段——core/src/tool/task.ts:29-40；
//   host input 也无 model——task.ts:52-62）——本参数标注为接口预留（未来 fork_mode/spawn 覆盖模型时启用），
//   当前实现只校验 1/2 点，第 3 点预留。
```

- [ ] **Step 1: 写失败测试**：parentID 不匹配拒绝；agent 名不匹配拒绝；model 不同被软忽略（返回 child 的 model）；匹配通过
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `validateResumeIdentity`**：纯函数 + TaggedErrorClass（三点校验）
- [ ] **Step 4: v2-host-bridges 接线**：task_id 分支（现在 110-113 行只查存在）→ 加 `validateResumeIdentity`，失败返回 ToolFailure（消息含 reason），不静默续跑；成功续跑时 model 用 child 的（忽略 host 传入）
- [ ] **Step 5: 跑测试通过 + 回归**
- [ ] **Step 6: typecheck + Commit**

---

## Task 7: per-agent 迭代预算（G9 预算轴 1）+ cap 耗尽收尾

**Files:**
- Modify: `packages/core/src/tool/task.ts`（注册时带 steps 上限）
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（waitForCompletion 检测 budget_exhausted）
- Modify: `packages/core/src/session/runner/max-steps.ts`（确认/新增 budget_exhausted stop reason）
- Create: `packages/opencode/test/tool/v2-task-budget-exhaust.test.ts`

**Interfaces:**
- Consumes: `AgentV2.Info.steps`、`SubagentRegistry.turnCount`、`max-steps.ts`（已核实：`llm.ts:571` `isLastStep`，最后一步 `toolChoice:"none"` + 注入 MAX_STEPS_PROMPT）
- Produces:
```ts
// max-steps.ts 已实装：llm.ts:571 isLastStep = agent.info.steps 存在且 currentStep >= steps
// 耗尽信号 = 该轮 tools:[] + toolChoice:"none" + 注入 MAX_STEPS_PROMPT 文本
// v2-host-bridges waitForCompletion 终止条件扩展：
//   最终 assistant 消息存在且其 turn 内无工具调用 + content 含 MAX_STEPS_PROMPT 特征
//   （或 runner 暴露耗尽标记）→ structured.exit = "budget_exhausted", structured.resumeFrom = childID
```

- [ ] **Step 1: 确认耗尽信号**：读 `packages/core/src/session/runner/llm.ts:565-585`——耗尽 turn 的特征（tools:[] + toolChoice:"none" + MAX_STEPS_PROMPT 注入）。确认 assistant 消息在 DB 里能否区分"正常完成"与"耗尽完成"（产出记录，**只读，不新建**）
- [ ] **Step 2: 写失败测试**：子代理 steps 耗尽 → 父收到 `structured.exit === "budget_exhausted"` + `resumeFrom` 指向 childID
- [ ] **Step 3: 实现**：waitForCompletion 检测耗尽标记（**优先：runner/DB 已有字段；否则：最后 assistant 无工具调用 + finish 非 error 且 messages 数 == steps**——从 SubagentRegistry.turnCount 与 AgentV2.Info.steps 比对判定，不解析文本）；`SubagentRegistry` 记录 `exit: "budget_exhausted"`；task 工具输出 `structured` 带 resumeFrom（父模型据此决定续跑：`task_id: <resumeFrom>`）
- [ ] **Step 4: 跑测试通过 + 回归**
- [ ] **Step 5: typecheck + Commit**
- （耗尽信号不可靠识别 → 停下报告，不自行补 runner 内核）

---

## Task 8: 等待预算（前台超时自动转后台）

**Files:**
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（前台 waitForCompletion 包 timeout）
- Create: `packages/opencode/test/tool/v2-task-promotion.test.ts`

**Interfaces:**
- Consumes: `BackgroundJob.promote`、`BackgroundJob.waitForPromotion`（已核实：start 对同一 running id 幂等，background-job.ts:223-226）
- Produces:
```ts
// 前台语义（对齐 grok-build await-budget）：
// waitForCompletion 包 Effect.timeoutFail({ duration: Duration.minutes(2) })
// 超时 → background 接管同一 childID → 返回 { background: true, task_id, structured.exit:"running" }
// 父模型收到"已在后台继续运行"而非报错（不丢子任务）
// 审计修正（防二次 admit）：接管用的 run 必须是 wait-only effect（只轮询 store.context），
//   禁止复用 promptAndWait（它含 admit——v2-host-bridges.ts:160-168，复用会再 admit 一条 prompt）
```

- [ ] **Step 1: 写失败测试**：waitForCompletion 超时 → 返回 background:true + task_id + `structured.exit === "running"`；子任务仍在跑（background job 存在）；**断言子 session 只有一条 user 消息（无二次 admit）**
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：前台路径 `waitForCompletion(...).pipe(Effect.timeoutFail(Duration.minutes(2)), Effect.catchTag(TimeoutError, ...→ background 接管))`；接管 run = **wait-only effect**（新建 `waitOnly(childID)`：只轮询 store.context，不含 admit）；`background.start` 复用 childID（幂等——background-job.ts:223-226 对同一 running id 返回 existing）；返回 `{background: true, task_id, structured: {exit: "running"}}`。**双超时共存说明（审计）**：Task 2 的 waitForCompletion 自带 30min 超时，Task 8 外层 2min timeoutFail 先触发——语义是"2min 内没完成就转后台"，外层优先，30min 只兜底前台极端场景
- [ ] **Step 4: 跑测试通过 + 回归**
- [ ] **Step 5: typecheck + Commit**

---

## Task 9: 生命周期 hook（G9）—— data-only contributor

**Files:**
- Create: `packages/core/src/session/subagent-lifecycle.ts`
- Create: `packages/core/test/session/subagent-lifecycle.test.ts`
- Modify: `packages/core/src/session/subagent-registry.ts`（transition 时触发 hook）

**Interfaces:**
- Consumes: `SubagentRegistry`
- Produces:
```ts
export type SubagentLifecycleEvent =
  | { _tag: "Spawn"; childSessionID; parentSessionID; subagentType; address }
  | { _tag: "Start"; childSessionID; turnCount: 0 }
  | { _tag: "Turn"; childSessionID; turnCount; toolCallCount; tokensUsed }
  | { _tag: "Complete"; childSessionID; exit; resumeFrom? }
  | { _tag: "Fail"; childSessionID; error; resumeFrom? }
  | { _tag: "Abort"; childSessionID; reason: "parent_interrupt" | "hard_abort" | "cancel" }
  | { _tag: "HeartbeatLost"; childSessionID }
  | { _tag: "SessionIdle"; sessionID }
export interface Contributor {
  readonly name: string
  readonly version: number
  readonly on?: {
    readonly [K in SubagentLifecycleEvent["_tag"]]?: (
      event: Extract<SubagentLifecycleEvent, { _tag: K }>,
    ) => Effect.Effect<void>
  }
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SubagentLifecycle") {}
// 语义（grok-build contributor 模式）：
// 1. data-only 输入——hook 收到纯数据，无 loop 引用，不能改循环行为
// 2. 能力注入——hook 要发遥测/写日志，能力在注册时注入
// 3. 错误隔离——hook 抛错只记日志（Effect.ignore + logWarning），不影响 loop
// 4. 版本化——contributor 带 version，注册时校验
```

- [ ] **Step 1: 写失败测试**：注册 contributor 后 registry.transition(active) 触发 onStart；hook 抛错不影响 registry 状态迁移；版本不匹配拒绝注册
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 contributor 注册表**：`SynchronizedRef<Map<name, Contributor>>`；`dispatch(tag, data)` 遍历订阅者，每个包 `Effect.ignore` + 日志
- [ ] **Step 4: registry 接线**：`register/transition/touchHeartbeat/cancel` 各状态点 dispatch 对应事件
- [ ] **Step 5: 跑测试通过 + 回归**
- [ ] **Step 6: typecheck + Commit**
- **备注（审计——双通道定位）**：Task 5 的 EventV2 事件（`Subagent.Completed` 等）与本 Task 的 lifecycle hooks 是**同一生命周期点的两条通道**——定位必须写明：**事件 = 对外投影**（SDK/TUI/replay 消费），**hooks = 内部扩展点**（遥测/审计插件注册）。禁止消费者两边接线形成事实双通道；实现时 lifecycle 从 registry transition 触发，事件由 host 发布，二者不互相依赖。

---

## Task 10: 定义层——继承 + 覆盖优先级 + 来源元数据（G10）

**Files:**
- Modify: `packages/core/src/config/agent.ts`（ConfigAgent.Info schema）
- Modify: `packages/core/src/config/plugin/agent.ts`（ConfigAgentPlugin 解析）
- Modify: `packages/core/src/agent.ts`（AgentV2.Info 补充透传）
- Create: `packages/core/test/config/agent-plugin.test.ts`

**Interfaces:**
- Consumes: `ConfigAgent.Info`（现有）、`ConfigAgentV1.Info`（v1 兼容解码）
- Produces:
```ts
// ConfigAgent.Info schema 新增字段（全部 optional，向后兼容）——已核实现有字段：model/variant/request/system/description/mode/hidden/color/steps/disabled/permissions
extends: Schema.optional(Schema.String),          // 继承的父 agent 名
capability: Schema.optional(Schema.Literals(["read-only","read-write","execute","all"])),
workspace: Schema.optional(Schema.String),        // 子代理工作目录（相对项目根）
// AgentV2.Info 新增（透传给运行时）：
capability: Schema.optional(...),
workspace: Schema.optional(Schema.String),
// 覆盖优先级（ConfigAgentPlugin 解析时实现）：
//   显式字段（agent 自身） > extends 继承的父 agent 字段 > 全局默认
//   注意：V2 的 system prompt 字段名是 `system`（非 v1 的 `prompt`），继承时按字段名合并
// 来源元数据（审计修正——_source 改声明式 optional schema 字段）：
//   AgentV2.Info 是 readonly Schema.Struct，仓库禁 as any / Schema.mutable；
//   落地方式：AgentV2.Info 加 `source?: Record<string, "explicit" | "inherited" | "default">` 声明式 optional 字段
//   （不进持久化，ConfigAgentPlugin 解析时填充，运行时只读）
// merge 语义（审计修正）：PermissionV2.merge 实为 flat 拼接（permission.ts:92-94），
//   覆盖靠规则顺序（findLast 生效）——继承时"父规则在前、子规则在后"的顺序约定必须写明
```

- [ ] **Step 1: 写失败测试**（`agent-plugin.test.ts`）：agent 定义 `{extends: "explore", capability: "read-write"}` → 解析结果继承 explore 的 permissions/system，capability 覆盖为 read-write；无 extends 时用默认；来源元数据正确标记 explicit/inherited
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: schema 扩展（审计修正——agentKeys 必须同步）**：ConfigAgent.Info + AgentV2.Info 加字段（全部 optional）；**同时把 `extends`/`capability`/`workspace` 并入 `config/plugin/agent.ts:32-44` 的 `agentKeys` 集合**——否则 decode() 的 legacy 判定（:162 "含 agentKeys 之外的键"）会把写了新字段的 agent 误判为 v1 legacy → 走 ConfigAgentV1 解码 + migrate → 新字段丢失（功能性 bug）
- [ ] **Step 4: 实现继承解析**：ConfigAgentPlugin 的 `ctx.agent.transform` 内，先按依赖序展开 extends（BFS/DFS，检测环：A→B→A 报错）；合并规则：子显式字段覆盖父（permissions 拼接顺序约定：父在前、子在后，findLast 生效）；`source` 声明式字段标记每个字段来源
- [ ] **Step 5: 跑测试通过 + 回归**（packages/opencode/test/agent/agent.test.ts 现有 755 行不破）
- [ ] **Step 6: typecheck + Commit**

---

## Task 11: capability 运行时接线（G10 后半 + G5 深化）

**Files:**
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（deriveV2Permission 加 capability 过滤——Task 4 已做基础，这里接定义层字段）
- Modify: `packages/core/src/tool/registry.ts`（materialize 时按 capability 过滤工具——工具注册层过滤，与 permission 正交）

**Interfaces:**
- Consumes: `AgentV2.Info.capability`（Task 10）、`ToolRegistry.materialize`（**现状签名 `materialize(permissions?)` 只收 permissions——已核实 llm.ts:572 调用处 `materialize(agent.info?.permissions)`**）
- Produces:
```ts
// 签名扩展（唯一调用点 llm.ts:572，一并改）：
materialize(agent?: { permissions?: PermissionV2.Ruleset; capability?: "read-only" | "read-write" | "execute" | "all" })
// registry.ts materialize 过滤（capability 正交层）——builtins 实际 16 个工具（builtins.ts:40-57）：
//   bash / apply_patch / edit / glob / grep / lsp / plan-enter / plan-exit / question /
//   read / skill / task / todowrite / webfetch / websearch / write（⚠️ 无 list 工具——审计修正）
//   read-only  → 只保留 read/grep/glob/webfetch/websearch（+ skill/question 判定）+ 只读 bash
//   read-write → 上述 + edit/write/apply_patch，禁 bash
//   execute    → 上述 + bash，禁 edit/write/apply_patch
//   all        → 不过滤
// 实现位置：registry.materialize 读 capability → 过滤 definitions（permissions 过滤保持现状，capability 为第二道正交过滤；
//   有先例 whollyDisabled —— registry.ts:112-113；builtins.ts:27-28 注释明确 "filtering belongs to a future materialization phase"，
//   与仓库意图一致）
```

- [ ] **Step 1: 写失败测试**：AgentV2.Info capability="read-only" 的 agent materialize 出的 definitions 不含 edit/write/bash；read-write 含 edit 不含 bash；capability 缺省时行为与现状完全一致（回归关键）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 扩展 materialize 签名**：`materialize(agent?: { permissions?; capability? })` + 更新 llm.ts:572 唯一调用点；加 capability 过滤分支（工具名 → 能力类别映射表）；bash 只读模式：`bash` 工具保留但 execute 时受限（或描述提示只读——**先做工具级过滤，bash 内部只读 gate 后置**）
- [ ] **Step 4: 跑测试通过 + 回归**（现有 materialize 测试必须全绿——签名扩展是向后兼容的）
- [ ] **Step 5: typecheck + Commit**

---

## Task 12: workspace/cwd 字段（沙盒第一层）

**Files:**
- Modify: `packages/core/src/tool/task.ts`（Input 加 cwd/workspace 可选）
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（子 session 创建时用 cwd 覆盖 directory）
- Modify: `packages/core/src/config/agent.ts`（定义层 workspace——Task 10 已加，这里接线）
- Create: `packages/opencode/test/tool/v2-task-workspace.test.ts`

**Interfaces:**
- Consumes: `TaskTool.Input`、`ProjectV2.resolve`
- Produces:
```ts
// core TaskTool.Input 新增：
cwd: Schema.optional(Schema.String).annotate({ description: "Subagent working directory (relative to project root)" }),
// v2-host-bridges：子 session 创建时
//   directory = input.cwd ? path.resolve(project.directory, input.cwd) : parent.location.directory
//   校验：resolve 后必须在 project.directory 内（防逃逸），否则 ToolFailure
// 定义层 workspace 等效：agent 有 workspace 字段 → 同 cwd 处理（显式 task cwd 优先）
```

- [ ] **Step 1: 写失败测试**：cwd="src/module" → 子 session directory 为 project/src/module；cwd="../.." 逃逸 → ToolFailure；agent workspace 字段生效
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：schema 加 cwd；v2-host-bridges 解析 + 逃逸校验（`path.resolve` 后 `startsWith(project.directory + sep)` 检查）
- [ ] **Step 4: 跑测试通过 + 回归**
- [ ] **Step 5: typecheck + Commit**
- （物理沙盒 worktree 隔离 = 第二层，独立后置 Task，见 §后续方向，不在本 plan 主链）

---

## Task 13: fork 模式（G11）——结构化父历史继承

**Files:**
- Modify: `packages/core/src/tool/task.ts`（Input 加 fork_mode）
- Modify: `packages/opencode/src/tool/v2-host-bridges.ts`（子 session 创建时注入父历史）
- Create: `packages/opencode/test/tool/v2-task-fork.test.ts`

**Interfaces:**
- Consumes: v1 `buildForkPrompt`（`core/src/session/loop-control/fork-mode.ts`，26 行——**迁移源**，唯一引用 v1 task.ts 死路径；测试 `fork-mode.test.ts` 需随迁）、`SessionStore.context`（**审计修正：不用 SessionV2.messages**——taskHostLayer 回避 SessionV2 防循环，用已在 deps 的 `store.context(parentID)`，limit 语义自行截取）
- Produces:
```ts
// core TaskTool.Input 新增：
fork_mode: Schema.optional(Schema.Literals(["PromptOnly", "LastNTurns", "FullHistory"])),
// v2-host-bridges：PromptOnly（默认）→ 只 admit prompt（现状）
// LastNTurns/FullHistory → 读取父会话历史（store.context(parentID)），
//   投影为子会话的初始消息再 admit prompt
// 投影规则（结构化继承，非文本 echo）：
//   - 保留：user 消息全文、assistant 最终文本、关键 tool 调用名 + 结果摘要（metadata.output 截断 500 字）
//   - 丢弃：reasoning 全文、工具调用中间产物、附件二进制
```

- [ ] **Step 1: 写失败测试**：fork_mode="LastNTurns" → 子会话初始消息含父最近 50 条投影；FullHistory → 全部；PromptOnly → 仅 prompt
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 迁移 `projectParentHistory`**：`ForkMode` 枚举 + `buildForkPrompt` 的 trace 截断语义从 v1 `fork-mode.ts` **移动**到 core（目的地：`core/src/session/fork-mode.ts`，`fork-mode.test.ts` 随迁），升级为"结构化投影"（保留 tool 名 + 结果摘要）。**枚举迁移复用，不新建枚举**
- [ ] **Step 4: v2-host-bridges 接线**：fork_mode != PromptOnly 时创建子 session 后批量插入投影消息（SessionMessageTable 直插或复用 SessionV2 投影机制——**优先 SessionStore 层插入**，避免污染 runner 投影逻辑）
- [ ] **Step 5（审计硬细节——seq 分配方案）**：SessionMessageTable 有 `uniqueIndex(session_id, seq)`（session/sql.ts:133）——投影消息直插**必须与 SessionInput 的 admitted/promoted seq 分配协同**，否则与 runner 投影撞唯一键。方案（实施者按序选一）：
  a) 先 `SessionInput.admit`（分配 seq），投影消息以 admitted 之后、prompt 之前的 seq 插入
  b) 不用消息直插——投影内容合并进 prompt 文本（退化但零风险，若 a 的 seq 协同成本高）
  → 产出记录，测试断言 seq 不冲突（插入后 `store.context` 顺序正确）
- [ ] **Step 6: 跑测试通过 + 回归**
- [ ] **Step 7: typecheck + Commit**

---

## 执行顺序与验证依赖

```
Task 1（注册表）→ Task 2（真等待+结构化）→ Task 3（深度+并发）
    → Task 4（权限继承）→ Task 5（后台通知+失联）→ Task 6（resume 校验）
    → Task 7（迭代预算）→ Task 8（等待预算）→ Task 9（生命周期 hook）
    → Task 10（定义层继承）→ Task 11（capability 运行时）→ Task 12（workspace）→ Task 13（fork 模式）
```

- 1→2：waitForCompletion 用 registry.turnCount
- 2→3：checkSpawnBudget 用 registry.activeCount
- 1→5：registry 发布 lost 事件
- 4→11：capability 定义层字段 → 运行时过滤
- 10→11/12：定义层 schema → 运行时消费

每 Task 完成后：`cd packages/core && bun typecheck`（或对应包）+ 该 Task 测试 + 相关回归（`test/tool/task.test.ts`、`test/agent/agent.test.ts`、`event-manifest.test.ts`）。

## 后续方向（不在本 plan 主链，记录不执行）

- **物理沙盒（worktree 隔离）**：grok-build 式 `isolation: worktree` + worktree 池 + snapshot_ref + 父 merge diff——依赖 Task 12 的 workspace 机制，量大后置
- **成本预算（全树 token）**：codex RolloutBudget 式，默认关、配置开——用户已确认"记着，有意义但后置"
- **子代理间通信（sibling）**：AgentPath 寻址 + 消息信封——注册表已预留 `address` 字段，二期加
- **动态描述（软提示）**：Task 3 的 4-6 档动态描述——Tool.make 支持函数描述时补
