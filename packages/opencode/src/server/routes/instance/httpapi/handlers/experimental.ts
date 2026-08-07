import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Option } from "effect"
import { join } from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { resolveRoots } from "@opencode-ai/core/memory/storage"
import { resolveScopedFile } from "@opencode-ai/core/memory/paths"
import { collectHealth } from "@opencode-ai/core/memory/health"
import { openMemoryIndex } from "@opencode-ai/core/memory/reindex"
import { exportMemory, importMemory } from "@opencode-ai/core/memory/transfer"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import {
  ConsoleSwitchPayload,
  MemoryFileList,
  MemoryExportPayload,
  MemoryHealthResponse,
  MemoryImportPayload,
  MemoryImportResponse,
  MemoryReadQuery,
  MemoryReadResponse,
  MemorySessionLogDeleteQuery,
  SessionListQuery,
  ToolListQuery,
  WorktreeApiError,
} from "../groups/experimental"

function relativePath(roots: { globalDir: string; workspaceDir?: string }, full: string): string {
  const base = full.startsWith(roots.globalDir) ? roots.globalDir : (roots.workspaceDir ?? roots.globalDir)
  return full.slice(base.length + 1).replace(/\\/g, "/")
}

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    const listMemory = Effect.fn("ExperimentalHttpApi.memory")(function* () {
      const route = yield* WorkspaceRouteContext
      const fs = yield* FSUtil.Service
      const roots = resolveRoots(join(Global.Path.data, "memory"), route.directory)
      const files: Array<{ path: string; name: string; kind: "global" | "workspace" | "session" }> = []
      const walk = (dir: string, kind: "global" | "workspace"): Effect.Effect<void> =>
        Effect.gen(function* () {
          const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
          for (const entry of entries) {
            const full = join(dir, entry.name)
            if (entry.type === "directory") {
              yield* walk(full, kind)
            } else if (entry.type === "file" && entry.name.endsWith(".md")) {
              const relative = relativePath(roots, full)
              files.push({
                path: relative,
                name: entry.name,
                kind: relative.startsWith("sessions/") ? "session" : kind,
              })
            }
          }
        })
      yield* walk(roots.globalDir, "global")
      if (roots.workspaceDir !== undefined) yield* walk(roots.workspaceDir, "workspace")
      return files.sort((a, b) => a.path.localeCompare(b.path))
    })

    const readMemory = Effect.fn("ExperimentalHttpApi.memoryRead")(function* (ctx: { query: typeof MemoryReadQuery.Type }) {
      const route = yield* WorkspaceRouteContext
      const fs = yield* FSUtil.Service
      const roots = resolveRoots(join(Global.Path.data, "memory"), route.directory)
      const base = roots.workspaceDir ?? roots.globalDir
      const resolved = yield* resolveScopedFile(fs, base, ctx.query.path).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none())),
      )
      if (Option.isNone(resolved)) return { content: "", truncated: false }
      const text = yield* Effect.orElseSucceed(fs.readFileStringSafe(resolved.value), () => undefined)
      const content = (text ?? "").slice(0, 40_000)
      return { content, truncated: (text?.length ?? 0) > 40_000 }
    })

    const memoryHealth = Effect.fn("ExperimentalHttpApi.memoryHealth")(function* () {
      const route = yield* WorkspaceRouteContext
      const fs = yield* FSUtil.Service
      const roots = resolveRoots(join(Global.Path.data, "memory"), route.directory)
      const index = yield* openMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (index === undefined)
        return {
          files: 0,
          totalBytes: 0,
          chunks: 0,
          bySource: { global: 0, workspace: 0, session: 0 },
          zeroAccessChunks: 0,
          pruneCandidates: 0,
        }
      try {
        return yield* collectHealth(fs, roots, index)
      } finally {
        yield* index.close().pipe(Effect.catch(() => Effect.void))
      }
    })

    const exportMemoryPack = Effect.fn("ExperimentalHttpApi.memoryExport")(function* (ctx: {
      payload: typeof MemoryExportPayload.Type
    }) {
      const route = yield* WorkspaceRouteContext
      const fs = yield* FSUtil.Service
      const roots = resolveRoots(join(Global.Path.data, "memory"), route.directory)
      yield* exportMemory(fs, roots, ctx.payload.target, { includeRaw: ctx.payload.includeRaw ?? false }).pipe(
        Effect.catch(() => Effect.void),
      )
      return true
    })

    const importMemoryPack = Effect.fn("ExperimentalHttpApi.memoryImport")(function* (ctx: {
      payload: typeof MemoryImportPayload.Type
    }) {
      const route = yield* WorkspaceRouteContext
      const fs = yield* FSUtil.Service
      const roots = resolveRoots(join(Global.Path.data, "memory"), route.directory)
      return yield* importMemory(fs, roots, ctx.payload.source).pipe(
        Effect.catch(() => Effect.succeed({ imported: 0, skipped: 0 })),
      )
    })

    const deleteSessionLog = Effect.fn("ExperimentalHttpApi.memorySessionLog")(function* (ctx: { query: typeof MemorySessionLogDeleteQuery.Type }) {
      const route = yield* WorkspaceRouteContext
      const fs = yield* FSUtil.Service
      const roots = resolveRoots(join(Global.Path.data, "memory"), route.directory)
      const base = roots.workspaceDir ?? roots.globalDir
      if (!ctx.query.path.startsWith("sessions/")) return false
      const resolved = yield* resolveScopedFile(fs, base, ctx.query.path).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none())),
      )
      if (Option.isNone(resolved)) return false
      yield* fs.remove(resolved.value).pipe(Effect.orDie)
      return true
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("resource", resource)
      .handle("memory", listMemory)
      .handle("memoryRead", readMemory)
      .handle("memorySessionLog", deleteSessionLog)
      .handle("memoryHealth", memoryHealth)
      .handle("memoryExport", exportMemoryPack)
      .handle("memoryImport", importMemoryPack)
  }),
)
