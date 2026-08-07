/**
 * Provides Host bridges so core V2 tools (lsp, task) can call opencode services
 * (LSP stack, subagent spawn) without pulling them into core.
 *
 * Task host uses V2 Session primitives (admit + wake/resume + SessionMessageTable)
 * rather than V1 SessionPrompt, so child history is projected correctly.
 */
export * as ToolHostBridges from "./tool-host-bridges"

import { LspTool } from "@opencode-ai/core/tool/lsp"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AgentV2 } from "@opencode-ai/core/agent"
import { deriveSubagentPermission, toLegacyRule, toCurrentRule } from "@opencode-ai/core/session/subagent-permissions"
import { SubagentRegistry } from "@opencode-ai/core/session/subagent-registry"
import { validateResumeIdentity } from "@opencode-ai/core/session/subagent-identity"
import { projectParentTrace } from "@opencode-ai/core/session/fork-mode"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Slug } from "@opencode-ai/core/util/slug"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { BackgroundJob } from "@/background/job"
import { LSP } from "@/lsp/lsp"
import { DateTime, Duration, Effect, Layer, Option, Schedule, Scope, Stream } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DynamicTools } from "./dynamic-tools"
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
    // Process-scoped services available in the app graph (no SessionV2 — avoids cycles).
    const store = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const projects = yield* ProjectV2.Service
    const background = yield* BackgroundJob.Service
    const registryOpt = yield* Effect.serviceOption(SubagentRegistry.Service)
    const executionOpt = yield* Effect.serviceOption(SessionExecution.Service)
    const scope = yield* Scope.Scope
    const db = database.db

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
            yield* notifyParent(childID, "error", "Subagent lost (no heartbeat). It was cancelled.")
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

    const notifyParent = (childSessionID: SessionSchema.ID, state: "completed" | "error", text: string) =>
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
        const body = [
          `<task id="${childSessionID}" state="${state}">`,
          `<${tag}>`,
          text,
          `</${tag}>`,
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
      })

    const observeBackground = (childSessionID: SessionSchema.ID) =>
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
              return notifyParent(childSessionID, "completed", result.info.output ?? "Subagent completed.")
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
                if (prior && prior.status !== "pending" && prior.status !== "active") return
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

    // 30s heartbeat while waiting; the registry loss detector only fires after
    // 90s without a beat, so any subagent running longer than that stays alive.
    // Runs forever (never) so Effect.race with store.wait keeps wait's type.
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
          // SessionExecution + AgentV2 are available on the V2 drain fiber.
          const executionOpt = yield* Effect.serviceOption(SessionExecution.Service)
          const agentsOpt = yield* Effect.serviceOption(AgentV2.Service)
          if (Option.isNone(executionOpt) || Option.isNone(agentsOpt)) {
            return yield* Effect.die(
              new Error("Task host requires SessionExecution and AgentV2 (run from a V2 session drain)"),
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
            const identity = validateResumeIdentity({
              child: existing,
              parentSessionID: parentID,
              subagentType: input.subagentType,
            })
            if (!identity.ok) {
              return yield* Effect.die(new Error(`Cannot resume task session ${childID}: ${identity.reason}`))
            }
            // A still-running job owns the only wait/heartbeat channel for this
            // child; relaunching would let the old wait settle on the old turn,
            // drop heartbeats, and get the still-working child cancelled as lost.
            const runningGet =
              instanceCtx === undefined
                ? background.get(String(childID))
                : background
                    .get(String(childID))
                    .pipe(Effect.provideService(InstanceRef, instanceCtx))
                    .pipe(Effect.provideService(WorkspaceRef, undefined))
            const running = yield* runningGet
            if (running?.status === "running") {
              return yield* Effect.die(
                new Error(
                  `Task ${childID} is still running in the background. Wait for its completion notification; do not relaunch it.`,
                ),
              )
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
            const agentID = AgentV2.ID.make(String(agentInfo.id))
            const childDirectory = resolveChildDirectory({
              projectDirectory: project.directory,
              parentDirectory: parent.location.directory,
              requestedCwd: input.cwd,
              agentWorkspace: agentInfo.workspace,
            })
            const info = SessionV1.SessionInfo.make({
              id: sessionID,
              slug: slug.create(),
              version: InstallationVersion,
              projectID: project.id,
              directory: childDirectory,
              path: path.relative(project.directory, childDirectory).replaceAll("\\", "/"),
              workspaceID: parent.location.workspaceID
                ? WorkspaceV2.ID.make(parent.location.workspaceID)
                : undefined,
              parentID,
              title: `${input.description} (@${agentInfo.id} subagent)`,
              agent: agentID,
              model: parent.model
                ? {
                    id: ModelV2.ID.make(parent.model.id),
                    providerID: parent.model.providerID,
                    variant: parent.model.variant,
                  }
                : undefined,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
              permission: deriveSubagentPermission({
                parentPermissions: parentPermission.map((rule) => toCurrentRule(rule)),
                subagent: agentInfo,
                capability: agentInfo.capability,
              }).map((rule) => toLegacyRule(rule)),
            })
            yield* events
              .publish(SessionV1.Event.Created, { sessionID, info }, { location: parent.location })
              .pipe(
                Effect.catchDefect((defect) => {
                  if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) return Effect.die(defect)
                  return Effect.void
                }),
              )
            childID = sessionID
          }

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
          yield* events
            .publish(SessionEvent.Subagent.Started, {
              timestamp: yield* DateTime.now,
              sessionID: parentID,
              childSessionID: String(childID),
              subagentType: input.subagentType,
              parentSessionID: String(parentID),
            })
            .pipe(Effect.ignore)

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
              const messageID = SessionMessage.ID.create()
              let promptText = input.prompt
              if (input.forkMode !== undefined && input.forkMode !== "PromptOnly") {
                const parentMessages = yield* store.context(parentID).pipe(Effect.orDie)
                const trace = projectParentTrace(parentMessages, input.forkMode)
                promptText = `${input.prompt}\n\nParent trace:\n---\n${trace}`
              }
              const admitStamp = Date.now()
              yield* SessionInput.admit(db, events, {
                id: messageID,
                sessionID: targetChildID,
                prompt: Prompt.make({ text: promptText }),
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

          if (input.background) {
            const admitStamp = yield* admitPrompt(childID).pipe(Effect.orDie)
            yield* launchBackground(admitStamp)
            const observer = observeBackground(childID)
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
            const observer = observeBackground(childID)
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
            structured: {
              exit,
              turns,
              usage,
              ...(failed ? { error: failed } : {}),
              resumeFrom: String(childID),
            },
            output: failed ? `Subagent failed: ${failed}` : text || "Subagent completed with no text output.",
          }
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
    EventV2.node,
    Database.node,
    ProjectV2.node,
    SubagentRegistry.node,
  ],
})

/** Merged host bridges for the app layer (LSP, Task, Dynamic MCP/plugin tools). */
export const node = LayerNode.group([lspHostNode, taskHostNode, DynamicTools.node])
