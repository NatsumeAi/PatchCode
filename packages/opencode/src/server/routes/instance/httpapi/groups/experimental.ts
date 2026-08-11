import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

export const MemoryFileListEntry = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["global", "workspace", "session"]),
}).annotate({ identifier: "MemoryFileListEntry" })
export const MemoryFileList = Schema.Array(MemoryFileListEntry).annotate({ identifier: "MemoryFileList" })
export const MemoryReadQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
}).annotate({ identifier: "MemoryReadQuery" })
export const MemoryReadResponse = Schema.Struct({
  content: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "MemoryReadResponse" })
export const MemorySessionLogDeleteQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
}).annotate({ identifier: "MemorySessionLogDeleteQuery" })
export const MemoryHealthResponse = Schema.Struct({
  files: Schema.Number,
  totalBytes: Schema.Number,
  chunks: Schema.Number,
  bySource: Schema.Struct({ global: Schema.Number, workspace: Schema.Number, session: Schema.Number }),
  zeroAccessChunks: Schema.Number,
  pruneCandidates: Schema.Number,
  lastConsolidatedAt: Schema.optional(Schema.Number),
  // Observability (optional / backward compatible)
  lastConsolidateStatus: Schema.optional(
    Schema.Literals(["completed", "nothing", "skipped", "failed", "never"]),
  ),
  lastConsolidateReason: Schema.optional(Schema.String),
  flushSuccess: Schema.optional(Schema.Number),
  flushNoReply: Schema.optional(Schema.Number),
  flushFailed: Schema.optional(Schema.Number),
  sourcesMerged: Schema.optional(Schema.Number),
  hybridEnabled: Schema.optional(Schema.Boolean),
  hybridModel: Schema.optional(Schema.String),
  vectorCoverage: Schema.optional(Schema.Number),
  actionHint: Schema.optional(Schema.String),
  dreamLastLight: Schema.optional(Schema.Number),
  dreamLastDeep: Schema.optional(Schema.Number),
  dreamLastRem: Schema.optional(Schema.Number),
  dreamNextHint: Schema.optional(Schema.String),
  recallMaxAgeDays: Schema.optional(Schema.Number),
  recallMinScore: Schema.optional(Schema.Number),
  citationsMode: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryHealthResponse" })
export const MemoryExportPayload = Schema.Struct({
  target: Schema.String,
  includeRaw: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MemoryExportPayload" })
export const MemoryImportPayload = Schema.Struct({
  source: Schema.String,
  force: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MemoryImportPayload" })
export const MemoryImportResponse = Schema.Struct({
  imported: Schema.Number,
  skipped: Schema.Number,
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryImportResponse" })
export const MemoryRememberPayload = Schema.Struct({
  note: Schema.String,
}).annotate({ identifier: "MemoryRememberPayload" })
export const MemoryRememberResponse = Schema.Struct({
  filename: Schema.String,
}).annotate({ identifier: "MemoryRememberResponse" })

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  resource: "/experimental/resource",
  memory: "/experimental/memory",
  memoryRead: "/experimental/memory/read",
  memorySessionLog: "/experimental/memory/session-log",
  memoryHealth: "/experimental/memory/health",
  memoryExport: "/experimental/memory/export",
  memoryImport: "/experimental/memory/import",
  memoryRemember: "/experimental/memory/remember",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("memory", ExperimentalPaths.memory, {
          query: WorkspaceRoutingQuery,
          success: described(MemoryFileList, "List memory files"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.list",
            summary: "List memory files",
            description: "List curated memory and session log files for the current project.",
          }),
        ),
        HttpApiEndpoint.get("memoryRead", ExperimentalPaths.memoryRead, {
          query: MemoryReadQuery,
          success: described(MemoryReadResponse, "Read a memory file"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.read",
            summary: "Read a memory file",
            description: "Read a memory file (scoped to the memory roots).",
          }),
        ),
        HttpApiEndpoint.delete("memorySessionLog", ExperimentalPaths.memorySessionLog, {
          query: MemorySessionLogDeleteQuery,
          success: described(Schema.Boolean, "Delete a session log"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.session-log.delete",
            summary: "Delete a session log",
            description: "Delete a session log file (only paths under sessions/).",
          }),
        ),
        HttpApiEndpoint.get("memoryHealth", ExperimentalPaths.memoryHealth, {
          query: WorkspaceRoutingQuery,
          success: described(MemoryHealthResponse, "Memory health stats"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.health",
            summary: "Memory health",
            description: "Aggregated memory usage stats for the current project.",
          }),
        ),
        HttpApiEndpoint.post("memoryExport", ExperimentalPaths.memoryExport, {
          query: WorkspaceRoutingQuery,
          payload: MemoryExportPayload,
          success: described(Schema.Boolean, "Memory exported"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.export",
            summary: "Export memory",
            description: "Export curated memory (optionally raw notes) into a pack directory.",
          }),
        ),
        HttpApiEndpoint.post("memoryImport", ExperimentalPaths.memoryImport, {
          query: WorkspaceRoutingQuery,
          payload: MemoryImportPayload,
          success: described(MemoryImportResponse, "Memory imported"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.import",
            summary: "Import memory",
            description: "Import a memory pack (never overwrites newer-or-equal local curated files).",
          }),
        ),
        HttpApiEndpoint.post("memoryRemember", ExperimentalPaths.memoryRemember, {
          query: WorkspaceRoutingQuery,
          payload: MemoryRememberPayload,
          success: described(MemoryRememberResponse, "Memory note written"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.remember",
            summary: "Remember a note",
            description:
              "Write an append-only memory note (same path as memory_add_note) without an LLM round-trip. Used by the TUI /remember command.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
