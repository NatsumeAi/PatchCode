# 审查 Prompt：Loop + Subagent Full Convergence 执行结果

> **用法：** 把本文件**全文**（或从「=== BEGIN REVIEW PROMPT ===」到「=== END REVIEW PROMPT ===」）原样交给另一台高上下文 AI。  
> **审查对象：** 上一次 agent 对 plan 的执行，不是重新实现。  
> **审查标准优先级（用户锁死，审查时必须服从）：**

1. **用户此前写死的全部要求 = 最高优先级**（完整、全部、无 partial、无 bug、不影响既有功能）  
2. **「风险规避 / 先绿测 / 故意缩 scope / 标 PARTIAL 交差」优先级 = 0** —— 不得用这些当免责理由  
3. 执行方若把 G16 写成 “N/A FULL policy 因 V1 仍是 PROD” 之类，你必须**独立裁决**：是诚实 inventory 还是借政策回避 Task 16  

---

=== BEGIN REVIEW PROMPT ===

# 角色

你是**极其严格的代码与交付审查官**（adversarial auditor）。你的任务是审查「Loop + Subagent Full Convergence」这一次 batch 的**执行是否完整、正确、无回归、无半闭合**。

你**不是**实现者的辩护律师。默认立场：

- 执行方的 baseline 自评（FULL）**不可信**，必须用代码 + 测试 + `rg` + 行为路径证明。
- 「测试绿了」≠ 功能完整；「没碰危险文件」≠ 需求已交付。
- 任何 **PARTIAL / 故意 defer / 文档 CLOSED 但代码死/半死 / 只测 happy path** 一律记为 **FAIL** 或 **GAP**，不得粉饰为 FULL。
- 用户明确说过：**风险规避与绿测优先级为零**；**用户完整要求是最高优先级**；**代码无 bug、不影响之前所有功能、完整全部实现、无 partial**。

你有很高上下文预算：**读深、列全、证据化**。允许并鼓励：

- 通读 plan / baseline / 相关 spec / 关键实现文件全文  
- `git show` / `git diff` 三个 commits  
- 跑相关与较广测试套件  
- 对每个 DoD 项给出「证据路径 + 结论 + 严重度」  

**禁止：**

- 改 production 代码（审查默认 **read-only**）。若必须修，先输出完整审查报告，再征询用户。  
- 动 `packages/core/src/memory/**`、memory 相关 plans、memory 未提交改动（**另一 AI 的领地，隔离铁律**）。  
- 用模糊措辞交差（“看起来还行”“大体完成”）。  
- 因为“怕破坏现有功能”而把未接线项合理化成 FULL。

---

# 仓库与基线定位

| 项 | 值 |
|----|-----|
| Workspace root | `/home/huyongjun/openpartner` |
| Repo（git） | `/home/huyongjun/openpartner/opencode` |
| Branch（执行时） | `fork-runtime-loop-f720490219` |
| Plan | `docs/superpowers/plans/2026-08-07-loop-subagent-full-convergence.md` |
| Baseline / 执行方自评 | `docs/superpowers/plans/2026-08-07-loop-subagent-full-convergence-baseline.md` |
| Persona spec | `docs/superpowers/specs/2026-08-07-subagent-persona.md` |
| Dual-path classification | `docs/superpowers/specs/2026-08-07-dual-path-classification.md` |
| Loop design | `docs/loop-design.md` |
| 前序 subagent plan | `docs/superpowers/plans/2026-08-03-subagent-runtime-overhaul.md` |
| Reference（模式参考，非复制） | `/home/huyongjun/reference/`（grok-build persona、hermes iteration_budget、codex SpawnEdge、worktree_pool） |

## 执行 commits（按时间）

审查 diff 范围建议：

```bash
cd /home/huyongjun/openpartner/opencode
git log --oneline 5e7fccc6dc^..e3528cecb4
git show 5e7fccc6dc --stat
git show 204933c588 --stat
git show e3528cecb4 --stat
git diff 5e7fccc6dc^..e3528cecb4 --stat
```

| Commit | 标题 / 声称 |
|--------|-------------|
| `5e7fccc6dc` | `feat(core): close loop-control and subagent convergence gaps` — goal auto-seed、EventBus+SpawnEdge、DoomLoop/CB、parent/child budget、persona、worktree、sibling、tree budget、concurrency、SessionIdle、TUI loop panel；**不删 V1**；**不碰 memory** |
| `204933c588` | `docs: record full-convergence execution audit and DoD status` |
| `e3528cecb4` | `feat(core): complete remaining loop-subagent FULL wiring` — timer inject（`timer_reminder` + delayed first fire）、verifier on all goals + soft auditor fail、ContextEngine compact re-try、treeBudget debit、`peer_message` builtins、SubtaskPart honor+auto-spawn |

**注意：** `git diff 5e7fccc6dc^..e3528cecb4` 可能混入 **memory** 相关文件（如 `session-logs.ts`）——那是**另一 agent 的并行工作**。审查本 batch 时：

- 不要把 memory 文件算作本 plan 交付；  
- 也不要“顺手改”它们；  
- 若 loop commits **错误污染**了 memory，单独标 **ISOLATION VIOLATION**。

---

# 产品架构（审查坐标系）

**声称的 V2 主脊：**

```
SessionV2
  → SessionRunner.llm (drain / turn)
  → SessionRuntime + LoopControlHost.makeSessionHooks
  → core TaskTool
  → tool-host-bridges (host)
  → SubagentRegistry
```

**仍存在的 V1 双轨（执行方 inventory 称仍是 PROD）：**

- `packages/opencode/src/tool/task.ts`  
- `packages/opencode/src/session/prompt.ts` (SessionPrompt)  
- V1 ToolRegistry / `agent/subagent-permissions.ts`  
- `loop-control/fork-mode.ts`（V1 路径）  

审查必须验证：V2 侧新能力是否真的在 **PROD 调用链** 上，而不是只在 test double / dead module 里“存在文件”。

### 单一权威表（plan §0.2）——每项核对「是否仍有双轨活着」

| Concern | 应唯一权威 | 审查问法 |
|---------|------------|----------|
| Subagent lifecycle | `SubagentRegistry` | 是否还有第二状态机？ |
| Heartbeat/stall | registry progress-only + 180s | `loop-control/subagent-heartbeat.ts` 是否仍被 PROD 引用？ |
| 完成 → 父 loop | **双发**：`SessionEvent.Subagent.*` **且** parent `EventBus` SubagentCompleted/Failed，**同一 host choke point** | V2 host 是否真 publish EventBus？是否只 SessionEvent？ |
| Fork 投影 | `session/fork-mode.ts` | 双 fork-mode 是否仍混淆？ |
| Task spawn | core `task.ts` + host bridges | V1 task 是否仍是主路径？V2 是否完整？ |
| SpawnEdge | `spawn-edge.ts` + host/registry | Open→Closed 是否只走一次？double-close 安全？ |
| Goal/verifier | per-session `GoalStore` + LoopControlHost | 空 goal 是否 auto-seed？verifier 是否真跑？ |
| Persona | `persona/*` + EffectiveSubagentConfig | 是否 SystemPart 注入，而非拼进 user text？ |

### 锁定产品决策 D1–D12（不得被执行方静默改口）

| # | 决策 | 审查点 |
|---|------|--------|
| D1 | 空 goal **auto-seed** 首条 user text（≤2k）；`/loop goal` 覆盖；seed 后 verifier **可跑** | 是否又偷偷改成 isExplicit-only？claim 门是否挡死 auto-seed？ |
| D2 | Subagent 完成必须 bridge 到 **parent** EventBus | host `notifyParent`/foreground settle |
| D3 | SpawnEdge V2 host Open@register Closed@terminal | runtime.spawnEdges 或等价 |
| D4 | DoomLoop/CircuitBreaker **进真实 hooks**，非 test-only | loop-control-host 生产路径 |
| D5 | ContextEngine proactive → **真实 compact**（可叠加 token path） | 非仅 counter |
| D6 | fork 文本投影默认；可选 structured；seq-safe | 是否 silent PromptOnly only？ |
| D7 | Persona 7 层；缺文件 soft-fail | loader/resolve/inject/resume/discovery |
| D8 | `isolation?: none\|worktree` + pool + 清理 | escape reject |
| D9 | sibling by registry address | `peer_message` 是否注册进 builtins？deliver 是否 admit？ |
| D10 | tree budget 默认 **off**；on 时 hard stop | debit 是否在 Step.Ended？ |
| D11 | SubtaskPart **不得 silent drop**；转 Task spawn | HTTP toV2Prompt + auto-spawn |
| D12 | V1 删除 **仅 inventory 证明 DEAD 后** | 诚实 keep PROD vs 借口不迁 |

---

# 用户最高优先级验收标准（审查铁律）

对每一项交付，必须用以下标准，而不是执行方的“FULL”标签：

1. **COMPLETE**：plan Task 0–17 与 G1–G18 中**每一条**要么有代码路径 + 测试证据，要么有**用户书面** out-of-scope（本 batch 仅允许：memory 整块、X-4 j/k 等 Task0 已记）。  
2. **NO PARTIAL**：禁止 “focused suite 绿就算 G17 FULL”、“G16 N/A 却把矩阵 CLOSED 当全部完成”。  
3. **NO BUG**：逻辑错误、错误 abort、污染 system prompt、假 terminal、竞态、双 close 炸、budget 误伤 parent-only session 等 → FAIL。  
4. **NO REGRESSION**：不破坏已有 V2 spine、SubagentRegistry、foreground 2min promote、permissions/capability、`/loop` HTTP、progress-only 180s stall、既有 compaction 路径。  
5. **NO RISK-AVOIDANCE ASCOPE**：不得把“为了绿测”弱化 verifier、放宽 DoomLoop 到无意义、StopReminder 永不 fire、peer 写了但没注册、Subtask 只 log 不 spawn 等写成 FULL。  
6. **ISOLATION**：零改动 memory/** 作为本任务目标；若 diff 碰到，区分“并行 agent 文件” vs “本 agent 误改”。

---

# 必读文档顺序（建议）

1. Plan 全文：`2026-08-07-loop-subagent-full-convergence.md`（§0 规则、§0.4 DoD、Task 0–17、§14 矩阵、§15 半闭合禁令）  
2. Baseline：`...-baseline.md`（执行方 DoD 表 —— **当作声称，不是真相**）  
3. Persona spec  
4. Diff 三个 commits 的实现文件  
5. 关键测试文件  

然后对 **G1–G18** 与 **§14 每一行** 独立审计。

---

# 热文件清单（必须逐文件深度读）

## Core — loop / runtime

- `packages/core/src/session/runtime.ts`（circuitBreaker / treeBudget / spawnEdges / agentGuards）  
- `packages/core/src/session/runner/llm.ts`（goal seed、persona SystemPart、tree debit、context engine、SessionIdle）  
- `packages/core/src/session/runner/loop-control-host.ts`（DoomLoop、CB、timer 消费、subagent 事件、WorkerState）  
- `packages/core/src/session/runner/verifier-bi-directional.ts`（timer_reminder vs verifier_reject 通道分离）  
- `packages/core/src/session/runner/context-engine.ts` / compaction 调用链  
- `packages/core/src/session/loop-control/goal-store.ts`（setIfEmpty / isExplicit）  
- `packages/core/src/session/loop-control/timer-daemon.ts`（spaced + delay first fire）  
- `packages/core/src/session/loop-control/event-bridge.ts`  
- `packages/core/src/session/loop-control/spawn-edge.ts`  
- `packages/core/src/session/loop-control/doom-loop.ts`  
- `packages/core/src/session/loop-control/circuit-breaker.ts`  
- `packages/core/src/session/loop-control/iteration-budget.ts`（parent 90 / child 50 / acquireAgentGuard）  
- `packages/core/src/session/loop-control/subagent-heartbeat.ts`、`task-hook.ts`、`fork-mode.ts`（是否仍 DEAD/双轨）  

## Core — subagent / persona / extras

- `packages/core/src/session/subagent-registry.ts`  
- `packages/core/src/session/subagent-lifecycle.ts`  
- `packages/core/src/session/subagent-identity.ts`  
- `packages/core/src/session/persona/*`（schema/loader/resolve/fingerprint/inject/store）  
- `packages/core/src/session/worktree-pool.ts`  
- `packages/core/src/session/sibling-message.ts`  
- `packages/core/src/session/tree-budget.ts`  
- `packages/core/src/session/fork-mode.ts`  
- `packages/core/src/tool/task.ts`  
- `packages/core/src/tool/peer.ts`  
- `packages/core/src/tool/builtins.ts`（是否注册 peer_message）  

## Host / HTTP / TUI / schema

- `packages/opencode/src/tool/tool-host-bridges.ts`（EventBridge、SpawnEdge、persona、worktree、guards、notifyParent）  
- `packages/opencode/src/tool/task.ts`（V1 是否仍 PROD）  
- `packages/opencode/src/session/prompt.ts`  
- `packages/opencode/src/routes/.../handlers/session.ts` 或 `httpapi/handlers/session.ts`（toV2Prompt、SubtaskPart、auto-spawn）  
- `packages/tui/src/feature-plugins/sidebar/loop-panel.tsx`  
- `packages/tui/src/feature-plugins/builtins.ts`  
- `packages/schema/src/agent.ts`、`packages/core/src/config/agent.ts`、`plugin/agent.ts`  

## 测试（至少对照执行方声称）

- `packages/core/test/loop-control/*`（event-bridge、doom-loop、timer-inject、goal-store…）  
- `packages/core/test/runner/llm-loop-control.test.ts`  
- `packages/core/test/runner/loop-control-host-layerreal.test.ts`  
- `packages/core/test/session/persona-resolve.test.ts`  
- `packages/core/test/session/tree-budget.test.ts`  
- `packages/core/test/subagent-identity.test.ts`  
- opencode 侧 task-workspace / task-event-bridge / worktree 等（若存在）  

---

# DoD 审计矩阵（G1–G18）——你必须逐项填

对每一项输出固定结构：

```
### Gx — <标题>
- 执行方声称：FULL / N/A / …
- 代码路径：（文件:行为摘要）
- 测试证据：（测试名 + 你是否实跑）
- 行为是否满足 plan 原文：（是/否/部分）
- 回归风险：
- 判定：PASS | GAP | FAIL | POLICY-OK | NEEDS-USER
- 证据摘录：（短）
- 若 GAP/FAIL：缺什么才算完整；最小补全清单
```

## G1 Goal auto-seed + verifier
Plan：无 `/loop goal` 时 seed；worker claim done 时 verifier 至少审计一次。  
深挖：

- `GoalStore.setIfEmpty` 是否在 drain 路径调用？  
- seed 来源是否 first user text？截断 2k？  
- `/loop goal` 后是否不再被 auto 覆盖？  
- verifier 是否要求 isExplicit？（用户曾反对 isExplicit-only 挡 auto-seed）  
- soft auditor fail 是否避免误 HardAbort，同时 N=8 是否仍 hard-stop？  
- 是否存在 “seed 了但 claim 门导致 verifier 永不跑”？

## G2 /loop same SessionRuntime
- status 读的 goal/budget/terminal/worker 是否与 runner 同一 `SessionRuntime` instance？  
- HTTP `/loop` 解析顺序是否仍正确？

## G3 TimerDaemon 可观测 harness 效果
- StopReminder / WaitIdleBackup / 24h hard_timeout 是否**不仅** EventBus 噪音？  
- `timer_reminder` 与 `verifier_reject` 通道是否分离？  
- StopReminder：**不得**在 drain 一开始 Busy 就立刻污染 system；plan/执行改为 spaced + first fire delay ~5min —— 验证是否正确，是否导致“实际上永不提醒”的假 FULL？  
- WaitIdle：是否仅 `idle_status_check` 等约定条件 inject，而非每个 turn_end 狂刷？  
- 测试是否用 fake clock 覆盖 first fire？

## G4 Subagent → EventBus + SessionEvent + WorkerState
- host 完成/失败是否 `publishSubagentTerminal`？  
- parent WorkerState Waiting→Active on complete？  
- fail policy？  
- 是否只测 unit 不测 host 集成？

## G5 SpawnEdge
- Open at register、Closed at terminal、double-close safe  
- 能否从 status/snapshot 列出？  
- 是否存在 leak（永不 Closed）？

## G6 DoomLoop + CircuitBreaker
- 真实 hooks 接线  
- DoomLoop：重复 assistant / 同 tool —— 注意执行方可能把 key 改成 `name:callID` 提高阈值；审查：**是否过松导致功能名存实亡**，或过严误杀并行 tool？  
- CB open 后 shouldContinue false；`/loop` reset？  
- auditor soft-fail 是否错误地绕过 CB？

## G7 Parent/child IterationBudget + acquireAgentGuard
- parent 90 / child 50（可配置）  
- child 用独立 budget，不吃光 parent  
- V2 spawn 是否 acquireAgentGuard + terminal release？  
- parent-only session 是否无回归？

## G8 ContextEngine real compact
- `shouldProactiveCompact` 是否触发 `compactIfNeeded`（或等价真实路径）？  
- 是否仅 record counter？  
- e3528 声称 re-attempt —— 是否会死循环 compact？是否破坏既有 compaction 测试语义？

## G9 Soft/hard/same-type concurrency
- soft 4–6 提示、hard 7 reject、same-type cap  
- 文案是否进 description 或明确 tool error？

## G10 SessionIdle
- session → idle 是否派发 lifecycle 事件？  
- 谁消费？半实现？

## G11 Persona 全栈（对照 spec 7 层）
逐层：

1. schema  
2. loader（workspace → user → soft-fail）  
3. resolve 优先级 task > agent > none  
4. EffectiveSubagentConfig 持久化（store/metadata/registry）  
5. SystemPart `<persona>…</persona>`（非 user concat）  
6. resume fingerprint / persona pin  
7. discovery IO 行  

缺一层 = GAP。

## G12 Worktree
- isolation=worktree acquire/release  
- 非 git / 失败是否清晰 ToolFailure？  
- path escape reject？  
- 终端是否 cleanup？

## G13 Sibling messaging
- `peer.ts` + `sibling-message.ts`  
- **builtins 是否注册**（e3528 声称加了）  
- address 路由、admit 目标会话  
- capability 限制？

## G14 Tree budget
- 默认 off  
- on 时 Step.Ended debit  
- 超限 terminal.request tree_budget_exhausted  
- 是否误伤未配置 session？

## G15 SubtaskPart
- 不再 silent drop  
- toV2Prompt honor（XML/agents）  
- auto-spawn Task host  
- 失败是否 explicit error？

## G16 V1 dead deletion
**最易被政策洗白的一项。**  
Plan：inventory 后删 DEAD；仍 PROD 则 migrate 或不得假装 CLOSED 成“全收敛”。  

审查：

1. 重跑 inventory `rg`（plan Task 0 命令）  
2. `subagent-heartbeat` / `task-hook` / dual fork-mode 是否仍该删却未删？  
3. 执行方 “N/A FULL policy keep V1” —— 若 V1 仍双轨 spawn/权限，**产品是否仍 half dual-path**？记 GAP 而非 PASS，除非 plan 原文明确 “keep PROD = success”。  
4. 是否存在 “stub 却仍可走通双逻辑”？

## G17 Full regression
执行方写 “FULL for touched surface”。  
**你的标准：** plan 原文要求 `packages/core` + `opencode` + relevant `tui` **全量** pass。  

必须实跑并报告数字：

```bash
cd /home/huyongjun/openpartner/opencode/packages/core && bun test 2>&1 | tail -50
cd /home/huyongjun/openpartner/opencode/packages/opencode && bun test 2>&1 | tail -50
cd /home/huyongjun/openpartner/opencode/packages/tui && bun test 2>&1 | tail -50
# schema if relevant
```

focused 绿 + monorepo 红 = G17 **FAIL/GAP**，不得因“怕跑太久”免检。

## G18 §14 matrix every row CLOSED
对照 plan §14 每一 ID：L-U1…、L-M1…、S-P*、S-D*、S-U*、P-1…、X-1、X-2。  
Baseline 是否空表糊弄？是否 CLOSED 无 test id？

---

# Task 0–17 执行完整性（另一维度）

对每个 Task：

| Task | 主题 | 审查焦点 |
|------|------|----------|
| 0 | Inventory + baseline | 是否诚实 PROD/DEAD？是否冻结合规？ |
| 1 | Goal + verifier | 见 G1 |
| 2 | Timer effects | 见 G3 |
| 3 | EventBus + SpawnEdge | 见 G4/G5 |
| 4 | DoomLoop + CB | 见 G6 |
| 5 | Budget + guard | 见 G7 |
| 6 | ContextEngine | 见 G8 |
| 7 | Concurrency | 见 G9 |
| 8 | SessionIdle + structured bg complete | XML structured payload？ |
| 9 | Fork structured | 单 synthetic message seq-safe？ |
| 10 | Persona | 见 G11 + spec |
| 11 | Worktree | 见 G12 |
| 12 | Sibling | 见 G13 |
| 13 | Tree budget | 见 G14 |
| 14 | SubtaskPart | 见 G15 |
| 15 | TUI loop panel | 是否真显示 goal/budget/terminal/subagent/CB？死面板？ |
| 16 | V1 delete | 见 G16 |
| 17 | Full gate | 见 G17/G18 |

Plan 禁语：`follow-up` / `later` / `deferred` / `good enough` / `intentionally not bridged`。  
`rg` 这些词在 commits 与代码注释中，命中则审查。

```bash
rg -n "intentionally not bridged|TODO.*subagent|FIXME.*loop|deferred|follow-up" \
  packages/core/src packages/opencode/src packages/tui/src \
  --glob '!**/node_modules/**'
```

---

# 半闭合失败模式（plan §15.3）——逐条对打

1. Bridge 写成 future → 必须不存在  
2. Verifier 仅 `/loop goal` → 必须不存在  
3. Persona 仅拼 user prompt → 必须不存在  
4. V1 “compat” 无 inventory → 必须不存在  
5. ContextEngine 仅 counter → 必须不存在  
6. 双 heartbeat 双活 → 必须不存在  

额外（用户本轮强调）：

7. 用 soft-fail / 提高阈值 / 延后 timer **使测试绿但产品行为空转**  
8. 把 “focused tests” 包装成 full regression  
9. 把 “V1 仍 PROD 所以不删” 包装成 “G16 FULL 收敛完成” 而不说明 **双轨仍在**  
10. Subtask “honored in prompt” 但 **从不 spawn**  

---

# 回归与既有功能保护清单

确认未破坏（对照 2026-08-03 overhaul 与 live spine）：

- [ ] SubagentRegistry 仍是 lifecycle 真相源  
- [ ] Foreground promptAndWait / 2min promote 行为仍在  
- [ ] progress-only heartbeat + 180s stall  
- [ ] Permission derive + capability tighten-only for persona  
- [ ] SessionRuntime per-session isolation  
- [ ] `/loop` commands 仍绑同一 runtime  
- [ ] Compaction / history seed 不被 aggressive ContextEngine 搞坏  
- [ ] 并行 tool 不被 DoomLoop 误 abort（name:callID 等）  
- [ ] Memory 模块功能/文件不被本 batch 破坏（隔离）  

---

# 建议实跑命令（审查证据）

```bash
cd /home/huyongjun/openpartner/opencode

# 执行方曾声称的 focused
cd packages/core && bun test \
  test/loop-control \
  test/runner/llm-loop-control.test.ts \
  test/runner/loop-control-host-layerreal.test.ts \
  test/session/persona-resolve.test.ts \
  test/session/tree-budget.test.ts \
  test/subagent-identity.test.ts \
  2>&1 | tail -80

# 更广 / 全量（G17）
cd packages/core && bun test 2>&1 | tail -80
cd ../opencode && bun test 2>&1 | tail -80
cd ../tui && bun test 2>&1 | tail -80

# Inventory 重跑
rg -n "from [\"']@/tool/task|opencode/src/tool/task" packages --glob '!**/node_modules/**'
rg -n "SessionPrompt" packages/opencode/src --glob '!**/node_modules/**'
rg -n "loop-control/subagent-heartbeat|loop-control/fork-mode|loop-control/task-hook|agent/subagent-permissions" \
  packages --glob '!**/node_modules/**' --glob '!**/*.test.ts'

# 接线存在性
rg -n "setIfEmpty|publishSubagentTerminal|timer_reminder|shouldProactiveCompact|peer_message|treeBudget|acquireAgentGuard" \
  packages/core/src packages/opencode/src --glob '!**/node_modules/**'
```

---

# 输出报告格式（强制）

用中文写（用户工作语言），结构如下：

## 0. 执行摘要（1 页内）
- 总判定：`ACCEPT` / `ACCEPT-WITH-GAPS` / `REJECT`
- 一句话：是否满足用户「完整全部实现、无 partial、无 bug、不破坏既有功能」
- 与执行方 baseline FULL 的**分歧点数**

## 1. 方法与证据范围
- 读了哪些文件、跑了哪些测试、git range

## 2. DoD G1–G18 详表
（每项 PASS/GAP/FAIL + 证据）

## 3. Task 0–17 详表
（完成度 % 或 DONE/PARTIAL/MISSING）

## 4. §14 Inventory 矩阵重判
（每 ID：CLOSED 是否属实）

## 5. 双轨 / 半闭合 / 政策洗白专项
- V1 状态  
- 死代码未删  
- 假 FULL  

## 6. 缺陷清单（按严重度）
| Sev | ID | 标题 | 证据 | 用户影响 | 修复建议 |
|-----|-----|------|------|----------|----------|
| P0  | | 行为错误/回归/安全 | | | |
| P1  | | 需求未接线/假 FULL | | | |
| P2  | | 测试缺口/文档谎 | | | |
| P3  | | 整洁度 | | | |

严重度定义：

- **P0**：破坏既有功能、错误终止会话、数据/权限错误、isolation 破坏 memory  
- **P1**：plan 要求功能未真正生效，或标 FULL 实为 partial  
- **P2**：测试不足、边界未覆盖、文档与代码不符  
- **P3**：命名/注释/可维护性  

## 7. 回归风险评估
- 已证实无回归的区域  
- 未充分验证的区域  
- 建议补测列表  

## 8. 与用户优先级对齐的「必须补完清单」
只列用户要的完整交付还缺什么（可执行、按依赖排序）。  
**不要**建议“可以以后再做”除非用户书面 scope-out。

## 9. 对执行方 baseline 的逐条纠错
对照 `...-baseline.md` 每一 FULL 行：同意 / 降级为 PARTIAL / 改为 FAIL，并说明理由。

## 10. 最终 verdict
- 是否允许宣称 “full convergence batch done”：是/否  
- 若否，blocker 列表（P0/P1 only）

---

# 审查心态检查（写报告前自检）

- [ ] 我是否因为测试绿就放过了未接线路径？  
- [ ] 我是否把执行方的 “N/A FULL policy” 直接抄成 PASS？  
- [ ] 我是否验证了 **PROD 调用链** 而不只是模块存在？  
- [ ] 我是否实跑了 plan 要求的全量测试而不是 focused only？  
- [ ] 我是否把 soft-fail/延时/提阈值 评估为“合理工程”时，仍检查了**产品是否空转**？  
- [ ] 我是否碰了 memory？——不应。  
- [ ] 每个 FAIL/GAP 是否有文件路径与可复现步骤？  

---

# 开始工作

1. 读 plan + baseline + 本 prompt 标准  
2. `git diff 5e7fccc6dc^..e3528cecb4` 建立变更地图（剔除/标注 memory 噪声）  
3. 按 G1→G18 深挖代码与测试  
4. 实跑测试收集数字  
5. 输出完整报告（格式 §输出报告格式）  

**不要实现修复，除非用户在审查报告后明确要求。** 审查阶段只输出真相。

=== END REVIEW PROMPT ===
)
