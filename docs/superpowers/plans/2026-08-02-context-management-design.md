# 上下文管理改动设计（V2 Compaction v3）—— 讨论记录与设计

> 状态：**设计中（讨论中）**。本文件是前期讨论的完整记录 + 当前设计状态，后续继续讨论在此文件上迭代。
> 关联：`docs/superpowers/plans/2026-08-02-deprecate-v1-use-v2.md`（V2 转正 plan，本设计在其 Task 9 位置落地）

---

## 0. 背景

- **V2 转正**：弃用 V1，V2（SessionV2/SessionRunner）成为唯一主路径（见 deprecate-v1-use-v2 plan）
- **v2 上下文管理现状问题**：
  - 切割是**字符串级**（`compaction.ts:144-147` `slice(0, -remaining)`）——把单条消息从中间切开，toolCall/toolResult 可能被切两半（用户评价："太垃圾了，原始人级别"）
  - `SUMMARY_OUTPUT_TOKENS=4096` 固定——不随上下文规模缩放（用户评价："2M 上下文压缩到 4000 和 200k 上下文压缩到 4000 肯定不是一个事情啊，草台班子"）
  - **溢出接线已存在**（2026-08-02 终审核实现状，修正早期"缺口"表述）：`llm.ts:394-402` recoverOverflow 完整路径（isContextOverflowFailure → compactAfterOverflow → die 重放 + L507 防递归）——实施时**不要重写 llm.ts 溢出逻辑**
  - **proactive 链路已接通但触发条件错位**（终审修正）：`llm.ts:320-325` 调 `shouldProactiveCompact`（基于 IterationBudget 步数 50%+30 步，**与 token 无关**）——Task 10 禁用
  - `ContextEngine.compact()` 是记账方法（更新 lastCompactConsumed，非空操作——修正早期"未接线"表述）
- **方向**：总体上下文管理**对齐 Pi**（成熟经验），重要位置适配 opencode 设计；核心创新 = **LLM 参与选择保留哪些历史 turn**

---

## 1. 决策记录（讨论历史，按序）

| # | 决策 | 理由/原话 | 状态 |
|---|---|---|---|
| D1 | 切割定死**消息级**（不允许字符串级） | "我们的目标是首先定死消息级别" | ✅ 已定 |
| D2 | 近期对话全量保存（**<10%**，或对话数量方案与 Pi 对齐） | 近期对话应该 <10% | ✅ 已定（见 §3 预算） |
| D3 | **前期对话让模型选择保留**：编号 + prompt 写规则 + 模型抉择 → 选中的全量不压缩，其余压缩，拼接 | 核心创新 | ✅ 已定 |
| D4 | 切割单位：**turn 级为主，消息级兜底**（对齐 Pi） | "我们那看来应该大体对齐Pi，turn为主"；Pi 是 turn 级（turns() 按 user 切）+ splitTurn 消息级兜底 + toolResult 绑定 | ✅ 已定 |
| D5 | 模型选择**一轮调用**（`<selection>` 标签 + 摘要同一次输出） | "肯定一轮选择" | ✅ 已定 |
| D6 | 选择要有 **budget（<10%）**，prompt 写清楚，**固定格式输出**；**发给模型前算好每个 turn 的 token 占比标在编号旁**；让模型选"难以压缩/压缩后可能丢失重要信息"的 turn；总选中 < 阈值（默认 10%）；无重要信息时**推荐不选** | 用户细化 | ✅ 已定 |
| D7 | **双重预算**（近期区 + 选中区）；turn 过长超选中上限时**按消息级切（对齐 Pi splitTurn）** | "肯定要双重，turn可能过长，一个turn直接超10%，那样就得按消息级别和Pi一样截断了" | ✅ 已定 |
| D8 | 超大 turn **拆成 2+ 子 turn，每个子 turn < 选中上限的 2/3** | 保证模型任何组合都有余地，不卡边界 | ✅ 已定 |
| D9 | 超预算**三级处理**：≤1.5× 限额全保留 → >1.5× 重请求只重选（prompt 告知超额度）→ 二次仍超贪心截断到额度 | 用户细化 | ✅ 已定 |
| D10 | 解析失败/格式错/编号不存在：**重请求一遍**（错误详情写进 prompt：格式问题、超额问题、不存在编号）→ 仍失败**退回 Pi 方案**（纯近期区） | 用户细化 | ✅ 已定 |
| D11 | 摘要预算**非线性饱和**，不随窗口线性涨 | "肯定不是线性上升的…1M 上下文 13-20K 额度足够" | ✅ 已定（§4 公式） |
| D12 | 预算公式 **MM 型** `L·x/(x+K)`，L=20000, K=272000 | 我推导，用户认可"就左边这个预算没问题" | ✅ 已定 |
| D13 | **maxOutput 不考虑**（获取不到数据） | "max output不用考虑，这个你获取不到数据" | ✅ 已定（移除双约束） |
| D14 | 近期区跟 Pi 基本没区别（只差保留比例） | "近期区其实就和Pi没啥区别，无非就是保留比例差异…总体上下文管理可以直接对着Pi抄" | ✅ 已定 |
| D15 | **摘要不排除选中编号**（选中 turn 在上下文出现两次：摘要压缩版 + 全量版；冗余作备份） | "摘要无需排除选中编号"——重选时摘要永不重做，"只重选"成立 | ✅ 已定 |

---

## 2. 切割模型（对齐 Pi）

```
正常 turn → 一个编号
  turn = user 消息起，含后续全部 assistant/tool 消息，到下一个 user 消息前

超大 turn（单 turn > 选中上限的 2/3）→ 按消息组拆成 2+ 子 turn（[3a][3b][3c]）
  每个子 turn < 选中上限的 2/3
  子 turn 切在消息组边界
  子 turn 允许无 user 开头（turn 中部切出，标注"（续）"）—— ✅ 已定（A2）
  消息组 = toolCall + toolResult 绑定对（永不分离）

会话开头的非 user 消息（synthetic/system）→ 独立编号（不绑第一个 user）
compaction 消息 → 不编号
```

### 对齐 Pi 的切割事实（参考）
- Pi `isCutPointMessage`：user/assistant/bashExecution/custom/branchSummary/compactionSummary 可切；**toolResult 不可切**（跟 toolCall 绑定）
- Pi `turns()`：按 user 消息切 turn，倒序累加；超预算 turn 内部 `splitTurn` 找消息级切点
- opencode v1：`DEFAULT_TAIL_TURNS=2`（turn 级）+ splitTurn 消息级兜底
- Claude Code / Codex：消息级（保留最近 N 条）
- **共同规律**：toolCall/toolResult 绑定 + turn 是语义单元（问题→思考→行动因果链）

---

## 3. 预算体系（饱和，全部"管上下文"）

| 区 | 公式 | 128K | 200K | 1M |
|---|---|---|---|---|
| **摘要区** | `20_000 · x / (x + 272_000)`（x=contextWindow，MM 饱和） | 6.4K | 8.5K | 15.7K |
| **近期区**（全量保留） | `min(10% 窗口, 20_000)` | 12.8K | 20K | 20K |
| **选中区**（模型选择） | `< 10% 窗口`（默认，可配置） | 12.8K | 20K | 20K |
| **触发 buffer** | `min(10% 窗口, 20_000)` 保底 | 12.8K | 20K | 20K |

- 总保留 ≈ 近期 + 选中 ≤ ~20% 窗口（大窗口下各 20K 封顶）
- 选中区补充约束：**数量上限 10-20 条**（与 token 预算双约束）—— ✅ 已定
- **饱和哲学**：对话是时间结构（最近几轮/关键几轮），token 量不随窗口膨胀；只有历史总量随窗口涨，历史总量由摘要承载，摘要容量饱和

---

## 4. 摘要预算公式（已定）

```
summaryBudget(x) = 20_000 · x / (x + 272_000)      // x = contextWindow
```

- **L = 20,000**：饱和上限（"十几个到 20K"封顶）
- **K = 272,000**：半饱和窗口（x=K 时预算 = L/2 = 10K）
- 连续可导、单调递增、渐近饱和（x→∞ → 20K，永不超过）
- 锚点：128K→6.4K / 272K→10K / 1M→15.7K / 2M→17.6K / 4M→18.7K

**为什么不是别的非线性**：
- 对数 `a·ln(1+x/b)`：无渐近（5M 窗口 25K 还涨），违背"1M 足够"
- 幂函数 `a·x^p`：无上限（2M 还涨到 22K）
- 指数 `L(1-e^(-x/τ))`：太陡（1M 就 19K，用户要"十几个 K"≈15-16K）

**补充事实**：1M 全量上下文下模型实际能稳定输出 ~10K 高质量摘要已属优秀——预算只是上限，实际输出多少算多少，质量靠 prompt 保证。（maxOutput 约束因拿不到数据不纳入公式，D13）

---

## 5. 选择机制（LLM 参与）

### 5.1 编号与占比标注（发给模型前算好）
```
[1] (0.8%) [User]: ...
[2] (1.2%) [Assistant]: ...
[3] (6.4%) [User]: 超长任务描述...      ← 超大 turn，细分 [3a][3b][3c]
[4] (0.3%) ...
```
每个编号旁标 token 占比——模型看到"选这个要花多少预算"。

### 5.2 一轮调用格式
```
<selection>[3,7,12b]</selection>
<summary>
...（摘要覆盖全部早期含选中 turn——D15，selection 仅影响拼接保留，不剪裁摘要输入）
</summary>
```

### 5.3 选择 prompt 语义引导
- 选出**难以压缩**的（大段代码/文件内容/精确格式）
- 或**压缩后可能丢失重要信息**的（用户偏好/约束/决策理由/精确错误串/文件路径/长任务描述）
- 总选中 token 必须 < 阈值（默认 10%）
- **无重要信息或可完美压缩 → 推荐不选**（零选择，纯摘要路径）

### 5.4 校验与纠错闭环（已定）
```
模型输出
  ├─ 预算校验：≤1.5× 限额 → 全保留 ✅
  ├─ 预算校验：>1.5× 限额 → 重请求只重选（prompt："超额度了，重新选 <额度"，列错误）
  │     └─ 二次仍超 → 贪心截断保留到额度（按占比从大到小保留，保住最重要）✅ 已定
  ├─ 格式校验（JSON 解析）失败 → 重请求只重选（错误写进 prompt）
  │     └─ 仍失败 → 退回 Pi 方案（近期区 + 全量摘要，无选中区）✅ 已定
  ├─ 编号存在性校验失败 → 重请求只重选（不存在编号列表写进 prompt）
  │     └─ 仍失败 → 退回 Pi 方案
  └─ 通过 → 摘要生成（覆盖全部早期，含选中 turn——D15）→ 拼接
```
- `<selection>` 标签解析按标签字符串定位（`indexOf`），不假设位置（模型可能放中间/末尾）—— ✅ 已定（N4）
- 摘要生成失败：一次重试，仍失败回退 Pi 方案（不 abort 压缩）—— ✅ 已定

---

## 6. 拼接结构

```
最终上下文 = [未选中早期消息的压缩摘要] + [选中 turn（原时间序）] + [近期全量]
```

- 选中消息在库里原样保留（**询价式不落库**：压缩是每轮请求构造时的临时变换，选中集合每轮重算——v2 天然优势，零持久化设计；唯一破例 = survival 计数，见 §7）
- **摘要不排除选中编号**（D15）：摘要覆盖全部早期（含选中 turn）；选中 turn 以"摘要压缩版 + 全量版"双份出现——全量为主、摘要为上下文连续性备份；重选/纠错重请求时摘要永不重做
- previousSummary 增量机制不变（每次摘要都是全量早期的最新版）
- 历史重载起点 `SessionHistory.latestCompaction` 不变
- compaction 消息呈现（`<conversation-checkpoint>` + summary）——**recent 已去掉**（见 §10 定案：turn 级后冗余，5 处使用点核实无隐患；近期/选中从历史加载）
- **降级路径（纠错失败/解析失败）**：近期区 + 全量摘要（无选中区）——近期区本来就是"保留用于拼接"的，不参与压缩，降级只是去掉选中区，摘要照常生成

## 7. Survival 计数（选中持久性标签，用户设计）

**问题**：询价式每轮重算 → 模型不知道某个 turn 是"第一次见到"还是"已跨 N 次压缩存活"——真正重要的 turn 可能每次都被重新判断。

**设计**：每个候选编号项（turn 或子 turn 段）带 survival 计数：
```
[3] (2.1%) ×3 [User]: 关键决策讨论...    ← 已跨 3 次压缩仍被保留
[7] (1.8%) ×0 [User]: 普通消息...
```
- 压缩时：被选中的编号项 survival +1；近期区编号项 survival +1（也没被压缩）
- 未选中 → 进摘要 → 编号消失（计数自然归零）
- prompt 语义引导：`×N` = "已历 N 次压缩仍被保留"——模型自行判断：多次存活可能真重要（倾向续留），或摘要已覆盖足够（可放走）

**持久化（询价式的唯一破例）**：
- 存 compaction 消息（`type=compaction` 的 SessionMessage 扩展字段 `survival: {项Key: count}`）——compaction 消息落库，天然持久，无新表
- 下轮压缩时从最近 compaction 消息读 survival 映射，拼接进编号标注
- 项 Key：编号项内第一条消息的 messageID（稳定、唯一）

## 8. 缓存设计（跟随 Pi：主循环最大化 + 摘要隔离）

**Pi 的做法（源码实证）**：
- 主循环：`cacheControlFormat: "anthropic"`（`ai/src/types.ts:564-565`）——系统提示 / 最后工具定义 / 最后文本内容打 cache_control 标记；`cacheRetention: "long"`（provider 支持时 24h/1h TTL）；缓存按 `sessionId` 关联（`openai-responses.ts:132`）
- 摘要调用：`cacheRetention: "none"`（`compaction.ts:573`）——不关联 sessionId、不读不写缓存

**我们的决定（用户确认 A）**：
- **摘要/选择调用 = `cache: "none"`**（本仓库 `LLMRequest.cache` CachePolicy，`packages/llm/src/schema/options.ts:275`——Pi cacheRetention "none" 的等价物）——摘要 prompt 是巨型历史，写缓存会挤占主循环缓存（provider 缓存容量有限，主循环每轮都跑、收益大得多）；重试不命中可接受（纠错重请求是异常路径，偶发）
- **主循环缓存最大化**（v2 现状已有 `promptCacheKey`，`llm.ts`）——保持/增强：前缀稳定、cache_control 标记、sessionId 关联
- 压缩调用结构约定（即使未来改用短缓存也可命中）：
```
[固定部分：模板/系统提示/指令]   ← 完全稳定，永不变化
[previousSummary]               ← 变化小（增量合并）
[编号列表 + 占比 + ×N]          ← 每次变化，放最后
[错误反馈段（仅重请求）]        ← 追加在末尾
```

**缓存相关的实现要点（spec 级）**：
- 摘要调用显式 `cache: "none"`（LLMRequest.cache，跟随 Pi 语义）
- 主循环请求结构固定（同模型、同字段顺序）
- 不把变化数据（编号、时间戳）混入主循环固定前缀段

---

## 9. 与 V2 代码的集成点

| 位置 | 改动 |
|---|---|
| `packages/core/src/session/compaction.ts` `select`（L128-159） | 重写：turn 级切割 + 子 turn 拆分 + toolResult 绑定 + 选中集合软豁免 |
| `compaction.ts` `buildPrompt`（L161-168） | 扩展：编号列表 + 占比 + ×N 标注 + 选择引导 + `<selection>` 输出要求 + 摘要防对话延续 system prompt |
| `compaction.ts` `SUMMARY_OUTPUT_TOKENS`（L15） | 替换为 MM 公式 `20_000·x/(x+272_000)` |
| `compaction.ts` `compactAfterOverflow`（L172-224） | 加选择校验纠错闭环 + 重请求逻辑 + 摘要失败一次重试 |
| `compaction.ts` 摘要 LLM 调用 | `cache: "none"`（LLMRequest.cache CachePolicy） |
| `compaction.ts` 序列化 `serialize`（L86-112） | 编号/占比/×N 前缀格式 |
| 配置 schema `core/src/config/compaction.ts` | `select.enabled`（默认 true）/ `select.budget`（默认 0.10）/ `select.retry`（默认 1）/ `keep.recent`（默认 min(10%, 20000)）/ `summary` 公式参数（L=20000, K=272000） |
| 事件 `SessionEvent.Compaction.Ended` | 可选扩展 selected 字段 + survival 映射 |
| compaction 消息（`type=compaction`） | 扩展 `survival: {项Key: count}` 字段（§7） |

---

## 10. 待核实项 —— 全部核实完毕（定案）

### D1 `continueAfterCompaction` 重放行为 —— ✅ 核实安全，无需改动
- `Compaction.Ended` 是 **durable 事件**（`schema/src/session-event.ts:418-431`，`durable: { aggregate: "sessionID", version: 1 }`）
- publish 时序：`commitDurableEvent` 写库 → `notify` **同步执行** listeners → projector 同步跑（`event.ts:369-417`）→ `projector.ts:395` → `message-updater.ts:381` 写 `type=compaction` 消息——**在 publish 返回前落库完成**
- 重放链：`compactIfNeeded` 成功 → `Effect.die(continueAfterCompaction)` → `runTurnCore` 递归重跑 → 重跑时 `latestCompaction` 已可查到 → 历史从 compaction.seq 起（`history.ts`）→ 不再触发压缩 → **无死循环、无竞争窗口**
- `runAfterOverflowCompaction` 对二次 `ContinueAfterOverflowCompaction` 显式 `die("Post-compaction provider attempt cannot recover another overflow")`（llm.ts:507）——溢出路径有防递归
- 残余场景：摘要生成失败 → `compactAfterOverflow` 返回 false → 硬发超窗请求 → provider 溢出 → 走 onFailover（D2 修复）

### D2 溢出恢复对齐 Pi —— ✅ 定案（唯一代码改动点）
> ⚠️ **已被代码现状取代**（2026-08-02 终审修正）：`llm.ts:394-402` recoverOverflow 溢出接线**已存在**（isContextOverflowFailure → compactAfterOverflow → die 重放 + L507 防递归 + 一次上限由 TurnRetryState 提供）——**不以本条目为准，以 implementation plan Task 9（验证）为准**，不重写 llm.ts 溢出逻辑。

### D3 provider 溢出识别 —— ✅ 已有，只需 D2 响应
- `ErrorClassifier` 已有 `context_overflow` 分类（`error-classifier.ts:29,63-64,98-99`，`retryable: false`）——识别现成
- 只缺 D2 的响应接线（分类 → 压缩后继续，而非直接放弃）

### D5 ContextEngine 与主循环缓存 —— ✅ 定案
> ⚠️ **已被代码现状取代**（2026-08-02 终审修正）：proactive 链路**已接通**（`llm.ts:320-325`）但触发条件基于迭代步数（与 token 无关）——**Task 10 禁用该分支**；`ContextEngine.compact()` 是记账方法（非空操作）。**不以本条目为准，以 implementation plan Task 10 为准。**
- **ContextEngine：禁用 proactive 分支**（llm.ts:320-325）——触发条件与 token 无关、对齐 Pi（只留阈值 + 溢出两触发）——文件保留（测试在用）
- **主循环缓存现状**：`promptCacheKey` 已有（`llm.ts:306-307`，openai `providerOptions` sessionId 关联）——保持；摘要调用按 §8 用 `cache: "none"`（本仓库 `LLMRequest.cache` CachePolicy，非 Pi 的 cacheRetention 字段）

### 定案后新增的集成点
| 位置 | 改动 |
|---|---|
| `packages/core/src/session/runner/llm.ts` 失败路径（onFailover 前） | `context_overflow` 类 → `compactAfterOverflow` → `recovered: true`（D2） |
| `compaction.ts` 摘要 LLM 调用 | 加 `SUMMARIZATION_SYSTEM_PROMPT`（"不要继续对话，只输出结构化摘要"）+ serialize 输出包 `<conversation>` 标签（G3，跟随 Pi） |
| `compaction.ts` 文件追踪 | 扫描 toolCall 的 read/write/edit path → readFiles/modifiedFiles → 跨压缩累积（从上次 compaction 消息继承）→ 摘要末尾 XML（G5，新增在范围） |
| `compaction.ts` `select` 返回值 | 去掉 `recent`（turn 级后冗余） |
| `compaction.ts:181` buildPrompt 增量输入 | `[previousSummary.summary, selected.head]`（不再用 previousSummary.recent） |
| `compaction.ts:221` Compaction.Ended 事件 | 去掉 `recent` 字段（schema `session-event.ts:428` 同步去） |
| `message-updater.ts:385` | 去掉 `recent` 落库 |
| `to-llm-message.ts:160` | checkpoint 呈现去掉 `<recent-context>`（只 `<summary>`；近期/选中从历史加载） |
| compaction 消息 | 扩展字段：`survival: {项Key: count}`（§7）+ `files: {read: [], modified: []}`（G5） |

### G5 文件追踪定案（用户确认加入）
- 机制：每次压缩扫描 assistant 消息 toolCall 的 `read`/`write`/`edit` 参数 `path` → `readFiles`（只读未改）/ `modifiedFiles`（写过/编辑过）
- 跨压缩累积：从上次 compaction 消息的 `files` 字段继承 + 本轮新增合并（不重复）
- 输出：摘要末尾 XML `<read-files>...</read-files>` / `<modified-files>...</modified-files>`
- 解决：模型跨压缩知道"动过哪些文件"（确定性保真，不依赖摘要质量）；与模型选择机制互补（选择保内容，文件追踪保操作集合）
- 成本：~50 行纯提取逻辑，可单元测试

### G3 摘要上下文保护定案
- 摘要调用独立 system prompt：SUMMARIZATION_SYSTEM_PROMPT（"不要继续对话，只输出结构化摘要"）——跟随 Pi
- serialize 输出包 `<conversation>` 标签——跟随 Pi

---

## 11. 明确不在本设计范围（后置）

- ~~文件级 read/modified 追踪~~（**已并入 G5，Task 8 实施**——2026-08-02 终审修正）
- 分支摘要（需会话树架构，工程量大）
- prune 工具输出级剪枝（v1 有 v2 无；v2 压缩序列化已有 2000 字符截断）
- doom-loop 检测（只有类型定义）
- 系统提示组装动态化（v2 SystemContext Registry + ContextEpoch 已覆盖；tool guidelines 机制可后议）
- `session_before_compact` 扩展钩子（Pi 有，后置）
- AbortController 取消压缩（interrupt 路径后置）
- Silent overflow / length-stop 溢出识别（部分 provider 不报错只填窗口；后置——终审 B 面新发现）

---

## 12. 测试策略（原则）

- **选择逻辑做成可注入函数**（mock 模型返回固定编号）——单元测试覆盖：编号/占比计算、turn 切分与子 turn 拆分、预算核算、校验纠错闭环（1.5× 分支、重选、贪心截断）、拼接顺序、失败降级、survival 计数持久化
- 真实模型行为：E2E 冒烟（一个长会话触发压缩，人工检查选中质量）
- 现有 `packages/core/test/runner/` 与 compaction 相关测试保持绿色

---

## 13. 关联决策（来自 V2 转正 plan，影响本设计）

- loop-control 8 机关不额外改动（V2 转正自动激活）
- 上下文管理对齐工作在 deprecate plan 的 Task 9（依赖本设计 spec）
