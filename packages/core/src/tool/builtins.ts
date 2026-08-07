export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { LspTool } from "./lsp"
import { PlanEnterTool } from "./plan-enter"
import { PlanExitTool } from "./plan-exit"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { SkillTool } from "./skill"
import { TaskTool } from "./task"
import { PeerTool } from "./peer"
import { TodoWriteTool } from "./todowrite"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"
import { MemoryTools } from "../memory/tools"

/**
 * Composes the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * Host bridges (LSP.Host, Task.Host) are optional: tools register always and
 * fail clearly when the host is not provided. opencode wires the hosts at the
 * app layer so V2 sessions get real task/lsp execution.
 *
 * TODO: Port remaining leaves: edit fuzzy parity, repo_clone, repo_overview,
 * Rune/code mode. Keep MCP and plugin transforms separate from this list.
 */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    BashTool.node,
    EditTool.node,
    GlobTool.node,
    GrepTool.node,
    LspTool.node,
    PlanEnterTool.node,
    PlanExitTool.node,
    QuestionTool.node,
    ReadTool.node,
    SkillTool.node,
    TaskTool.node,
    PeerTool.node,
    TodoWriteTool.node,
    MemoryTools.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
  ],
})
