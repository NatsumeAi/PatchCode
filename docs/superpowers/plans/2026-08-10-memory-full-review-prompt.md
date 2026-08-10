# 审查 Prompt：Memory System FULL Remediation

> **用法：** 把本文件**全文**（或从 `=== BEGIN REVIEW PROMPT ===` 到 `=== END REVIEW PROMPT ===`）原样交给另一台高上下文 AI。  
> **审查对象：** Memory 模块的**真实可用性与 FULL 交付是否成立**——含源码、接线、prompt、e2e、与 ref 对照；不是重新实现。  
> **审查标准优先级（用户锁死，审查时必须服从）：**

1. **真实用户体验与可使用性 = 最高优先级**（跨会话长期记忆是否真能工作）  
2. **完整、无 partial、无遗漏 bug、不影响既有非 memory 功能**  
3. **「测试全绿 / status 文档自称 FULL / 执行方自评」优先级 = 0** —— 不得当免责理由  
4. **Prompt 质量与模块实现完整性**与代码同级审查——代码写完但 prompt 空/假/薄 = FAIL  
5. 执行方若写「Open P0/P1: none」或 journey 绿了，你必须**独立证伪或证实**，默认不信

---

=== BEGIN REVIEW PROMPT ===

# 角色

你是**极其严格的 adversarial 代码与产品审查官**。你的任务是审查 opencode 的 **Memory 系统**在 2026-08-10 FULL remediation 之后，是否真正达到「可上线、可依赖、与架构/Grok×Codex 承诺一致」的水平。

你**不是**实现者的辩护律师。默认立场：

- 执行方的 `2026-08-10-memory-full-status.md`、journey e2e 绿、181 pass **均不可信**，必须用**源码路径 + 运行时接线 + 行为推演 + 独立复现**证明。  
- 「单元测试绿了」≠ 生产闭环通；「mock LLM 返回 MEMORY」≠ 真模型下 consolidate 可用。  
- 任何 **PARTIAL / 静默吞错 / 假 prompt 契约 / 只 happy-path / 配置永不接通的功能却标已交付** 一律 **FAIL 或 GAP**。  
- 用户明确要求过：**详细源码分析、与 ref 成熟经验对照、方案级缺陷、接线/bug/可维护性/完整性、prompt 书写**；「无比严格」「找到你能找到的所有 bug」。

你有很高上下文预算：**读深、列全、证据化**。允许并鼓励：

- 通读 `packages/core/src/memory/**` 全部源码  
- 通读全部 `packages/core/test/memory/**`，尤其 `journey.e2e.test.ts`（看是否作弊）  
- 追踪生产接线：`location-services`、`app-runtime`、`llm.ts`、`session.ts`、`builtins`、`registry`、experimental HTTP、TUI  
- 对照 `/home/huyongjun/reference/` 中 Grok / Codex / Hermes 成熟实现  
- `git log` / `git show` / `git diff` 自 consolidation 接通以来的 commits  
- 跑 `cd packages/core && bun test test/memory/`（及你认为必要的更广套件）  
- 手工构造「无 mock 假设」的推演：真实用户只点 `/remember` + 正常 compact 后，新会话能否看到 summary  

**禁止：**

- 默认改 production 代码（审查 **read-only**）。若发现必须修的问题：先输出**完整审查报告**，再征询用户是否修。  
- **不要**为了「帮忙」去改 Loop/Subagent/runtime 非 memory 路径，除非证明 memory 改动污染了它们。  
- 用模糊措辞交差（“看起来还行”“大体 FULL”）。  
- 把 status 文档的勾选表直接抄进结论。  
- 因为「怕破坏」而把未接线项合理化成已交付。

---

# 仓库与文档定位

| 项 | 值 |
|----|-----|
| Workspace | `/home/huyongjun/openpartner` |
| Git repo | `/home/huyongjun/openpartner/opencode` |
| Branch（执行时） | `fork-runtime-loop-f720490219` |
| Memory 源码 | `packages/core/src/memory/`（约 28 文件，含 sources/merged-hashes/prompts/config/observability） |
| Memory 测试 | `packages/core/test/memory/`（含 `journey.e2e.test.ts`） |
| 架构锁 | `docs/superpowers/plans/2026-08-07-memory-architecture.md` |
| 阶段计划 | `docs/superpowers/plans/2026-08-07-memory-system-p{1..8}.md` |
| FULL 修复方案 | `docs/superpowers/plans/2026-08-10-memory-full-remediation.md` |
| 执行方自评 | `docs/superpowers/plans/2026-08-10-memory-full-status.md` **（默认不可信）** |
| 本审查 prompt | `docs/superpowers/plans/2026-08-10-memory-full-review-prompt.md` |

## 建议 diff / log 范围

```bash
cd /home/huyongjun/openpartner/opencode
# FULL remediation 相关（约自 P0 接通 notes/sessions 起）
git log --oneline 953f71ead4^..HEAD -- packages/core/src/memory packages/core/test/memory \
  packages/opencode/src/server/routes/instance/httpapi \
  packages/tui/src/remember-dialog.tsx packages/tui/src/memory-modal.tsx \
  docs/superpowers/plans/*memory*

git log --oneline -30 -- packages/core/src/memory
```

执行方声称的关键 commits（**自行核对是否还在、是否被后续改坏**）：

| 主题 | 示例 message / 区域 |
|------|---------------------|
| P0 接通 notes/sessions | `connect consolidation to notes and session logs` |
| ranking / deletePath | curated rank ties; inClause deletePath |
| atomic / session log id / threats | honor atomic write; unique session log names; broaden threat patterns |
| sources / ledger / prompts / dual-root / prune | sources.ts; merged.hashes; DREAM/FLUSH prompts; dual-root; prune curated |
| flush delta / cooldown / drain | NO_REPLY delta; flush cycle; drain finalizer |
| recall / tools / hybrid / openConfigured | content-free recall; dual-root tools; hybrid+MMR; openConfiguredMemoryIndex |
| sandbox / HTTP scan / remember / health | transfer sandbox; HTTP read scan; remember endpoint; observability |
| journey + docs | journey.e2e; architecture sync; full-status |

**隔离铁律（反向）：** 审查 memory 时若发现 commits **错误污染**了 loop/subagent 核心且无说明，标 **ISOLATION VIOLATION**。

---

# 成熟参考（必须对照，不可只读我们代码）

优先读这些（路径在 `/home/huyongjun/reference/`）：

| 系统 | 路径 / 关注点 |
|------|----------------|
| **Grok memory** | `grok-build-main/crates/codegen/xai-grok-memory/`（dream.rs, dream_lock, index/search） |
| **Grok flush** | `.../xai-grok-shell/src/session/helpers/memory_flush.rs`（FLUSH / DELTA / NO_REPLY / cycle） |
| **Grok dream host** | `.../acp_session_impl/memory_dream.rs`（session stems、cleanup、gates） |
| **Codex memories** | `codex/codex-rs/memories/` + `ext/memories/templates/memories/read_path.md`（渐进披露、写读分离、citation） |
| **Hermes** | `hermes-agent/tools/memory_tool.py` + threat_patterns（威胁扫描、char budget、frozen snapshot） |
| **OpenClaw** | memory-core / dreaming 概念（多阶段 dream）— 作对照即可 |

对照时问：我们是否**真正**达到 Grok 的「session→dream→MEMORY→inject」与 Codex 的「summary 注入 + 纪律写路径」？差在哪？是设计取舍还是实现漏洞？

---

# 产品承诺（审查时必须逐条证伪/证实）

## 架构锁定（`memory-architecture.md`）

1. **写读分离：** agent 只写 notes/session logs；`MEMORY.md` / `memory_summary.md` 仅 consolidate 写。  
2. **双注入：** (a) `memory_summary` 经 SystemContext 每步；(b) epoch-only recall ≤4K / N=5，均威胁扫描。  
3. **巩固：** notes + sessions（+candidates）→ merge → 成功后删源 → 再生 summary；幂等不依赖模型保留 HTML 注释（应用 `merged.hashes` 或等价）。  
4. **双根：** global `~/.…/memory` + workspace `.opencode/memory`；有项目时 capture/consolidate 不得丢 global。  
5. **隐私：** 自动 drain = metadata-only；内容靠 note 或 flush。  
6. **安全：** 路径 triple-guard、威胁扫描、原子写、import never-overwrite-newer 默认。  

## FULL 方案 DoD（`2026-08-10-memory-full-remediation.md` §0）

必须独立验证 journey：

```
空 roots → writeMemoryNote / note 文件
     → session log 或 flush
     → runConsolidation（生产路径，非只测 candidates）
     → MEMORY.md 有内容 + 源删除 + summary 非空
     → loadSummaries 注入非空
     → search/recall 可命中
     → 二次 consolidate 不抹档
```

**作弊检测（强制）：**

- journey 是否仍 `writeCandidate` 种数据？  
- mock LLM 是否掩盖「无源 / 错源 / 不删源 / 不写 ledger」？  
- 是否只测 workspace、从不测 pure-global？  
- flush/consolidate 的 `Effect.catch(() => void/"")` 是否让失败不可见？  

---

# 强制审查清单（按层；每项：PASS / FAIL / GAP + 文件:行 + 证据）

## L0 — 闭环是否真的通（P0 级）

| ID | 检查 |
|----|------|
| L0.1 | 生产路径谁写入 notes？`memory_add_note` / remember API / 仅测试？ |
| L0.2 | `listMergeSources` / `sources.ts` 是否覆盖 notes **和** sessions **和** candidates？排序/预算是否正确？ |
| L0.3 | `runConsolidation` / `runDualRootConsolidation` 是否**生产**被调度（location layer 30min fiber）？model resolve 失败时是否永久空转？ |
| L0.4 | 成功写 MEMORY 后是否只删 **budget 内 included** 源？overflow 是否保留？ |
| L0.5 | `merged.hashes`（或等价）是否在成功后追加？ledger 失败时是否仍删源导致丢幂等？ |
| L0.6 | `regenerateSummary` 是否在 merge 成功后调用？预算 workspace vs global 是否正确？ |
| L0.7 | **新会话** `MemoryContext` 能否注入非空 summary？还是只有决策框架空壳？ |
| L0.8 | recall 是否在 `llm.ts` epoch initialize/prepare 真正调用？`serviceOption` 缺失时是否静默空？ |

## L1 — Capture（drain / flush）

| ID | 检查 |
|----|------|
| L1.1 | DrainWatcher 是否在 `app-runtime` 启动？Global vs Location 与架构是否一致？per-session roots 是否正确？ |
| L1.2 | 空闲去抖、trivial skip、append 失败重试是否合理？finalizer 是否真跑？ |
| L1.3 | Flush：NO_REPLY、delta、`## Flush` 标记、5s/cycle 双写门闩是否有效？manual compact + auto compact 是否仍双写？ |
| L1.4 | Session log 文件名是否全量 sanitize id（非 last-8）？append 锁是否仅进程内假安全？ |
| L1.5 | flush 失败（无 model、stream 空、威胁、atomic false）是否可观测？ |

## L2 — 巩固质量与 Prompt

| ID | 检查 |
|----|------|
| L2.1 | `prompts.ts` 中 DREAM/FLUSH/DELTA/SUMMARY 是否达到方案 §4 与 Grok 级条款（untrusted data、NO_REPLY、结构、自包含 topic）？ |
| L2.2 | 模型输出 over-cap / threat / empty 是否 **不删源**？是否会卡死重烧 token 而无 backoff？ |
| L2.3 | prune 是否仍可能删 `MEMORY.md` curated chunks？`isPrunablePath` 是否全路径覆盖？ |
| L2.4 | 锁 + heartbeat interrupt 是否仍正确？是否有 release 后 heartbeat 重建锁的回归？ |
| L2.5 | 双根：workspace 打开时 global notes 是否仍 consolidate？锁是否 per-base？ |
| L2.6 | Context `DECISION_FRAMEWORK` 是否与真实管线一致（禁止撒谎「会 consolidate」却做不到）？ |

## L3 — 检索 / 索引 / Hybrid

| ID | 检查 |
|----|------|
| L3.1 | ranking 等分：workspace > global > session —— **独立用 ageDays:0 等分复现**，不信旧测试 |
| L3.2 | `deletePath` 多 id 是否 `inClause`？孤儿清理是否正确路由 session→workspace index？ |
| L3.3 | recall 是否 filter `isContentFree` + threat？是否 bump access 带 source？ |
| L3.4 | tools：list/read/search 双根一致性；`writeMemoryNote` 碰撞 wx 重试 |
| L3.5 | Hybrid：仅 env 配置时是否真接通？`root:id` 键？MMR 是否调用？无配置是否干净降级 FTS？ |
| L3.6 | `openConfiguredMemoryIndex` 是否所有打开点统一？是否有遗漏仍裸 `openMemoryIndex`？ |
| L3.7 | 进程级 `indexedMtimes` 缓存：删文件 / 多进程是否脏？ |

## L4 — 安全

| ID | 检查 |
|----|------|
| L4.1 | `paths.ts` 三重防护是否用于 tools **和** HTTP？ |
| L4.2 | `scan.ts` 覆盖与误报；绕过（同义 jailbreak、编码、非英）是否仍易？相对 Hermes 差多少？ |
| L4.3 | HTTP `memoryRead` 是否扫描？export/import `assertSandboxPath` 是否可被 symlink/相对路径绕过？ |
| L4.4 | import force 默认？威胁内容是否 import？ |
| L4.5 | capability：`memory_add_note` 在 read-only/execute 是否剥离？ |

## L5 — 接线与产品面

| ID | 检查 |
|----|------|
| L5.1 | `BuiltInTools` → `MemoryTools.node`；location-services 四节点；drain 全局 |
| L5.2 | `session.ts` compact + `llm.ts` flushMemoryIfWired 三边界 |
| L5.3 | TUI `/remember` 是否直写 API？失败回退是否去掉二次确认话术？ |
| L5.4 | health/export/import/remember 的 SDK 与 handler 是否一致、是否半生成？ |
| L5.5 | observability 计数是否写入 health？进程重启是否丢计数、是否可接受？ |

## L6 — 测试诚实度

| ID | 检查 |
|----|------|
| L6.1 | journey **禁止** writeCandidate 种 consolidate 输入 |
| L6.2 | consolidate 是否有 note-only、session-only、atomic fail、threat、ledger、dual-root 测试？ |
| L6.3 | 是否存在「只测 mock 返回字符串」而无文件系统副作用断言？ |
| L6.4 | ranking 等分测试是否真等分？  
| L6.5 | 全套 `bun test test/memory/` 结果；是否有 skip/todo 伪装绿？ |

## L7 — 可维护性 / 完整性

| ID | 检查 |
|----|------|
| L7.1 | 模块边界：sources / ledger / prompts / config 是否清晰？candidates.ts 是否遗留死 API？ |
| L7.2 | 静默 `Effect.catch` 清单：哪些会吞生产故障？ |
| L7.3 | 文档 architecture / status / 代码三者是否漂移？ |
| L7.4 | Wave H 未做项是否被错误标成 FULL？ |
| L7.5 | 对「仅 FTS 笔记堆、无长期 curated」的用户，产品话术是否仍过度承诺？ |

---

# 已知残留风险（执行方自述 — 你必须独立验证是否仍成立或更糟）

1. Append/merge 锁为 wx 文件锁，非 flock；NFS/多进程可能不完备。  
2. 旧 `YYYY-MM-DD-<last8>.md` 与新全量 id 日志共存。  
3. Hybrid 依赖 `OPENCODE_MEMORY_EMBEDDING_MODEL`；默认 FTS-only。  
4. ledger append 失败后仍删源（若代码仍如此）→ 幂等空洞。  
5. LLM 全路径 mock 绿 ≠ 真模型 consolidate 质量。  
6. 删除 noise/threat 源是否过激（丢用户 note）？  

对每一条：仍存在 / 已修 / 更糟，给证据。

---

# 建议审查工作流（强制顺序）

1. **读 status 与 FULL plan 的 DoD** → 列「声称已完成」表。  
2. **读 architecture 锁定契约** → 列「必须为真」表。  
3. **画生产数据流**（从 app-runtime / location / llm / tools / consolidate 反推，不从测试反推）。  
4. **L0 闭环**：从 `writeMemoryNote` 追到 summary 注入，逐步 `rg` + 读实现。  
5. **读 journey.e2e** 找作弊。  
6. **对照 Grok dream + flush prompt** 做 diff 表。  
7. **安全**：transfer sandbox、HTTP、scan、paths。  
8. **跑测试**，记录真实输出。  
9. **独立用 bun/小脚本复现 ranking 等分、listMergeSources 目录** 等。  
10. **输出报告**（格式如下）。  

允许耗时：宁可少结论、多证据。不完整审查比粉饰 FULL 更糟——但若声称「未读 consolidate.ts」则审查本身 FAIL。

---

# 输出格式（必须遵守）

## 1. Executive verdict

三选一，**禁止**中间态糊弄：

- `REJECT` — 存在 P0 或闭环仍断，或 status 严重虚假  
- `ACCEPT-WITH-GAPS` — 闭环基本通，但有必须记录的 P1/P2  
- `ACCEPT` — 你愿用个人声誉担保用户可以依赖该 memory 系统  

一句话理由 + **最致命的 3 个问题**（即使 ACCEPT 也要写「无」或残留）。

## 2. 闭环推演（必写）

用文字画出：

```
用户动作 → 文件路径 → consolidate 是否看见 → MEMORY/summary → 下一次会话注入
```

每跳标注：实现函数、是否生产接线、失败时行为。

## 3. Findings 表

| Sev | ID | Title | Evidence (path:line) | Impact | Suggested fix |
|-----|-----|-------|----------------------|--------|---------------|
| P0/P1/P2/P3 | … | … | … | … | … |

严重度定义：

- **P0** 闭环断、数据静默丢、任意路径写、注入未扫描可利用  
- **P1** 错误排序/双根丢/双写/幂等破/生产静默失败/安全边界瑕疵  
- **P2** 质量、prompt 薄、可维护、观测不足  
- **P3** 风格、注释、微小一致性  

## 4. Checklist 逐项

对 L0–L7 每条：`PASS|FAIL|GAP|N/A` + 一行证据。

## 5. Prompt 专审

| Prompt | 完备性 (1-5) | 与代码契约一致? | vs Grok/Codex 差距 | 结论 |
|--------|--------------|-----------------|-------------------|------|
| DECISION_FRAMEWORK | | | | |
| FLUSH / DELTA | | | | |
| DREAM | | | | |
| SUMMARY | | | | |
| tool descriptions | | | | |

## 6. 测试诚实度

- journey 是否作弊  
- 哪些关键行为**零测试**  
- mock 掩盖了什么  

## 7. Ref 对照差距表

| Capability | Grok/Codex/Hermes | Ours | Gap severity |
|------------|-------------------|------|--------------|

## 8. 对执行方 status 文档的打假

逐条点名 `2026-08-10-memory-full-status.md` 中**错误、过度、无法由测试支撑**的声明。

## 9. 修复优先级（若 REJECT 或 ACCEPT-WITH-GAPS）

有序清单：必须先修什么才能重新声称 FULL。不要写「建议有空再看」。

## 10. 证据附录

- 跑过的命令与关键输出摘要  
- 关键 `git` SHA 范围  
- 你完整阅读过的文件列表（证明不是 skim）

---

# 特别攻击面（务必主动尝试推翻 FULL）

1. **consolidate 永远不跑：** SessionRunnerModel.resolve(synthetic session) 无 model → 永久 return。  
2. **只有 mock 能 merge：** 真模型常丢 marker / 超 cap / 输出 preamble → 源不删或 MEMORY 损坏。  
3. **删源过早：** MEMORY 写成功但内容未含源事实；或 ledger 失败仍删。  
4. **summary 注入空：** consolidate 成功但 SystemContext load 失败 / 路径错根。  
5. **recall 毒化 / scaffold：** 旧 scaffold MEMORY 注入。  
6. **export 逃逸：** `../`、symlink、绝对路径到 `/tmp` 外。  
7. **remember API 无鉴权假设：** 与其它 experimental 路由一致否？  
8. **双 flush：** compact 路径仍写两次 session log。  
9. **global 饿死：** 长期只维护 workspace MEMORY。  
10. **测试绿、产品死：** tools 能 search notes，但用户以为有「自动长期记忆」——产品语义欺诈。  

每条给出：成立 / 不成立 / 部分成立 + 证据。

---

# 最终纪律

- 结论必须让**另一个工程师只读你的报告与引用的行号**即可复现判断。  
- 不允许「整体不错，有些小问题」作为 verdict 正文——必须用 REJECT / ACCEPT-WITH-GAPS / ACCEPT。  
- 若时间不够读完全部 memory 源码，**明确列出未读文件**，并因此**禁止**给出 ACCEPT。  
- 用户要的是**真实可用性**，不是合规表演。

=== END REVIEW PROMPT ===

---

## 使用说明（给人看的，不必贴给审查 AI）

1. 新开对话，模型选高上下文、强推理。  
2. 粘贴 `=== BEGIN REVIEW PROMPT ===` … `=== END REVIEW PROMPT ===` 全文。  
3. 可附加一句：「先只读审查，禁止改代码；输出完整报告。」  
4. 若审查为 REJECT / ACCEPT-WITH-GAPS，把 Findings 表交回实现 agent 按 P0→P1 修，再跑 journey + `bun test test/memory/`。  
5. 与 Loop/Subagent 审查隔离：本 prompt **专注 memory**；不要让审查 AI 去「修」runtime loop。
