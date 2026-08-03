/**
 * Provides Host bridges so core V2 tools (lsp, task) can call opencode services
 * (LSP stack, subagent spawn) without pulling them into core.
 *
 * Task host uses V2 Session primitives (admit + wake/resume + SessionMessageTable)
 * rather than V1 SessionPrompt, so child history is projected correctly.
 */
export * as V2ToolHostBridges from "./v2-host-bridges"

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
import { Effect, Layer, Option } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { V2DynamicTools } from "./v2-dynamic-tools"
import path from "path"

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

const taskHostLayer = Layer.effect(
  TaskTool.HostService,
  Effect.gen(function* () {
    // Process-scoped services available in the app graph (no SessionV2 — avoids cycles).
    const store = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const projects = yield* ProjectV2.Service
    const background = yield* BackgroundJob.Service
    const db = database.db

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

          let childID: SessionSchema.ID
          if (input.taskID) {
            childID = SessionSchema.ID.make(input.taskID)
            const existing = yield* store.get(childID)
            if (!existing) return yield* Effect.die(new Error(`Task session not found: ${childID}`))
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
            const info = SessionV1.SessionInfo.make({
              id: sessionID,
              slug: slug.create(),
              version: InstallationVersion,
              projectID: project.id,
              directory: parent.location.directory,
              path: path.relative(project.directory, parent.location.directory).replaceAll("\\", "/"),
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

          const promptAndWait = Effect.gen(function* () {
            const messageID = SessionMessage.ID.create()
            const prompt = Prompt.make({ text: input.prompt })
            yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: childID,
              prompt,
              delivery: "steer",
            })
            yield* execution.wake(childID)
            yield* execution.resume(childID)
            return yield* store.context(childID)
          })

          if (input.background) {
            yield* background.start({
              id: childID,
              type: "task",
              title: input.description,
              metadata: {
                parentSessionId: String(parentID),
                sessionId: String(childID),
              },
              run: promptAndWait.pipe(
                Effect.map((msgs) => lastAssistantText(msgs) || "Subagent completed with no text output."),
                Effect.catchCause(() => Effect.succeed("Subagent completed with no text output.")),
              ),
            })
            return {
              title: input.description,
              task_id: String(childID),
              sessionID: String(childID),
              output: [
                "The task is working in the background. You will be notified automatically when it finishes.",
                "DO NOT sleep, poll for progress, or duplicate this task's work.",
                `task_id: ${childID}`,
              ].join("\n"),
            }
          }

          const msgs = yield* promptAndWait.pipe(Effect.orDie)
          const text = lastAssistantText(msgs)

          return {
            title: input.description,
            task_id: String(childID),
            sessionID: String(childID),
            output: text || "Subagent completed with no text output.",
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
  deps: [BackgroundJob.node, SessionStore.node, EventV2.node, Database.node, ProjectV2.node],
})

/** Merged host bridges for the app layer (LSP, Task, Dynamic MCP/plugin tools). */
export const node = LayerNode.group([lspHostNode, taskHostNode, V2DynamicTools.node])
