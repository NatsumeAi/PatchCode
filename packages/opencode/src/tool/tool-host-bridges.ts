/**
 * Provides Host bridges so core tools (lsp, task) can call opencode services
 * (LSP stack, subagent spawn) without pulling them into core.
 *
 * Task host uses Session primitives (admit + wake/resume + SessionMessageTable)
 * rather than the legacy prompt loop, so child history is projected correctly.
 */
export * as ToolHostBridges from "./tool-host-bridges"

import { LspTool } from "@opencode-ai/core/tool/lsp"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { PluginHooks } from "@opencode-ai/core/plugin-hooks"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionWire } from "@opencode-ai/core/session-legacy"
import { Agent } from "@opencode-ai/core/agent"
import {
  deriveSubagentPermission,
  tightenCapability,
} from "@opencode-ai/core/session/subagent-permissions"
import { Permission } from "@opencode-ai/core/permission"
import { SubagentLifecycle } from "@opencode-ai/core/session/subagent-lifecycle"
import { MemoryDelegation } from "@opencode-ai/core/memory/delegation-wire"
import os from "os"
import { SubagentRegistry } from "@opencode-ai/core/session/subagent-registry"
import { validateResumeIdentity } from "@opencode-ai/core/session/subagent-identity"
import { projectParentMessagesForInsert, projectParentTrace } from "@opencode-ai/core/session/fork-mode"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Event as CoreEvent } from "@opencode-ai/core/event"
import { SessionRuntime } from "@opencode-ai/core/session/runtime"
import { EventBridge } from "@opencode-ai/core/session/loop-control/event-bridge"
import { SpawnEdge } from "@opencode-ai/core/session/loop-control/spawn-edge"
import { IterationBudget } from "@opencode-ai/core/session/loop-control/iteration-budget"
import { WorktreeEngine } from "@opencode-ai/core/worktree-engine"
import { Hooks } from "@opencode-ai/core/hooks"
import { PersonaLoader } from "@opencode-ai/core/session/persona/loader"
import { PersonaResolve } from "@opencode-ai/core/session/persona/resolve"
import { PersonaStore } from "@opencode-ai/core/session/persona/store"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Model } from "@opencode-ai/core/model"
import { Workspace } from "@opencode-ai/core/workspace"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Slug } from "@opencode-ai/core/util/slug"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { BackgroundJob } from "@/background/job"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import * as Bom from "@/util/bom"
import { EventBridge as CoreEventBridge } from "@/event-bridge"
import { DateTime, Duration, Effect, Layer, Option, Schedule, Scope, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DynamicTools } from "./dynamic-tools"
import { BrowserHostBridge } from "./browser-host"
import { Plugin } from "@/plugin"
import path from "path"

/** Subagents cannot spawn further subagents (flat delegation, grok-build parity). */
const MAX_SUBAGENT_DEPTH = 1
/** Foreground wait budget before a subagent is promoted to background. */
const FOREGROUND_WAIT_BUDGET_MS = 2 * 60 * 1_000
/** Upper bound for ancestor-chain walks (cycle protection). */
const ANCESTOR_TRACE_CAP = 10

/**
 * Resolve the child session working directory. Explicit task cwd wins over the
 * agent-level workspace; both must stay inside the project directory (escape
 * attempts are rejected).
 */
export function resolveChildDirectory(input: {
  projectDirectory: string
  parentDirectory: string
  requestedCwd?: string
  agentWorkspace?: string
}): string {
  const target = input.requestedCwd ?? input.agentWorkspace
  if (target === undefined) return input.parentDirectory
  const resolved = path.resolve(input.projectDirectory, target)
  const projectRoot = `${input.projectDirectory}${path.sep}`
  if (resolved !== input.projectDirectory && !resolved.startsWith(projectRoot)) {
    throw new Error(`Subagent workspace "${target}" escapes the project directory`)
  }
  return resolved
}

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

const mutationEffectsLayer = Layer.effect(
  FileMutation.EffectsService,
  Effect.gen(function* () {
    const format = yield* Format.Service
    const events = yield* CoreEventBridge.Service
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return FileMutation.EffectsService.of({
      afterCommit: Effect.fn("FileMutation.Effects.afterCommit")(function* (input) {
        if (input.operation === "remove") {
          yield* events.publish(FileSystem.Event.Edited, { file: input.path })
          yield* events.publish(Watcher.Event.Updated, { file: input.path, event: "unlink" })
          return { diagnostics: "" }
        }
        if (input.operation === "rename" && input.from) {
          yield* events.publish(FileSystem.Event.Edited, { file: input.from })
          yield* events.publish(Watcher.Event.Updated, { file: input.from, event: "unlink" })
        }
        const before = yield* fs.readFile(input.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const hadBom = Boolean(
          before && before[0] === 0xef && before[1] === 0xbb && before[2] === 0xbf,
        )
        if (yield* format.file(input.path)) {
          yield* Bom.syncFile(fs, input.path, hadBom)
        }
        yield* events.publish(FileSystem.Event.Edited, { file: input.path })
        yield* events.publish(Watcher.Event.Updated, {
          file: input.path,
          event: input.existed && input.operation !== "rename" ? "change" : "add",
        })
        yield* lsp.touchFile(input.path, "document")
        const diagnostics = yield* lsp.diagnostics()
        const normalized = FSUtil.normalizePath(input.path)
        let output = ""
        let projectDiagnosticsCount = 0
        for (const [file, issues] of Object.entries(diagnostics)) {
          const current = file === normalized
          if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
          const block = LSP.Diagnostic.report(current ? input.path : file, issues)
          if (!block) continue
          if (current) {
            output += `\n\nLSP errors detected in this file, please fix:\n${block}`
            continue
          }
          projectDiagnosticsCount++
          output += `\n\nLSP errors detected in other files:\n${block}`
        }
        return { diagnostics: output }
      }),
    })
  }),
)

export const mutationEffectsNode = makeGlobalNode({
  service: FileMutation.EffectsService,
  layer: mutationEffectsLayer,
  deps: [Format.node, CoreEventBridge.node, LSP.node, FSUtil.node],
})

const lspHostLayer = Layer.effect(
  LspTool.HostService,
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    return LspTool.HostService.of({
      hasClients: (file) => lsp.hasClients(file),
      touchFile: (file, reason) => lsp.touchFile(file, reason),
      definition: (input) => lsp.definition(input),
      references: (input) => lsp.references(input),
      hover: (input) => lsp.hover(input),
      documentSymbol: (uri) => lsp.documentSymbol(uri),
      workspaceSymbol: (query) => lsp.workspaceSymbol(query),
      implementation: (input) => lsp.implementation(input),
      prepareCallHierarchy: (input) => lsp.prepareCallHierarchy(input),
      incomingCalls: (input) => lsp.incomingCalls(input),
      outgoingCalls: (input) => lsp.outgoingCalls(input),
    })
  }),
)
function lastAssistantText(messages: readonly SessionMessage.Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== "assistant") continue
    const text = msg.content
      .filter((part): part is SessionMessage.AssistantText => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

const TASK_NOT_CAPTURED = "[task not captured]"

// Registry records carry no prompt field, so the background path falls back
// to the child's first user message (the admitted task), else a marker.
const childTaskPrompt = (store: SessionStore.Interface, childSessionID: SessionSchema.ID): Effect.Effect<string> =>
  store.context(childSessionID).pipe(
    Effect.map((messages) => {
      const firstUser = messages.find((m) => m.type === "user")
      if (firstUser?.type !== "user") return TASK_NOT_CAPTURED
      const text = firstUser.text.trim()
      return text === "" ? TASK_NOT_CAPTURED : text
    }),
    Effect.catch(() => Effect.succeed(TASK_NOT_CAPTURED)),
  )

export function lastAssistantError(messages: readonly SessionMessage.Message[]): string | undefined {
  const latest = messages.findLast((m) => m.type === "assistant")
  return latest?.type === "assistant" && latest.error !== undefined ? latest.error.message : undefined
}

/**
 * Detect whether a subagent finished because its per-agent step budget was
 * exhausted (max-steps: last turn had toolChoice "none" + MAX_STEPS_PROMPT
 * injected). The assistant turn count equals agent.steps and the final
 * assistant message made no tool calls.
 */
export function detectBudgetExhausted(input: {
  agentSteps: number | undefined
  messages: readonly SessionMessage.Message[]
}): boolean {
  const { agentSteps, messages } = input
  if (agentSteps === undefined || messages.length === 0) return false
  const assistantCount = messages.filter((m) => m.type === "assistant").length
  if (assistantCount < agentSteps) return false
  const latest = messages.findLast((m) => m.type === "assistant")
  if (latest?.type !== "assistant") return false
  return !latest.content.some((part) => part.type === "tool")
}

const taskHostLayer = Layer.effect(
  TaskTool.HostService,
  Effect.gen(function* () {
    // Process-scoped services available in the app graph (no CoreSession — avoids cycles).
    const store = yield* SessionStore.Service
    const events = yield* CoreEvent.Service
    const database = yield* Database.Service
    const projects = yield* Project.Service
    const background = yield* BackgroundJob.Service
    const registryOpt = yield* Effect.serviceOption(SubagentRegistry.Service)
    const executionOpt = yield* Effect.serviceOption(SessionExecution.Service)
    const runtimeOpt = yield* Effect.serviceOption(SessionRuntime.Service)
    const personaStoreOpt = yield* Effect.serviceOption(PersonaStore.Service)
    const permissionOpt = yield* Effect.serviceOption(Permission.Service)
    const lifecycleOpt = yield* Effect.serviceOption(SubagentLifecycle.Service)
    const scope = yield* Scope.Scope
    const db = database.db

    /** Release spawn edge + agent guard for a child under parent (idempotent). */
    const releaseParentResources = (
      parentSessionID: SessionSchema.ID,
      childSessionID: SessionSchema.ID,
    ) =>
      Effect.gen(function* () {
        if (runtimeOpt._tag !== "Some") return
        const inst = yield* runtimeOpt.value.getOrCreate(parentSessionID)
        const edge = inst.spawnEdges.get(String(childSessionID))
        if (edge) {
          yield* SpawnEdge.close(edge).pipe(Effect.ignore)
          inst.spawnEdges.delete(String(childSessionID))
        }
        const g = inst.agentGuards.get(String(childSessionID))
        if (g) {
          yield* g.release
          inst.agentGuards.delete(String(childSessionID))
        }
      })

    const bridgeParentLoop = (
      parentSessionID: SessionSchema.ID,
      childSessionID: SessionSchema.ID,
      ok: boolean,
      error?: string,
    ) =>
      Effect.gen(function* () {
        if (runtimeOpt._tag !== "Some") return
        const inst = yield* runtimeOpt.value.getOrCreate(parentSessionID)
        yield* EventBridge.publishSubagentTerminal({
          eventBus: inst.eventBus,
          parentSessionID: String(parentSessionID),
          childSessionID: String(childSessionID),
          ok,
          error,
        })
        yield* releaseParentResources(parentSessionID, childSessionID)
      })

    // SessionIdle consumer: release orphaned edges/guards for terminal children.
    if (lifecycleOpt._tag === "Some") {
      yield* lifecycleOpt.value
        .register({
          name: "task-host-session-idle",
          version: 1,
          on: {
            SessionIdle: (event) =>
              Effect.gen(function* () {
                if (registryOpt._tag !== "Some") return
                const snap = yield* registryOpt.value.snapshot
                const parentID = SessionSchema.ID.make(String(event.sessionID))
                for (const rec of snap) {
                  if (String(rec.parentSessionID) !== String(event.sessionID)) continue
                  if (rec.status === "pending" || rec.status === "active") continue
                  yield* releaseParentResources(parentID, rec.childSessionID)
                }
              }),
          },
        })
        .pipe(Effect.ignore)
    }

    // On heartbeat loss: notify the parent session and cancel the child so a
    // lost subagent does not linger as active in the registry. Interrupting
    // the session is required for "cancelled" to be true — cancelling only the
    // monitor job and the registry record would leave the drain running
    // orphaned (still spending tokens with no observer).
    yield* events
      .subscribe(SessionEvent.Subagent.HeartbeatLost)
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const childID = SessionSchema.ID.make(String(event.data.childSessionID))
            yield* notifyParent(childID, "error", "Subagent stalled (no progress). It was cancelled.")
            yield* background.cancel(childID).pipe(Effect.ignore)
            if (Option.isSome(executionOpt)) {
              yield* executionOpt.value.interrupt(childID).pipe(Effect.ignore)
            }
            if (registryOpt._tag === "Some") {
              yield* registryOpt.value.cancel(childID).pipe(Effect.ignore)
            }
          }),
        ),
        Effect.forkScoped,
        Effect.asVoid,
      )

    const notifyParent = (
      childSessionID: SessionSchema.ID,
      state: "completed" | "error",
      text: string,
      ok: boolean = state === "completed",
    ) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("TaskHost.notifyParent", { childSessionID: String(childSessionID), state })
        const child = yield* store.get(childSessionID)
        if (!child?.parentID) return
        const parentID = child.parentID
        const parent = yield* store.get(parentID)
        const subagentType =
          registryOpt._tag === "Some"
            ? ((yield* registryOpt.value.get(childSessionID))?.subagentType ?? "task")
            : "task"
        const messageID = SessionMessage.ID.create()
        const tag = state === "error" ? "task_error" : "task_result"
        const structured =
          state === "completed"
            ? `<structured exit="completed" resumeFrom="${childSessionID}" />`
            : `<structured exit="failed" resumeFrom="${childSessionID}" />`
        const body = [
          `<task id="${childSessionID}" state="${state}">`,
          `<${tag}>`,
          text,
          `</${tag}>`,
          structured,
          "</task>",
        ].join("\n")
        yield* SessionInput.admit(db, events, {
          id: messageID,
          sessionID: parentID,
          prompt: Prompt.make({ text: body }),
          delivery: "steer",
        })
        const executionOpt = yield* Effect.serviceOption(SessionExecution.Service)
        if (Option.isSome(executionOpt)) yield* executionOpt.value.wake(parentID).pipe(Effect.ignore)
        if (registryOpt._tag === "Some") {
          yield* registryOpt.value
            .transition(childSessionID, state === "completed" ? "completed" : "failed", {
              ...(state === "error" ? { error: text } : {}),
              resumeFrom: String(childSessionID),
            })
            .pipe(Effect.ignore)
        }
        yield* events
          .publish(
            state === "completed" ? SessionEvent.Subagent.Completed : SessionEvent.Subagent.Failed,
            {
              timestamp: yield* DateTime.now,
              sessionID: parentID,
              childSessionID: String(childSessionID),
              subagentType,
              ...(state === "completed"
                ? { output: text, resumeFrom: String(childSessionID) }
                : { error: text, resumeFrom: String(childSessionID) }),
            },
            { location: parent?.location },
          )
          .pipe(Effect.ignore)
        yield* bridgeParentLoop(parentID, childSessionID, state === "completed", state === "error" ? text : undefined)
        yield* Hooks.fire({ event: "SubagentStop", sessionID: String(parentID), toolName: subagentType }).pipe(
          Effect.ignore,
        )
        // Leave the worktree leased so the parent can merge/diff/discard.
        // Cancel paths still discard.
        // Additive memory observation: no-op when memory services aren't loaded.
        // `ok` is threaded explicitly: a budget-exhausted child settles this
        // path as "completed" but must record ok=false (mirrors the foreground
        // settle, where exit === "budget_exhausted" maps to ok=false).
        const delegationOpt = yield* Effect.serviceOption(MemoryDelegation.Service)
        if (delegationOpt._tag === "Some") {
          yield* delegationOpt.value
            .record({
              parentSessionID: String(parentID),
              childSessionID: String(childSessionID),
              task: yield* childTaskPrompt(store, childSessionID),
              result: text,
              ok,
            })
            .pipe(Effect.ignore)
        }
      })

    const observeBackground = (childSessionID: SessionSchema.ID, agentSteps?: number) =>
      Effect.logInfo("TaskHost.observeBackground enter", { childSessionID: String(childSessionID) }).pipe(
        Effect.andThen(
          background
            .wait({ id: childSessionID })
            .pipe(
              Effect.tap((result) =>
                Effect.logInfo("TaskHost.observeBackground resolved", {
                  childSessionID: String(childSessionID),
                  status: result.info?.status ?? "none",
                }),
              ),
              Effect.flatMap((result) => {
            if (result.info?.status === "completed") {
              const output = result.info.output ?? "Subagent completed."
              return Effect.gen(function* () {
                // A budget-exhausted child settles the background job as
                // completed (waitOnly returns its text), but it is a failed
                // outcome for delegation — mirror the foreground exit
                // classification so the observation's ok flag is path-independent.
                const budgetExhausted = yield* store
                  .context(childSessionID)
                  .pipe(Effect.map((messages) => detectBudgetExhausted({ agentSteps, messages })))
                  .pipe(Effect.catch(() => Effect.succeed(false)))
                return notifyParent(childSessionID, "completed", output, !budgetExhausted)
              })
            }
            if (result.info?.status === "error") {
              return notifyParent(childSessionID, "error", result.info.error ?? "Subagent failed.")
            }
            if (result.info?.status === "cancelled") {
              return Effect.gen(function* () {
                const prior =
                  registryOpt._tag === "Some"
                    ? yield* registryOpt.value.get(childSessionID)
                    : undefined
                if (registryOpt._tag === "Some") {
                  yield* registryOpt.value.cancel(childSessionID).pipe(Effect.ignore)
                }
                // A user-facing job cancel must stop the child's drain too; the
                // loss-detector path already interrupted, so this is a no-op there.
                if (Option.isSome(executionOpt)) {
                  yield* executionOpt.value.interrupt(childSessionID).pipe(Effect.ignore)
                }
                // A loss-detector cancellation already notified the parent and
                // marked the registry terminal: do not notify a second time.
                // Already terminal (e.g. HeartbeatLost notified): still close edge/guard.
                if (prior && prior.status !== "pending" && prior.status !== "active") {
                  const parentID = prior.parentSessionID
                  yield* releaseParentResources(parentID, childSessionID)
                  const parent = yield* store.get(parentID)
                  if (parent) {
                    yield* WorktreeEngine.discard({
                      projectRoot: parent.location.directory,
                      id: String(childSessionID),
                    }).pipe(Effect.ignore)
                  }
                  return
                }
                return yield* notifyParent(childSessionID, "error", "Subagent was cancelled.")
              })
            }
            return Effect.void
          }),
          Effect.tap(() =>
            Effect.logInfo("TaskHost.observeBackground forked", { childSessionID: String(childSessionID) }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        ),
        ),
      )

    // 30s progress poll while waiting. touchHeartbeat only refreshes lastProgressAt
    // when turn/tool/token counters grow — keep-alive alone must not hide stalls.
    const heartbeatLoop = (childSessionID: SessionSchema.ID): Effect.Effect<never> =>
      Effect.repeat(
        Effect.gen(function* () {
          if (registryOpt._tag === "None") return
          const msgs = yield* store.context(childSessionID).pipe(
            Effect.catch(() => Effect.succeed([] as SessionMessage.Message[])),
          )
          const assistants = msgs.filter((m): m is SessionMessage.Assistant => m.type === "assistant")
          yield* registryOpt.value
            .touchHeartbeat(childSessionID, {
              turnCount: assistants.length,
              toolCallCount: assistants.flatMap((m) => m.content).filter((p) => p.type === "tool").length,
              tokensUsed: assistants.reduce(
                (sum, m) => sum + (m.tokens ? m.tokens.input + m.tokens.output + m.tokens.reasoning : 0),
                0,
              ),
            })
            .pipe(Effect.ignore)
        }),
        Schedule.spaced(Duration.seconds(30)),
      ).pipe(Effect.andThen(Effect.never))

    return TaskTool.HostService.of({
      run: (input) =>
        Effect.gen(function* () {
          // SessionExecution + Agent are available on the session drain fiber.
          const executionOpt = yield* Effect.serviceOption(SessionExecution.Service)
          const agentsOpt = yield* Effect.serviceOption(Agent.Service)
          if (Option.isNone(executionOpt) || Option.isNone(agentsOpt)) {
            return yield* Effect.die(
              new Error("Task host requires SessionExecution and Agent (run from a session drain)"),
            )
          }
          const execution = executionOpt.value
          const agents = agentsOpt.value

          const agentInfo = yield* agents.resolve(input.subagentType)
          if (!agentInfo) {
            const available = (yield* agents.all())
              .filter((a) => !a.hidden && a.mode === "subagent")
              .map((a) => a.id)
            const hint = available.length ? ` Available: ${available.join(", ")}` : ""
            return yield* Effect.die(new Error(`Unknown subagent_type "${input.subagentType}".${hint}`))
          }

          const parentID = SessionSchema.ID.make(String(input.parentSessionID))
          const parent = yield* store.get(parentID)
          if (!parent) return yield* Effect.die(new Error(`Parent session not found: ${parentID}`))
          const parentPermission = (yield* store.sessionPermission(parentID).pipe(Effect.orDie)) ?? []

          // Permission gate (same as core Task tool) — HTTP auto-spawn must not bypass.
          if (permissionOpt._tag === "Some") {
            const asserted = yield* permissionOpt.value
              .assert({
                action: "task",
                resources: [input.subagentType],
                save: [input.subagentType],
                sessionID: parentID,
                agent: parent.agent,
                source: {
                  type: "tool",
                  messageID: String(input.assistantMessageID),
                  callID: input.toolCallID,
                },
              })
              .pipe(Effect.exit)
            if (asserted._tag === "Failure") {
              return yield* Effect.die(new Error(`Permission denied: task (${input.subagentType})`))
            }
          } else {
            const rules = parentPermission
            if (Permission.evaluate("task", input.subagentType, rules).effect === "deny") {
              return yield* Effect.die(new Error(`Permission denied: task (${input.subagentType})`))
            }
          }

          // Concurrency gates (same-type + hard cap) — shared choke for tool + auto-spawn.
          if (registryOpt._tag === "Some") {
            const registry = registryOpt.value
            const active = yield* registry.activeCount
            const byType = yield* registry.activeCountByType(input.subagentType)
            if (byType >= TaskTool.CONCURRENCY_SAME_TYPE_CAP) {
              return yield* Effect.die(
                new Error(
                  `Too many active "${input.subagentType}" subagents (${byType}, max ${TaskTool.CONCURRENCY_SAME_TYPE_CAP}). Wait for one to finish or use another type.`,
                ),
              )
            }
            if (active >= TaskTool.CONCURRENCY_HARD_CAP) {
              return yield* Effect.die(
                new Error(
                  `Too many active subagents (${active}). Solve the task yourself or wait for some to finish.`,
                ),
              )
            }
          }

          // Active agent guard (parent session budget) — released when child terminates.
          let agentGuard: IterationBudget.AgentGuard | undefined
          if (runtimeOpt._tag === "Some") {
            const parentRt = yield* runtimeOpt.value.getOrCreate(parentID)
            const guardExit = yield* parentRt.budget.acquireAgentGuard.pipe(Effect.exit)
            if (guardExit._tag === "Failure") {
              return yield* Effect.die(
                new Error(
                  `Too many active agents under parent (active cap). Wait for a subagent to finish.`,
                ),
              )
            }
            agentGuard = guardExit.value
          }

          // InstanceState (used by the background job registry) dies without
          // InstanceRef; construct one from the parent session's location so
          // the job's fiber — forked outside the tool execution context —
          // still resolves the instance it belongs to.
          const { InstanceRef, WorkspaceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
          const instanceCtx =
            (yield* InstanceRef) ??
            (yield* Effect.gen(function* () {
              const resolved = yield* projects.resolve(parent.location.directory)
              return {
                directory: parent.location.directory,
                worktree: resolved.directory,
                project: { id: resolved.id, directory: resolved.directory },
              }
            }).pipe(Effect.orDie))
          yield* Effect.logInfo("TaskHost.instanceCtx", {
            hasInstanceCtx: instanceCtx !== undefined,
            directory: parent.location.directory,
          }).pipe(Effect.ignore)

          let depth = 0
          let ancestor = parent
          while (ancestor.parentID) {
            depth++
            if (depth >= MAX_SUBAGENT_DEPTH) {
              return yield* Effect.die(
                new Error(`Subagent depth limit reached (${MAX_SUBAGENT_DEPTH}). Solve the task yourself.`),
              )
            }
            if (depth >= ANCESTOR_TRACE_CAP) break
            const next = yield* store.get(ancestor.parentID)
            if (!next) break
            ancestor = next
          }

          let childID: SessionSchema.ID
          if (input.taskID) {
            childID = SessionSchema.ID.make(input.taskID)
            const existing = yield* store.get(childID)
            if (!existing) return yield* Effect.die(new Error(`Task session not found: ${childID}`))
            const priorPersona =
              personaStoreOpt._tag === "Some"
                ? yield* personaStoreOpt.value.get(childID)
                : undefined
            const identity = validateResumeIdentity({
              child: existing,
              parentSessionID: parentID,
              subagentType: input.subagentType,
              requestedPersona: input.persona,
              priorPersonaName: priorPersona?.personaName,
              priorFingerprint: priorPersona?.fingerprint,
            })
            if (!identity.ok) {
              if (agentGuard) yield* agentGuard.release
              return yield* Effect.die(new Error(`Cannot resume task session ${childID}: ${identity.reason}`))
            }
            // A still-running job owns the only wait/heartbeat channel for this
            // child. Do not start a second observer — return running status so the
            // parent model waits for the existing completion notification.
            const runningGet =
              instanceCtx === undefined
                ? background.get(String(childID))
                : background
                    .get(String(childID))
                    .pipe(Effect.provideService(InstanceRef, instanceCtx))
                    .pipe(Effect.provideService(WorkspaceRef, undefined))
            const running = yield* runningGet
            if (running?.status === "running") {
              return {
                title: input.description,
                task_id: String(childID),
                sessionID: String(childID),
                background: true,
                structured: { exit: "running" as const, resumeFrom: String(childID) },
                output: [
                  "The subagent is still running in the background. You will be notified when it finishes.",
                  `task_id: ${childID}`,
                  "Do not relaunch this task_id until you receive a completion notification (or cancel it first).",
                ].join("\n"),
              }
            }
          } else {
            const sessionID = SessionSchema.ID.create()
            const project = yield* projects.resolve(parent.location.directory)
            yield* db
              .insert(ProjectTable)
              .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            const now = Date.now()
            const agentID = Agent.ID.make(String(agentInfo.id))
            let childDirectory = resolveChildDirectory({
              projectDirectory: project.directory,
              parentDirectory: parent.location.directory,
              requestedCwd: input.cwd,
              agentWorkspace: agentInfo.workspace,
            })
            let worktreeId: string | undefined
            if (input.isolation === "worktree") {
              const wt = yield* WorktreeEngine.acquire({ projectRoot: project.directory, id: String(sessionID) }).pipe(
                Effect.result,
              )
              if (wt._tag === "Failure") {
                if (agentGuard) yield* agentGuard.release
                return yield* Effect.die(wt.failure)
              }
              childDirectory = wt.value.dir
              worktreeId = String(sessionID)
            }

            // Persona resolve + store (workspace then user config layers)
            const userConfigDirectory =
              process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config", "opencode")
            const catalog = yield* PersonaLoader.loadCatalog({
              projectDirectory: project.directory,
              userConfigDirectory,
            }).pipe(Effect.catch(() => Effect.succeed(new Map())))
            const agentPersona = (agentInfo as { persona?: string }).persona
            const effective = yield* PersonaResolve.resolve({
              taskPersona: input.persona,
              agentDefaultPersona: agentPersona,
              catalog,
              readFile: (p) => PersonaLoader.safeReadInstructionsFile(project.directory, p),
            })
            if (personaStoreOpt._tag === "Some") {
              yield* personaStoreOpt.value.put(sessionID, effective)
            }
            // Capability: persona may only tighten agent ceiling (never widen).
            const capability = tightenCapability(
              agentInfo.capability as "read-only" | "read-write" | "execute" | "all" | undefined,
              effective.capabilityTighten,
            )
            const info = SessionWire.SessionInfo.make({
              id: sessionID,
              slug: slug.create(),
              version: InstallationVersion,
              projectID: project.id,
              directory: childDirectory,
              path: path.relative(project.directory, childDirectory).replaceAll("\\", "/"),
              workspaceID: parent.location.workspaceID
                ? Workspace.ID.make(parent.location.workspaceID)
                : undefined,
              parentID,
              title: `${input.description} (@${agentInfo.id} subagent)`,
              agent: agentID,
              model: parent.model
                ? {
                    id: Model.ID.make(parent.model.id),
                    providerID: parent.model.providerID,
                    variant: parent.model.variant,
                  }
                : undefined,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
              permission: deriveSubagentPermission({
                parentPermissions: parentPermission,
                subagent: agentInfo,
                capability,
              }),
              metadata: { sandboxProfile: parent.sandboxProfile ?? "off" },
            })
            yield* events
              .publish(SessionWire.Event.Created, { sessionID, info }, { location: parent.location })
              .pipe(
                Effect.catchDefect((defect) => {
                  if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) return Effect.die(defect)
                  return Effect.void
                }),
              )
            childID = sessionID
          }

          // Running task part must carry sessionId as soon as the child exists
          // (TUI / parent-cancel follow the child from metadata, not from settle).
          yield* events
            .publish(SessionEvent.Tool.Progress, {
              sessionID: parentID,
              assistantMessageID: SessionMessage.ID.make(input.assistantMessageID),
              timestamp: yield* DateTime.now,
              callID: input.toolCallID,
              structured: {
                title: input.description,
                description: input.description,
                sessionId: String(childID),
                parentSessionId: String(parentID),
              },
              content: [],
            })
            .pipe(Effect.ignore)

          if (registryOpt._tag === "Some") {
            yield* registryOpt.value
              .register({
                parentSessionID: parentID,
                childSessionID: childID,
                subagentType: input.subagentType,
                address: `/root/${input.subagentType}/${childID}`,
              })
              .pipe(Effect.ignore)
            yield* registryOpt.value.transition(childID, "active").pipe(Effect.ignore)
          }
          // SpawnEdge Open on parent runtime
          if (runtimeOpt._tag === "Some" && !input.taskID) {
            const parentRt = yield* runtimeOpt.value.getOrCreate(parentID)
            const edge = yield* SpawnEdge.make(String(parentID), String(childID))
            parentRt.spawnEdges.set(String(childID), edge)
          }
          // Stash guard on parent runtime (released in notifyParent / foreground settle).
          if (agentGuard && runtimeOpt._tag === "Some") {
            const parentRt = yield* runtimeOpt.value.getOrCreate(parentID)
            parentRt.agentGuards.set(String(childID), agentGuard)
          }
          yield* events
            .publish(SessionEvent.Subagent.Started, {
              timestamp: yield* DateTime.now,
              sessionID: parentID,
              childSessionID: String(childID),
              subagentType: input.subagentType,
              parentSessionID: String(parentID),
            })
            .pipe(Effect.ignore)
          yield* Hooks.fire({
            event: "SubagentStart",
            sessionID: String(parentID),
            toolName: input.subagentType,
          }).pipe(Effect.ignore)

          const waitForCompletion = (
            targetChildID: SessionSchema.ID,
            timeoutMs = 30 * 60 * 1_000,
            after?: number,
          ) =>
            Effect.gen(function* () {
              yield* Effect.logInfo("TaskHost.waitForCompletion start", {
                childSessionID: String(targetChildID),
                after: after ?? null,
              })
              // Heartbeat ticker keeps the registry's loss detector happy while
              // store.wait polls internally (30s tick vs 90s loss threshold).
              // `after` (admit timestamp) makes resume paths skip prior turns.
              const wait = store.wait(targetChildID, timeoutMs, after)
              const withHeartbeat =
                registryOpt._tag === "Some"
                  ? Effect.race(wait, heartbeatLoop(targetChildID))
                  : wait
              const settled = yield* withHeartbeat.pipe(Effect.orDie)
              if (Array.isArray(settled) && registryOpt._tag === "Some") {
                const assistants = settled.filter((m): m is SessionMessage.Assistant => m.type === "assistant")
                yield* registryOpt.value
                  .touchHeartbeat(targetChildID, {
                    turnCount: assistants.length,
                    toolCallCount: assistants.flatMap((m) => m.content).filter((p) => p.type === "tool").length,
                    tokensUsed: assistants.reduce(
                      (sum, m) => sum + (m.tokens ? m.tokens.input + m.tokens.output + m.tokens.reasoning : 0),
                      0,
                    ),
                  })
                  .pipe(Effect.ignore)
              }
              return settled
            })

          const admitPrompt = (targetChildID: SessionSchema.ID) =>
            Effect.gen(function* () {
              // Seq-safe structured fork: optional single synthetic parent-trace admit
              // before the user task (one extra row, no multi-message index risk).
              if (input.forkMode !== undefined && input.forkMode !== "PromptOnly") {
                const parentMessages = yield* store.context(parentID).pipe(Effect.orDie)
                const structured = projectParentMessagesForInsert(parentMessages, input.forkMode)
                if (structured) {
                  yield* SessionInput.admit(db, events, {
                    id: SessionMessage.ID.create(),
                    sessionID: targetChildID,
                    prompt: Prompt.make({ text: structured }),
                    delivery: "steer",
                  })
                } else {
                  // Fallback: embed text projection if structured empty
                  const trace = projectParentTrace(parentMessages, input.forkMode)
                  if (trace) {
                    yield* SessionInput.admit(db, events, {
                      id: SessionMessage.ID.create(),
                      sessionID: targetChildID,
                      prompt: Prompt.make({ text: `Parent trace:\n---\n${trace}` }),
                      delivery: "steer",
                    })
                  }
                }
              }
              const messageID = SessionMessage.ID.create()
              const admitStamp = Date.now()
              yield* SessionInput.admit(db, events, {
                id: messageID,
                sessionID: targetChildID,
                prompt: Prompt.make({ text: input.prompt }),
                delivery: "steer",
              })
              // Advisory wake only: resume() joins the drain and blocks until the
              // child completes, which would turn background spawns synchronous and
              // make the foreground wait budget unreachable.
              yield* execution.wake(targetChildID)
              return admitStamp
            })

          // Genuine failures (error/interrupt/defect) must reach BackgroundJob so
          // it settles as "error"/"cancelled" and observeBackground reports the
          // failure to the parent — catching the cause here would turn a failed
          // child into a successful "completed" notification.
          const waitOnly = (targetChildID: SessionSchema.ID, after?: number) =>
            Effect.logInfo("TaskHost.waitOnly invoked", { childSessionID: String(targetChildID) }).pipe(
              Effect.andThen(
                waitForCompletion(targetChildID, undefined, after).pipe(
                  Effect.tap(() =>
                    Effect.logInfo("TaskHost.waitOnly settled", { childSessionID: String(targetChildID) }),
                  ),
                  Effect.flatMap((msgs) => {
                    if (!msgs) {
                      return Effect.fail(
                        new Error(
                          "Subagent did not settle within the background wait budget (30 minutes); it may still be running.",
                        ),
                      )
                    }
                    const failed = lastAssistantError(msgs)
                    if (failed) return Effect.fail(new Error(`Subagent failed: ${failed}`))
                    const text = lastAssistantText(msgs)
                    return Effect.succeed(text === "" ? "Subagent completed with no text output." : text)
                  }),
                ),
              ),
            )

          const launchBackground = (after: number) => {
            const start = background.start({
              id: childID,
              type: "task",
              title: input.description,
              metadata: {
                parentSessionId: String(parentID),
                sessionId: String(childID),
              },
              run:
                instanceCtx === undefined
                  ? waitOnly(childID, after)
                  : waitOnly(childID, after)
                      .pipe(Effect.provideService(InstanceRef, instanceCtx))
                      .pipe(Effect.provideService(WorkspaceRef, undefined)),
            })
            if (instanceCtx === undefined) return start
            return start
              .pipe(Effect.provideService(InstanceRef, instanceCtx))
              .pipe(Effect.provideService(WorkspaceRef, undefined))
              .pipe(
                Effect.tap(() =>
                  Effect.logInfo("TaskHost.background started", { childSessionID: String(childID) }),
                ),
                Effect.tapError((error) =>
                  Effect.logError("TaskHost.background start failed", { childSessionID: String(childID), error }),
                ),
              )
          }

          const interruptChild = Effect.gen(function* () {
            const cancelJob =
              instanceCtx === undefined
                ? background.cancel(String(childID))
                : background
                    .cancel(String(childID))
                    .pipe(Effect.provideService(InstanceRef, instanceCtx))
                    .pipe(Effect.provideService(WorkspaceRef, undefined))
            yield* cancelJob.pipe(Effect.ignore)
            yield* execution.interrupt(childID).pipe(Effect.ignore)
            if (registryOpt._tag === "Some") {
              yield* registryOpt.value.cancel(childID).pipe(Effect.ignore)
            }
          })

          const settleChild = Effect.gen(function* () {
          if (input.background) {
            const admitStamp = yield* admitPrompt(childID).pipe(Effect.orDie)
            yield* launchBackground(admitStamp)
            const observer = observeBackground(childID, agentInfo.steps)
            yield* instanceCtx === undefined
              ? observer
              : observer
                  .pipe(Effect.provideService(InstanceRef, instanceCtx))
                  .pipe(Effect.provideService(WorkspaceRef, undefined))
            return {
              title: input.description,
              task_id: String(childID),
              sessionID: String(childID),
              background: true,
              structured: { exit: "running", resumeFrom: String(childID) },
              output: [
                "The task is working in the background. You will be notified automatically when it finishes.",
                "DO NOT sleep, poll, or duplicate this task's work.",
                `task_id: ${childID}`,
              ].join("\n"),
            }
          }

          // Foreground wait budget: 2min. On expiry waitForCompletion returns
          // undefined and the child is promoted to background (wait-only run —
          // the prompt was already admitted, so `after` resumes from admit and
          // a prior completed turn on resume paths is skipped).
          const admitStamp = yield* admitPrompt(childID).pipe(Effect.orDie)
          const msgs = yield* waitForCompletion(childID, FOREGROUND_WAIT_BUDGET_MS, admitStamp).pipe(Effect.orDie)
          if (!msgs) {
            yield* launchBackground(admitStamp)
            const observer = observeBackground(childID, agentInfo.steps)
            yield* instanceCtx === undefined
              ? observer
              : observer
                  .pipe(Effect.provideService(InstanceRef, instanceCtx))
                  .pipe(Effect.provideService(WorkspaceRef, undefined))
            return {
              title: input.description,
              task_id: String(childID),
              sessionID: String(childID),
              background: true,
              structured: { exit: "running", resumeFrom: String(childID) },
              output: [
                "The subagent is still running. It was moved to the background — you will be notified when it finishes.",
                `task_id: ${childID}`,
              ].join("\n"),
            }
          }
          const budgetExhausted = yield* Effect.sync(() =>
            detectBudgetExhausted({ agentSteps: agentInfo.steps, messages: msgs }),
          )
          const text = lastAssistantText(msgs)
          const failed = lastAssistantError(msgs)
          const exit: "completed" | "failed" | "budget_exhausted" = budgetExhausted
            ? "budget_exhausted"
            : failed
              ? "failed"
              : "completed"
          const record =
            registryOpt._tag === "Some" ? yield* registryOpt.value.get(childID) : undefined
          if (registryOpt._tag === "Some") {
            yield* registryOpt.value
              .transition(childID, exit === "failed" ? "failed" : "completed", {
                ...(failed ? { error: failed } : {}),
                resumeFrom: String(childID),
              })
              .pipe(Effect.ignore)
          }
          // Foreground dual-publish: SessionEvent.Subagent.* + EventBus (same as notifyParent).
          yield* events
            .publish(
              exit === "failed" ? SessionEvent.Subagent.Failed : SessionEvent.Subagent.Completed,
              {
                timestamp: yield* DateTime.now,
                sessionID: parentID,
                childSessionID: String(childID),
                subagentType: input.subagentType,
                ...(exit === "failed"
                  ? { error: failed ?? "failed", resumeFrom: String(childID) }
                  : { output: text, resumeFrom: String(childID) }),
              },
              { location: parent.location },
            )
            .pipe(Effect.ignore)
          yield* bridgeParentLoop(parentID, childID, exit !== "failed", failed)
          // Additive memory observation: no-op when memory services aren't loaded.
          const delegationOpt = yield* Effect.serviceOption(MemoryDelegation.Service)
          if (delegationOpt._tag === "Some") {
            yield* delegationOpt.value
              .record({
                parentSessionID: String(parentID),
                childSessionID: String(childID),
                task: input.prompt,
                result: failed ?? text,
                ok: exit === "completed",
              })
              .pipe(Effect.ignore)
          }
          // Do not auto-discard on complete: parent merges via the worktree tool.

          const assistants = msgs.filter((m): m is SessionMessage.Assistant => m.type === "assistant")
          const turns = record?.turnCount ?? assistants.length
          const usage = {
            input: assistants.reduce((sum, m) => sum + (m.tokens?.input ?? 0), 0),
            output: assistants.reduce((sum, m) => sum + (m.tokens?.output ?? 0), 0),
            cost: assistants.reduce((sum, m) => sum + (m.cost ?? 0), 0),
          }

          return {
            title: input.description,
            task_id: String(childID),
            sessionID: String(childID),
            background: false,
            worktreeId,
            structured: {
              exit,
              turns,
              usage,
              ...(failed ? { error: failed } : {}),
              resumeFrom: String(childID),
            },
            output: failed ? `Subagent failed: ${failed}` : text || "Subagent completed with no text output.",
          }
          })
          return yield* settleChild.pipe(Effect.onInterrupt(() => interruptChild))
        }),
    })
  }),
)

// Slug helper — avoid import ambiguity
const slug = { create: () => Slug.create() }

export const lspHostNode = makeGlobalNode({
  service: LspTool.HostService,
  layer: lspHostLayer,
  deps: [LSP.node],
})

export const taskHostNode = makeGlobalNode({
  service: TaskTool.HostService,
  layer: taskHostLayer,
  deps: [
    BackgroundJob.node,
    SessionStore.node,
    CoreEvent.node,
    Database.node,
    Project.node,
    SubagentRegistry.node,
    SessionRuntime.node,
    PersonaStore.node,
  ],
})

const bashHostLayer = Layer.effect(
  BashTool.HostService,
  Effect.gen(function* () {
    const pluginOpt = yield* Effect.serviceOption(Plugin.Service)
    return BashTool.HostService.of({
      env: Effect.fn("BashTool.host.env")(function* (input) {
        if (Option.isNone(pluginOpt)) return {}
        const extra = yield* pluginOpt.value.trigger(
          "shell.env",
          { cwd: input.cwd, sessionID: input.sessionID, callID: input.callID },
          { env: {} as Record<string, string> },
        )
        return extra.env
      }),
    })
  }),
)

export const bashHostNode = makeGlobalNode({
  service: BashTool.HostService,
  layer: bashHostLayer,
  deps: [],
})

const definitionHookLayer = Layer.effect(
  ToolRegistry.DefinitionHookService,
  Effect.gen(function* () {
    const pluginOpt = yield* Effect.serviceOption(Plugin.Service)
    return ToolRegistry.DefinitionHookService.of({
      rewrite: Effect.fn("ToolDefinitionHook.rewrite")(function* (input) {
        const output = {
          description: input.description,
          parameters: input.parameters,
        }
        if (Option.isNone(pluginOpt)) return output
        yield* pluginOpt.value.trigger("tool.definition", { toolID: input.toolID }, output)
        return output
      }),
    })
  }),
)

export const definitionHookNode = makeGlobalNode({
  service: ToolRegistry.DefinitionHookService,
  layer: definitionHookLayer,
  deps: [],
})

const chatHookLayer = Layer.effect(
  PluginHooks.ChatService,
  Effect.gen(function* () {
    const pluginOpt = yield* Effect.serviceOption(Plugin.Service)
    return PluginHooks.ChatService.of({
      transformSystem: Effect.fn("PluginChatHook.transformSystem")(function* (input) {
        const output = { system: [...input.system] }
        if (Option.isNone(pluginOpt)) return output
        yield* pluginOpt.value.trigger(
          "experimental.chat.system.transform",
          { sessionID: input.sessionID, model: (input.model ?? {}) as never },
          output,
        )
        return output
      }),
      params: Effect.fn("PluginChatHook.params")(function* (input) {
        const params = {
          temperature: undefined as number | undefined,
          topP: undefined as number | undefined,
          topK: undefined as number | undefined,
          maxOutputTokens: undefined as number | undefined,
          options: {} as Record<string, unknown>,
        }
        const headersOut = { headers: {} as Record<string, string> }
        if (Option.isNone(pluginOpt)) return { ...params, headers: headersOut.headers }
        const stub = {
          sessionID: input.sessionID,
          agent: input.agent,
          model: (input.model ?? {}) as never,
          provider: {} as never,
          message: (input.message ?? { sessionID: input.sessionID }) as never,
        }
        yield* pluginOpt.value.trigger("chat.params", stub, params)
        yield* pluginOpt.value.trigger("chat.headers", stub, headersOut)
        return { ...params, headers: headersOut.headers }
      }),
    })
  }),
)

export const chatHookNode = makeGlobalNode({
  service: PluginHooks.ChatService,
  layer: chatHookLayer,
  deps: [],
})

const permissionAskHookLayer = Layer.effect(
  PluginHooks.PermissionAskService,
  Effect.gen(function* () {
    const pluginOpt = yield* Effect.serviceOption(Plugin.Service)
    return PluginHooks.PermissionAskService.of({
      intercept: Effect.fn("PluginPermissionAskHook.intercept")(function* (input) {
        const output = { effect: input.effect }
        if (Option.isNone(pluginOpt)) return output.effect
        yield* pluginOpt.value
          .trigger(
            "permission.ask",
            {
              id: input.id ?? "",
              sessionID: input.sessionID,
              action: input.action,
              resources: [...input.resources],
              save: input.save ? [...input.save] : undefined,
              metadata: input.metadata,
              source: input.source,
            } as never,
            output,
          )
          .pipe(Effect.catchCause(() => Effect.sync(() => {
            output.effect = "deny"
          })))
        return output.effect
      }),
    })
  }),
)

export const permissionAskHookNode = makeGlobalNode({
  service: PluginHooks.PermissionAskService,
  layer: permissionAskHookLayer,
  deps: [],
})

const commandHookLayer = Layer.effect(
  PluginHooks.CommandService,
  Effect.gen(function* () {
    const pluginOpt = yield* Effect.serviceOption(Plugin.Service)
    return PluginHooks.CommandService.of({
      beforeExecute: Effect.fn("PluginCommandHook.beforeExecute")(function* (input) {
        const parts: Array<{ type: string; text?: string }> = [{ type: "text", text: input.text }]
        if (Option.isSome(pluginOpt)) {
          yield* pluginOpt.value.trigger(
            "command.execute.before",
            { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
            { parts },
          )
        }
        const text = parts
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
        return { text: text.trim() || input.text }
      }),
    })
  }),
)

export const commandHookNode = makeGlobalNode({
  service: PluginHooks.CommandService,
  layer: commandHookLayer,
  deps: [],
})

const textCompleteHookLayer = Layer.effect(
  PluginHooks.TextCompleteService,
  Effect.gen(function* () {
    const pluginOpt = yield* Effect.serviceOption(Plugin.Service)
    return PluginHooks.TextCompleteService.of({
      complete: Effect.fn("PluginTextCompleteHook.complete")(function* (input) {
        const output = { text: input.text }
        if (Option.isSome(pluginOpt)) {
          yield* pluginOpt.value.trigger(
            "experimental.text.complete",
            { sessionID: input.sessionID, messageID: input.messageID, partID: input.partID },
            output,
          )
        }
        return output
      }),
    })
  }),
)

export const textCompleteHookNode = makeGlobalNode({
  service: PluginHooks.TextCompleteService,
  layer: textCompleteHookLayer,
  deps: [],
})

const compactionHookLayer = Layer.effect(
  PluginHooks.CompactionService,
  Effect.gen(function* () {
    const pluginOpt = yield* Effect.serviceOption(Plugin.Service)
    return PluginHooks.CompactionService.of({
      compacting: Effect.fn("PluginCompactionHook.compacting")(function* (input) {
        const output: { context: string[]; prompt?: string } = { context: [], prompt: undefined }
        if (Option.isSome(pluginOpt)) {
          yield* pluginOpt.value.trigger("experimental.session.compacting", { sessionID: input.sessionID }, output)
        }
        return output
      }),
      transformMessages: Effect.fn("PluginCompactionHook.transformMessages")(function* (input) {
        const output = {
          messages: input.messages.map((message) => ({
            info: { ...message.info },
            parts: message.parts.map((part) => ({ ...part })),
          })),
        }
        if (Option.isSome(pluginOpt)) {
          yield* pluginOpt.value.trigger("experimental.chat.messages.transform", {}, output)
        }
        return output
      }),
      autocontinue: Effect.fn("PluginCompactionHook.autocontinue")(function* (input) {
        const output = { enabled: true }
        if (Option.isSome(pluginOpt)) {
          yield* pluginOpt.value.trigger(
            "experimental.compaction.autocontinue",
            { sessionID: input.sessionID, agent: input.agent, overflow: input.overflow },
            output,
          )
        }
        return output
      }),
    })
  }),
)

export const compactionHookNode = makeGlobalNode({
  service: PluginHooks.CompactionService,
  layer: compactionHookLayer,
  deps: [],
})

/** Merged host bridges for the app layer (LSP, Task, bash env, optional Browser, Dynamic MCP/plugin tools). */
export const node = LayerNode.group([
  mutationEffectsNode,
  lspHostNode,
  taskHostNode,
  bashHostNode,
  definitionHookNode,
  chatHookNode,
  permissionAskHookNode,
  commandHookNode,
  textCompleteHookNode,
  compactionHookNode,
  DynamicTools.node,
  ...BrowserHostBridge.nodes,
])
