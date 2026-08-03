# Session Display Kernel — SEALED 实施规格

| 字段 | 值 |
|------|-----|
| **状态** | **SEALED** — 无 open 决策；默认/契约/迁移/验收全部写死 |
| **版本** | 3.0 |
| **日期** | 2026-08-02 |
| **目标读者** | 任意实现 AI / 任意审计 AI；读完本文件即可独立执行或找刺 |
| **标杆** | GrokBuild 出厂为主；Pi 补 registry 形态；事实以 `reference/` 源码为准 |
| **工作区** | `opencode/`（monorepo workspaces: `packages/*`） |

**本文件承诺**

1. **无「待定 / 倾向 / 建议再讨论」** 的产品默认。  
2. **无半截重构**：B 结束前必须全体 tool 走 kernel，禁止长期双路径。  
3. **每个工具、每个状态、每个表面（TUI/Web）** 有可验证行为。  
4. **每个隐患有设计内缓解**，不是脚注式「以后再说」。  
5. 审计若声称与 Grok/Pi 矛盾，须给出 ref 路径；与本规格冲突则以 **§4 锁死表 + §3 契约** 为 OC 产品法（已注明相对 Grok 的故意偏离）。

---

## 0. 一句话 + 用户可见终态

### 0.1 一句话

抽出无 UI 的 `session-display` kernel（mode + policy + descriptor + resolve），TUI/Web 只渲染 ViewModel；出厂时间线密度与交互对齐 Grok 出厂（Edit 展开、agent Shell 零 stdout、思考流中可见末段后收起），结构可维护。

### 0.2 验收故事（未点击时时间线）

```text
Thought for 2.1s
Read packages/foo/a.ts
Grep "bar" (3 matches)
Edit packages/foo/b.ts          ← 下方默认展开 diff
  ±diff…
$ bun test packages/foo         ← 仅一行，无 stdout
Todos 2/5                       ← 仅 TUI；Web 见 TodoDock 不在时间线刷列表
（assistant 正文全文）
```

### 0.3 成功定义（Definition of Done — 全 plan）

| # | 条件 | 否决标准 |
|---|------|----------|
| D1 | 存在 `packages/session-display`，零 UI 依赖 | 包 import opentui/solid-dom |
| D2 | 全部已知 tool + generic 仅经 kernel 出 mode/header/body | `index.tsx` 仍存在 per-tool 展开策略 |
| D3 | §4 表 100% 由测试锁定 | 改 default 不改测试仍绿 |
| D4 | TUI 演示 §0.2 故事 | Shell 成功仍默认摊 stdout |
| D5 | 老用户 `thinking_mode` kv 不被静默覆盖 | 已有 hide 用户突然全文流思考 |
| D6 | Web TodoDock 行为不变；时间线仍不渲染 todowrite part | 时间线与 Dock 双份完整 todo 列表 |
| D7 | Phase B 合并后无「旧 switch fallback」 | `else` 仍走旧 Shell/Edit 组件策略 |
| D8 | `bun test` session-display 全绿；改动包 typecheck 绿 | CI 红 |

**成熟度声明（诚实边界，非漏洞）**

- 完成 A+B+C = **显示层可维护成熟 v1**（策略单源、默认正确、可扫读）。  
- **不等于** Grok pager 全量（无 verb-group 强制、无 accent 波、无键盘折叠全集）——那些在 **Phase D**，不挡 v1 DoD。  
- 审计若攻击「未实现 Phase D」= 规格内非目标，不是缺口。

---

## 1. 不变量（Invariants — 违反即 bug）

| ID | 不变量 |
|----|--------|
| I1 | `resolveMode` 是 mode 唯一真相；adapter 不得自行改 mode |
| I2 | kernel 不得 import `@opentui/*`、`solid-js` DOM、session-ui 组件 |
| I3 | 新 tool 只加 descriptor；禁止在 `routes/session/index.tsx` 加策略 `Match` |
| I4 | `userPinned === true` 时 finish 不得改 mode |
| I5 | `status === "completed"` 且非 error 规则下，Shell **成功** body 为 `none`（§4） |
| I6 | Edit/apply_patch/write **成功且有可展示内容** → mode expanded（除非 `collapsedEditBlocks`） |
| I7 | Web `HIDDEN_TOOLS` 含 `todowrite` 保持；不「清理」为时间线展开列表 |
| I8 | 配置缺省 ≡ §4；未知 `display` 键忽略不炸 |
| I9 | Phase A 合并：用户可感知布局高度与现网一致（允许内部路径变化） |
| I10 | Phase B 合并：无 kv 用户看到 §0.2；有 thinking kv 用户思考行为不变 |

---

## 2. 问题与根因（冻结）

| 现象 | 根因 |
|------|------|
| `index.tsx` ~2700 行 tool UI | 策略+布局+文案耦合 |
| Shell 有 output 即厚 Block | 无 DisplayMode；用组件分叉代替策略 |
| TUI Todo 整表 / Web 隐藏 | 表面分裂无文档化产品规则 |
| Thinking 默认 hide | 与「流中可见→结束收起」目标不符（仅新用户改） |
| 双端 defaultOpen 不一致 | 无共享 kernel |

**不做**：SessionV2、tool 执行、权限审批本体、导出格式重写、Grok 级虚拟滚动引擎。

---

## 3. 架构与类型契约（冻结）

### 3.1 包

```text
packages/session-display/     # workspace 新包，纯 TS
packages/tui/src/display/     # adapter
packages/session-ui/src/display/
```

依赖方向：

```text
session-display → @opencode-ai/sdk (v2 types only)
tui → session-display + opentui
session-ui → session-display + existing UI
```

### 3.2 类型（必须实现）

```ts
// packages/session-display/src/mode.ts
export type DisplayMode = "collapsed" | "truncated" | "expanded"

export type PartStatus = "pending" | "running" | "completed" | "error"

export type ToolFamily =
  | "read" | "search" | "write" | "edit" | "shell"
  | "web" | "task" | "todo" | "question" | "skill" | "mcp" | "generic"

export interface DisplayPolicy {
  streaming: DisplayMode
  /** "keep" = finish 不改 mode（Grok finished_display_mode: None） */
  finished: DisplayMode | "keep"
  error: DisplayMode
  foldable: boolean
  truncatedLines?: number
}

export interface ResolveModeInput {
  policy: DisplayPolicy
  status: PartStatus
  /** 用户点过则钉死；null/undefined = 未钉 */
  userPin: DisplayMode | null
  /** 可选：shell 用 exit code 判定「逻辑失败」 */
  logicalError?: boolean
}

export function resolveMode(input: ResolveModeInput): DisplayMode {
  if (input.userPin != null) return input.userPin
  const failed = input.status === "error" || input.logicalError === true
  if (failed) return input.policy.error
  if (input.status === "pending" || input.status === "running") return input.policy.streaming
  // completed
  if (input.policy.finished === "keep") {
    // 无历史 mode 时：等同 streaming（通常 collapsed）
    return input.policy.streaming
  }
  return input.policy.finished
}
```

```ts
// header / body
export interface HeaderModel {
  verb: string
  icon: string              // 允许 "" 但不推荐；默认表给固定 icon
  family: ToolFamily
  primary: string
  details: string           // 可 ""
  muted: boolean
  status: PartStatus
  accent: ToolFamily | "error" | "muted"
}

export type BodyModel =
  | { kind: "none" }
  | { kind: "text"; text: string; maxLines?: number }
  | { kind: "diff"; diff: string; path: string; maxLines?: number }
  | { kind: "patch"; files: Array<{ path: string; diff: string; type: string }> }
  | { kind: "code"; content: string; path: string; maxLines?: number }
  | { kind: "todos"; items: Array<{ status: string; content: string }> }
  | { kind: "qa"; items: Array<{ question: string; answer: string }> }
  | { kind: "lines"; lines: string[]; maxLines?: number }

export interface ToolViewModel {
  mode: DisplayMode
  header: HeaderModel
  body: BodyModel
  userPinned: boolean
  clickable: boolean
  /** adapter 提示：collapsed 时禁止厚 panel */
  chrome: "inline" | "panel"
}

export function chromeFor(mode: DisplayMode): "inline" | "panel" {
  return mode === "collapsed" ? "inline" : "panel"
}
```

```ts
export interface ToolDescriptor {
  /** 主名 + 别名，lookup 全小写 */
  names: string[]
  family: ToolFamily
  policy(cfg: DisplayConfig): DisplayPolicy
  header(part: ToolPart, ctx: DisplayContext): HeaderModel
  body(part: ToolPart, mode: DisplayMode, ctx: DisplayContext): BodyModel
  /** 可选：完成态是否算逻辑失败（shell exit≠0） */
  logicalError?(part: ToolPart): boolean
}

export interface DisplayContext {
  cwd: string
  width: number
  config: DisplayConfig
  /** 仅格式化用 */
  formatPath(path: string): string
}
```

### 3.3 ToolPart 输入契约（SDK v2，只读）

来源：`packages/sdk/js/src/v2/gen/types.gen.ts`

| 字段 | 用途 |
|------|------|
| `part.tool` | registry 查找（规范化见 §3.4） |
| `part.state.status` | pending\|running\|completed\|error |
| `part.state.input` | header 参数 |
| `part.state.output` | completed 时 tool 文本输出（注意：与 metadata 分工） |
| `part.state.error` | error 时 |
| `part.state.metadata` | 结构化：`output`/`exit`/`diff`/`todos`/`files`/… |
| `part.state.time` | 时长（reasoning/tool） |

**Shell 显示用输出优先级（锁死）**

1. `state.status === "error"` → 失败；body 用 `state.error` + `metadata.output`（若有）  
2. `state.status === "completed"` 且 `metadata.exit` 为 number 且 `!== 0` → **logicalError=true**（失败展示）  
3. `metadata.timeout === true` → logicalError=true  
4. 否则成功；stdout 取 `metadata.output`（string），缺则不展示（成功本就不展示）

TUI 现状读的是 `metadata.output`；保持。

### 3.4 名称规范化（锁死）

```ts
export function normalizeToolName(tool: string): string {
  const t = tool.toLowerCase()
  if (t === "bash") return "shell"
  if (t === "apply_patch") return "patch"
  return t
}
```

Registry 注册名用规范名；`names` 含别名。

### 3.5 完整 tool 目录（OC 已知）

| 规范名 | 别名 | family | Descriptor 文件 |
|--------|------|--------|-----------------|
| read | | read | read.ts |
| list | | search | list.ts（Web 有；TUI 无专用则 generic 也可，**必须有 descriptor** 与 Web 一致 list） |
| glob | | search | glob.ts |
| grep | | search | grep.ts |
| webfetch | | web | web.ts |
| websearch | | web | web.ts |
| shell | bash | shell | shell.ts |
| edit | | edit | edit.ts |
| write | | write | write.ts |
| patch | apply_patch | edit | patch.ts |
| task | | task | task.ts |
| execute | | task | execute.ts |
| todowrite | | todo | todo.ts |
| question | | question | question.ts |
| skill | | skill | skill.ts |
| * | | generic | generic.ts |

### 3.6 双注册表（锁死分工）

| 层 | 职责 | 禁止 |
|----|------|------|
| `session-display` registry | policy / header / body / mode | 渲染组件 |
| session-ui `ToolRegistry` | 把 ViewModel 绑到具体 React/Solid 控件 | 再实现一套 defaultOpen 策略 |
| TUI `display/ToolEntry` | 画 ViewModel | 读 part.tool 写策略 |

Phase B 后：`defaultOpen = (mode !== "collapsed")` **只**来自 kernel。

### 3.7 Reasoning 契约

```ts
// ReasoningPart: text, time.start, time.end?
export interface ReasoningViewModel {
  mode: DisplayMode
  title: string | null      // 现 reasoningSummary
  body: string
  durationMs: number | null // end-start if end
  userPinned: boolean
  status: "streaming" | "done"
}
```

**新用户（无 `thinking_mode` kv）默认**

- streaming（无 `time.end`）：mode=`truncated`，body 末 `truncatedLines=3` 行  
- done：mode=`collapsed`，body 默认不画，header=`Thought` + duration  

**已有 kv**

- `thinking_mode === "hide"`：streaming/done 均 collapsed（header 可见，body 仅 pin/click）——**保持现语义**  
- `thinking_mode === "show"`：始终 expanded  

实现：`resolveReasoningMode(part, storedMode | null, pin, cfg)`。

### 3.8 userPin

- 存储：`Map<partId, DisplayMode>`，key = `part.id`，**session 内存**（刷新丢失 — 明确产品行为）  
- 点击 header：在 collapsed↔expanded 间切换（truncated 点击 → expanded；expanded → collapsed）  
- Grok `next_fold` 简化为二元，足够 v1  

### 3.9 配置（锁死默认值）

```ts
export interface DisplayConfig {
  collapsedEditBlocks: boolean  // default false
  mutedCollapsed: boolean       // default true
  groupToolVerbs: boolean       // default false（Phase D 可 true）
  diffMaxLines: number          // default 500
  shellErrorTruncatedLines: number // default 8
  reasoningTruncatedLines: number  // default 3
  tools: {
    // 可覆盖 per family；缺省用 §4
    [family: string]: Partial<DisplayPolicy> & { truncatedLines?: number }
  }
  reasoning: {
    streaming: DisplayMode      // default "truncated" for new users path
    finished: DisplayMode       // default "collapsed"
    truncatedLines: number
  }
}
```

落地：优先读 opencode 配置中 `display` 对象；无则内置 defaults。Schema 可 Phase B 用 loose object；**不得**因缺 schema 阻塞。

---

## 4. 出厂行为表（锁死 — 测试金标）

| tool/块 | streaming | finished 成功 | error / logicalError | body 成功 collapsed | body 展开时 |
|---------|-----------|---------------|----------------------|---------------------|-------------|
| read | collapsed | collapsed | collapsed | none（**禁止**默认 Loaded 行） | 可选 loaded 列表 text |
| list | collapsed | collapsed | collapsed | none | 条目 lines |
| glob | collapsed | collapsed | collapsed | none | 可选路径列表 truncated |
| grep | collapsed | collapsed | collapsed | none | 匹配行 truncated≤50 |
| webfetch | collapsed | collapsed | collapsed | none | text truncated |
| websearch | collapsed | collapsed | collapsed | none | text truncated |
| skill | collapsed | collapsed | collapsed | none | none/text |
| edit 无 diff | collapsed | collapsed | collapsed | none | — |
| edit 有 diff | collapsed | **expanded** | collapsed | none | diff（maxLines 500） |
| write 无 content | collapsed | collapsed | collapsed | none | — |
| write 有 content | collapsed | **expanded** | collapsed | none | code |
| patch 无 files | collapsed | collapsed | collapsed | none | — |
| patch 有 files | collapsed | **expanded** | collapsed | none | patch multi |
| shell 成功 | collapsed | **collapsed** | — | **none**（零 stdout） | lines 全文/截断 |
| shell 失败 | collapsed | — | **truncated** | — | error+output 末 8 行 |
| task | collapsed | collapsed | truncated | none | lines 子进度 |
| execute | collapsed | collapsed | truncated | none | lines 子调用 |
| todowrite | collapsed | collapsed | collapsed | none | todos 列表 |
| question 未答 | collapsed | collapsed | collapsed | none | — |
| question 已答 | collapsed | collapsed | collapsed | none | qa |
| generic | collapsed | collapsed | truncated | none | text/output 若配置可见 |
| reasoning 新用户 | truncated | collapsed | — | 末 3 行 / 收起后 none | full body |
| reasoning hide kv | collapsed | collapsed | — | none | full on pin |
| reasoning show kv | expanded | expanded | — | full | full |
| text assistant | expanded | expanded | — | full | full |

**相对 Grok 故意偏离（审计不得当错误）**

| 点 | Grok | 本规格 | 原因 |
|----|------|--------|------|
| Shell 失败 | 可仍 collapsed | truncated 尾巴 | 可调试 |
| Write | 并入 Edit 块 | 独立 descriptor 同 Edit 展开策略 | OC 已有 write tool |
| group_tool_verbs | 默认 true | v1 false，D 再开 | 降低 v1 范围 |

**相对 Pi**

| 点 | Pi | 本规格 |
|----|-----|--------|
| Shell 成功预览 5 行 | 有 | **无**（抄 Grok） |
| Edit 流中 diff 预览 | 有 | v1 不强制；有 diff metadata 即 expanded |
| Thinking 默认全文 | 有 | 新用户 truncated→collapsed |

---

## 5. Header 文案与 icon（锁死）

| tool | icon | verb | primary | details 例 |
|------|------|------|---------|------------|
| read | → | Read | shortPath | 可选 range |
| list | • | List | path | |
| glob | ✱ | Glob | pattern | (N matches) |
| grep | ✱ | Grep | "pattern" | (N matches) |
| webfetch | % | Fetch | url truncated | |
| websearch | ◈ | Web Search | query | (N results) |
| skill | → | Skill | name | |
| edit | ← | Edit | path | +N/-M 仅 collapsedEditBlocks |
| write | ← | Write | path | |
| patch | % | Patch | first path 或 N files | |
| shell | $ | （空 verb 或 Run） | description \|\| shortCmd | |
| task | │/✓ | Task | description | |
| execute | │/✓ | execute | 摘要 | |
| todowrite | ⚙ | Todos | | done/total |
| question | → | Questions | | N answered |
| generic | ⚙ | tool name | 摘要 | |

`muted = config.mutedCollapsed && status===completed && mode===collapsed && !error`

`accent = error? error : family`；muted 完成可用 accent muted。

---

## 6. 表面行为（TUI / Web）

### 6.1 TUI

| mode | chrome | 渲染 |
|------|--------|------|
| collapsed | inline | 单行 header；无 BlockTool padding |
| truncated | panel 轻量 | header + body maxLines |
| expanded | panel 轻量 | header + full body（diff 受 diffMaxLines） |

点击：`togglePin(part.id)`。  
Permission 等待：现有 permission UI 不动；header accent=warning 若 callID 匹配（可选，不阻塞）。

### 6.2 Web (session-ui)

| 规则 | 值 |
|------|-----|
| todowrite | **保持** `HIDDEN_TOOLS`；TodoDock 唯一完整列表 |
| `defaultOpen` | `mode !== "collapsed"` |
| ContextToolGroup | **v1 保留**；分组内 item 仍用 kernel header 文案；不删除 group |
| list | 用 list descriptor |

### 6.3 导出

不修改 export 是否含 thinking 的既有对话框语义；**不**要求 export 跟随 TUI pin。

---

## 7. 实施阶段（无半截）

### Phase A — 抽核，零体感（可单独合并）

| ID | 任务 | 完成定义 |
|----|------|----------|
| A0 | 加 workspace 包 `session-display` | package.json exports；turbo/typecheck 入口 |
| A1 | mode + resolveMode + 测试 | 覆盖 pin/error/logicalError/keep/finished |
| A2 | DisplayConfig 内置 **LEGACY** defaults（= 现网高度行为） | 注释 `// LEGACY snapshot for Phase A only` |
| A3 | descriptors: read, shell, edit **LEGACY** | read 仍可输出 Loaded 到 body 当「非 none」以保高度——**仅 A**；shell completed+output → lines max10；edit+diff → expanded |
| A4 | `buildToolViewModel(part,ctx,pin)` | 统一入口 |
| A5 | TUI ToolEntry + 仅 read/shell/edit 接入；其余 **旧组件** | 视觉 diff 零 |
| A6 | 快照测试 6 fixtures | 见 §8 |
| A7 | DoD 检查 I9 | 人工 smoke 三 tool |

**禁止 A 阶段**：改 thinking 默认；去 Loaded；Shell 去 stdout。

### Phase B — 全量切 kernel + §4 默认（可单独合并，**必须完整**）

| ID | 任务 | 完成定义 |
|----|------|----------|
| B0 | LEGACY config 删除；defaults = §4 | 测试全改金标 |
| B1 | **全部** §3.5 descriptors + generic | 无遗漏 list/patch/execute |
| B2 | reasoning resolve + thinking.ts：仅无 kv 用新默认 | 有 kv 单测 |
| B3 | TUI **删除** per-tool 策略分支；一律 ToolEntry | grep 无策略 Match |
| B4 | pin-store | 点击 pin 单测/手工 |
| B5 | session-ui bind-tool-view；defaultOpen 从 mode 来 | HIDDEN todowrite 保留 |
| B6 | Shell logicalError(exit/timeout) | fixtures |
| B7 | 配置读取 display 宽松合并 | 未知键忽略 |
| B8 | DoD D2–D6 | §0.2 演示 |

**禁止 B 未完成合并到 main 后仍保留旧 switch。**

### Phase C — 美化（可单独合并）

| ID | 任务 | 完成定义 |
|----|------|----------|
| C1 | collapsed 强制 inline 零厚 padding | 高度度量/快照 |
| C2 | theme tokens + accent 上色 | 文档 token 表 |
| C3 | path shorten 单测 | |
| C4 | diffMaxLines UI | |
| C5 | Web 文案与 muted 对齐 | |

### Phase D — 增强（非 v1 DoD）

| ID | 任务 |
|----|------|
| D1 | collapsedEditBlocks 用户配置 |
| D2 | groupToolVerbs / 与 ContextToolGroup 统一设计 |
| D3 | 全局 expand-all 快捷键 |
| D4 | pin 持久化（可选） |
| D5 | Pi 状态浅底（可选） |

---

## 8. 测试规格（金标）

### 8.1 resolveMode

| status | logicalError | pin | policy.finished | 期望 mode |
|--------|--------------|-----|-----------------|-----------|
| running | F | null | collapsed | streaming |
| completed | F | null | collapsed | collapsed |
| completed | F | null | expanded | expanded |
| completed | F | null | keep | streaming |
| completed | T | null | any | error policy |
| error | F | null | any | error policy |
| completed | F | expanded | collapsed | expanded（pin） |

### 8.2 工具快照（最少）

| Fixture | 期望 |
|---------|------|
| read completed | collapsed, body none, no Loaded |
| shell completed exit 0 + long output | collapsed, body none |
| shell completed exit 1 + output | truncated, body lines |
| shell error | truncated |
| edit completed + diff | expanded, body diff |
| edit error | collapsed |
| write completed + content | expanded |
| patch multi file | expanded patch |
| todowrite | collapsed details done/total |
| question answered | collapsed |
| reasoning streaming 新用户 | truncated |
| reasoning done 新用户 | collapsed |
| reasoning + kv hide | collapsed always |

### 8.3 命令

```bash
cd packages/session-display && bun test
cd packages/tui && bun typecheck   # 以包内脚本为准
cd packages/session-ui && bun typecheck
```

---

## 9. 迁移与兼容

| 状态 | 行为 |
|------|------|
| 无 `thinking_mode` kv | 新默认 truncated→collapsed |
| `thinking_mode=hide` | 保持 hide 语义（header 在 body 隐） |
| `thinking_mode=show` | 保持 show |
| 旧 `thinking_visibility` | 保持现 `thinking.ts` 迁移逻辑 |
| `generic_tool_output_visibility` | 仅影响 generic body 是否提供；默认 false 则 generic 成功 collapsed 且 body none |
| 会话中 pin | 内存；刷新丢 |
| collapsedEditBlocks | 默认 false；true 时 edit/patch 成功 finished=collapsed 且 header 带 +N/-M（若有统计） |

---

## 10. 风险 → 设计内缓解（不是「以后」）

| 风险 | 缓解（已写入规格） |
|------|-------------------|
| Shell 成功看不到输出难调试 | 点击 expand；失败 truncated；配置可改 family policy |
| 半截双路径 | B3 硬门禁；DoD D7 |
| metadata 漂移 | §3.3 优先级；单测 fixtures |
| Todo 双 UI | I7 + §6.2 |
| 大 diff 卡死 | diffMaxLines=500 |
| 包依赖环 | §3.1 单向 |
| 审计攻击「未抄 Pi 5 行 shell」 | §4 故意偏离表 |
| 审计攻击「无 verb-group」 | Phase D 非 v1 DoD |
| Thinking 变更惊吓老用户 | §3.7 + §9 kv |
| ContextToolGroup 与一行密度 | v1 保留 group；内部用 kernel 文案 |

---

## 11. 文件清单（实现必交付）

```text
packages/session-display/package.json
packages/session-display/tsconfig.json
packages/session-display/src/index.ts
packages/session-display/src/mode.ts
packages/session-display/src/resolve.ts
packages/session-display/src/config.ts
packages/session-display/src/registry.ts
packages/session-display/src/normalize.ts
packages/session-display/src/header-utils.ts
packages/session-display/src/build.ts          # buildToolViewModel
packages/session-display/src/tools/*.ts        # §3.5 全表
packages/session-display/src/parts/reasoning.ts
packages/session-display/test/**/*.ts
packages/tui/src/display/ToolEntry.tsx
packages/tui/src/display/ReasoningEntry.tsx
packages/tui/src/display/pin-store.ts
packages/tui/src/display/body/*.tsx
packages/session-ui/src/display/bind-tool-view.ts
# 修改
packages/tui/src/routes/session/index.tsx     # 瘦身
packages/tui/src/context/thinking.ts          # 默认解析
packages/session-ui/src/components/message-part.tsx
opencode/package.json / 依赖声明（若需）
```

---

## 12. 反审计自检清单（发布本 plan 前作者已勾）

- [x] Edit 默认 expanded（非 collapse）— Grok collapsed_edit_blocks 默认 false  
- [x] Shell agent 成功零 body — Grok execute  
- [x] Shell bash_mode 用户 `!` 不在 OC v1 范围（OC 无对等则忽略）  
- [x] Write/patch 映射策略写清  
- [x] apply_patch/list/execute 未漏  
- [x] Thinking hide 精确语义  
- [x] TodoDock 非死注册  
- [x] 双注册表分工  
- [x] pin / keep / logicalError  
- [x] 测试金标  
- [x] Phase 半截禁止  
- [x] 故意偏离表  
- [x] DoD 可否决  

**其他 AI 审计规则**：只许基于本文件 + ref/OC 源码攻击；若攻击「Phase D 未做」→ 无效；若攻击事实错误须给路径。

---

## 13. 进度

| Phase | 状态 |
|-------|------|
| SEALED 规格 | **done** |
| A | not started |
| B | not started |
| C | not started |
| D | not started |

---

## 14. 修订日志

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.x | 2026-08-02 | living / 问卷式草稿 |
| 2.x | 2026-08-02 | executable 但仍有漏洞话术 |
| **3.0 SEALED** | 2026-08-02 | 全锁默认、契约、迁移、DoD、反审计清单；禁止半截 |

---

## 15. 开工第一刀（A0–A1）

```bash
# 1. 创建 packages/session-display 并加入 workspaces（已覆盖 packages/*）
# 2. 实现 mode.ts resolve.ts + test
# 3. bun test
```

此后严格 A→B→C；**B 必须一次达标 DoD D2/D7**。
