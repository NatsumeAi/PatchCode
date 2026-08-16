export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { JobTool } from "./job"
import { ApplyPatchTool } from "./apply-patch"
import { BrowserTool } from "./browser"
import { EditTool } from "./edit"
import { ExecuteTool } from "./execute"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ListDirTool } from "./list-dir"
import { LspTool } from "./lsp"
import { PlanEnterTool } from "./plan-enter"
import { PlanExitTool } from "./plan-exit"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { RepoCloneTool } from "./repo-clone"
import { RepoOverviewTool } from "./repo-overview"
import { ReviewTool } from "./review"
import { SearchTool } from "./search-tool"
import { SkillTool } from "./skill"
import { SkillInstallTool } from "./skill-install"
import { SkillTrustTool } from "./skill-trust"
import { TaskTool } from "./task"
import { PeerTool } from "./peer"
import { TodoWriteTool } from "./todowrite"
import { UseTool } from "./use-tool"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"
import { WorktreeTool } from "./worktree"
import { MemoryTools } from "../memory/tools"

/**
 * Composes the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * Host bridges (LSP.Host, Task.Host, Browser.Host) are optional: tools register
 * always and fail clearly when the host is not provided. opencode wires the
 * hosts at the app layer so V2 sessions get real task/lsp/browser execution.
 */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    BashTool.node,
    BrowserTool.node,
    JobTool.node,
    EditTool.node,
    ExecuteTool.node,
    GlobTool.node,
    GrepTool.node,
    ListDirTool.node,
    WorktreeTool.node,
    LspTool.node,
    PlanEnterTool.node,
    PlanExitTool.node,
    QuestionTool.node,
    ReadTool.node,
    RepoCloneTool.node,
    RepoOverviewTool.node,
    ReviewTool.node,
    SearchTool.node,
    SkillTool.node,
    SkillInstallTool.node,
    SkillTrustTool.node,
    TaskTool.node,
    PeerTool.node,
    TodoWriteTool.node,
    MemoryTools.node,
    UseTool.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
  ],
})
