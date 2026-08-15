import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Plugin } from "../plugin"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { NamedError } from "@opencode-ai/core/util/error"
import { Shell } from "@opencode-ai/core/shell"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Image } from "@/image/image"
import { Process } from "@/util/process"
import { ToolRegistry } from "@/tool/registry"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../mcp"
import { Permission } from "../permission"
import { decodeDataUrl } from "@/util/data-url"
import { Cause, Effect, Exit, Layer, Option, Context, Schema, Types } from "effect"
import { SessionRunState } from "./run-state"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { loopCommand } from "@opencode-ai/core/session/loop-control/command"
import { SessionRuntime } from "@opencode-ai/core/session/runtime"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { GoalStore } from "@opencode-ai/core/session/loop-control/goal-store"
import { IterationBudget } from "@opencode-ai/core/session/loop-control/iteration-budget"
import { TerminalController } from "@opencode-ai/core/session/loop-control/terminal-controller"
import { TimerDaemon } from "@opencode-ai/core/session/loop-control/timer-daemon"
import { WorkerState } from "@opencode-ai/core/session/loop-control/worker-state"
import { CircuitBreaker } from "@opencode-ai/core/session/loop-control/circuit-breaker"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { PromptInput as V2PromptInput } from "@opencode-ai/schema/prompt-input"
import { TaskTool } from "@opencode-ai/core/tool/task"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

function isSyntheticShellUser(msg: SessionV1.WithParts) {
  return (
    msg.info.role === "user" &&
    msg.parts.some(
      (part) => part.type === "text" && part.text.includes("The following tool was executed by the user"),
    )
  )
}

function needsShellFollowUp(msgs: SessionV1.WithParts[]) {
  const lastUser = msgs.findLast((msg) => msg.info.role === "user")
  const lastAssistant = msgs.findLast((msg) => msg.info.role === "assistant")
  if (!lastUser || !lastAssistant || lastAssistant.info.role !== "assistant") return false
  if (!isSyntheticShellUser(lastUser) || lastAssistant.info.parentID !== lastUser.info.id) return false
  return !lastAssistant.parts.some((part) => part.type === "text" && !part.text.startsWith("$ "))
}

function shouldExitLoop(msgs: SessionV1.WithParts[]) {
  const lastUser = msgs.findLast((msg) => msg.info.role === "user")
  const lastAssistant = msgs.findLast((msg) => msg.info.role === "assistant")
  if (!lastUser || !lastAssistant || lastAssistant.info.role !== "assistant") return false
  const hasToolCalls =
    lastAssistant.parts.some(
      (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
    ) ?? false
  const unansweredUser = msgs.some(
    (msg) =>
      msg.info.role === "user" &&
      (msg.info.id > lastAssistant.info.id || msg.info.time.created > lastAssistant.info.time.created),
  )
  if (unansweredUser) return false
  // V1 shellImpl left the assistant without finish so runLoop called the LLM
  // after the command. Live drain projects Shell.Ended as finish=stop; keep
  // going until a real worker turn answers that synthetic user.
  if (needsShellFollowUp(msgs)) return false
  const answered =
    lastAssistant.info.parentID === lastUser.info.id ||
    lastUser.info.time.created <= lastAssistant.info.time.created
  return Boolean(
    lastAssistant.info.finish &&
      !["tool-calls"].includes(lastAssistant.info.finish) &&
      !hasToolCalls &&
      answered,
  )
}

/** Run a `/loop` command against one session-owned runtime bundle. */
const loopCommandForInstance = (raw: string, instance: SessionRuntime.Instance) =>
  loopCommand(raw).pipe(
    Effect.provideService(EventBus.Service, instance.eventBus),
    Effect.provideService(GoalStore.Service, instance.goalStore),
    Effect.provideService(IterationBudget.Service, instance.budget),
    Effect.provideService(TimerDaemon.Service, instance.timerDaemon),
    Effect.provideService(WorkerState.Service, instance.workerState),
    Effect.provideService(TerminalController.Service, instance.terminal),
    Effect.provideService(CircuitBreaker.Service, instance.circuitBreaker),
    Effect.map((text) => {
      if (raw.trim().split(/\s+/)[0] === "status") {
        return text.replace(/SpawnEdges : \d+ open/, `SpawnEdges : ${instance.spawnEdges.size} open`)
      }
      return text
    }),
  )

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const v2 = yield* SessionV2.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const fsys = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const eventBus = yield* EventBus.Service
    const goalStore = yield* GoalStore.Service
    const iterationBudget = yield* IterationBudget.Service
    const timerDaemon = yield* TimerDaemon.Service
    const workerState = yield* WorkerState.Service
    const terminalController = yield* TerminalController.Service
    const registry = yield* ToolRegistry.Service
    const lsp = yield* LSP.Service
    const mcp = yield* MCP.Service
    const image = yield* Image.Service
    const state = yield* SessionRunState.Service

    const busyError = (sessionID: SessionID) => new Session.BusyError({ sessionID })

    const isBusyError = (error: unknown): error is { sessionID: SessionID } =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: string })._tag === "SessionBusyError" &&
      "sessionID" in error

    const mapBusy = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
      fx.pipe(
        Effect.catch((error) =>
          isBusyError(error) ? Effect.fail(busyError(error.sessionID)) : Effect.fail(error as E),
        ),
      )

    const lastMatching = Effect.fn("SessionPrompt.lastMatching")(function* (
      sessionID: SessionID,
      predicate: (msg: SessionV1.WithParts, msgs: SessionV1.WithParts[]) => boolean,
    ) {
      for (let i = 0; i < 80; i++) {
        const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
        const found = msgs.findLast((msg) => predicate(msg, msgs))
        if (found) return found
        yield* Effect.sleep("25 millis")
      }
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const lastAssistant = msgs.findLast((msg) => msg.info.role === "assistant")
      if (lastAssistant) return lastAssistant
      const last = msgs.at(-1)
      if (!last) return yield* Effect.die("SessionPrompt: no messages")
      return last
    })

    const lastNonUser = (sessionID: SessionID, allowIncomplete = false) =>
      lastMatching(sessionID, (m, msgs) => {
        if (m.info.role !== "assistant") return false
        const last = msgs.findLast((item) => item.info.role === "assistant")
        if (!last || last.info.id !== m.info.id) return false
        const info = m.info
        if (allowIncomplete) {
          const lastUser = msgs.findLast((item) => item.info.role === "user")
          if (lastUser && info.parentID && info.parentID !== lastUser.info.id) return false
          return true
        }
        return Boolean(info.finish || info.error || info.time.completed)
      })

    const waitForSettledTools = Effect.fn("SessionPrompt.waitForSettledTools")(function* (sessionID: SessionID) {
      for (let i = 0; i < 200; i++) {
        const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
        const running = msgs.some((item) =>
          item.parts.some(
            (part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"),
          ),
        )
        if (!running) return
        yield* Effect.sleep("50 millis")
      }
    })

    const ensureAbortedAssistant = Effect.fn("SessionPrompt.ensureAbortedAssistant")(function* (sessionID: SessionID) {
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const lastUser = msgs.findLast((item) => item.info.role === "user")
      const lastAssistant = msgs.findLast((item) => item.info.role === "assistant")
      if (!lastUser || lastUser.info.role !== "user") return
      if (lastAssistant?.info.role === "assistant" && lastAssistant.info.parentID === lastUser.info.id) {
        if (!lastAssistant.info.time.completed && !lastAssistant.info.error) {
          yield* sessions.updateMessage({
            ...lastAssistant.info,
            time: { ...lastAssistant.info.time, completed: Date.now() },
            finish: lastAssistant.info.finish ?? "error",
            error: lastAssistant.info.error ?? new SessionV1.AbortedError({ message: "Provider turn interrupted" }).toObject(),
          })
        }
        return
      }
      const ctx = yield* InstanceState.context
      const model = lastUser.info.model
      const now = Date.now()
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.info.id,
        sessionID,
        mode: lastUser.info.agent ?? "build",
        agent: lastUser.info.agent ?? "build",
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: now, completed: now },
        finish: "error",
        error: new SessionV1.AbortedError({ message: "Provider turn interrupted" }).toObject(),
      })
    })

    const toV2Prompt = (input: { parts: PromptInput["parts"] }) => {
      const parts = input.parts ?? []
      const textParts = parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      const files = parts.flatMap((part) =>
        part.type === "file" ? [{ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }] : [],
      )
      const agentList = parts.flatMap((part) => (part.type === "agent" ? [{ name: part.name }] : []))
      return {
        text: textParts.filter(Boolean).join("\n"),
        ...(files.length > 0 ? { files } : {}),
        ...(agentList.length > 0 ? { agents: agentList } : {}),
      } as V2PromptInput.Prompt
    }

    const currentModel = Effect.fn("SessionPrompt.currentModel")(function* (sessionID: SessionID) {
      const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
      if (current.model) {
        return {
          providerID: current.model.providerID,
          modelID: current.model.id,
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const throwUnknownAgent = Effect.fn("SessionPrompt.throwUnknownAgent")(function* (
      sessionID: SessionID,
      agentName: string | undefined,
    ) {
      const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
      throw error
    })

    type DraftPart = Omit<SessionV1.Part, "id"> & { id?: string }

    const resolveUserParts = Effect.fn("SessionPrompt.resolveUserParts")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      agent: Agent.Info
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      parts: PromptInput["parts"]
    }) {
      const { read } = yield* registry.named()
      const execRead = (args: Parameters<typeof read.execute>[0], extra?: Record<string, unknown>) => {
        const controller = new AbortController()
        return read
          .execute(args, {
            sessionID: input.sessionID,
            abort: controller.signal,
            agent: input.agent.name,
            messageID: input.messageID,
            extra: { bypassCwdCheck: true, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          })
          .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
      }

      const resolvePart = Effect.fn("SessionPrompt.resolveUserPart")(function* (part: PromptInput["parts"][number]) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            const pieces: DraftPart[] = [
              {
                messageID: input.messageID,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit) && exit.value) {
              const items = Array.isArray(exit.value.contents) ? exit.value.contents : [exit.value.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: input.messageID,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                }
              }
            } else {
              const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : "Resource not found"
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: input.messageID,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          if (url.protocol === "data:" && part.mime === "text/plain") {
            return [
              {
                messageID: input.messageID,
                sessionID: input.sessionID,
                type: "text" as const,
                synthetic: true,
                text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
              },
              {
                messageID: input.messageID,
                sessionID: input.sessionID,
                type: "text" as const,
                synthetic: true,
                text: decodeDataUrl(part.url),
              },
              { ...part, messageID: input.messageID, sessionID: input.sessionID },
            ] satisfies DraftPart[]
          }
          if (url.protocol === "file:") {
            const filepath = fileURLToPath(part.url)
            const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime
            if (mime === "text/plain") {
              let offset: number | undefined
              let limit: number | undefined
              const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
              if (range.start != null) {
                const filePathURI = part.url.split("?")[0]
                let start = parseInt(range.start)
                let end = range.end ? parseInt(range.end) : undefined
                if (start === end) {
                  const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                  for (const symbol of symbols) {
                    let r: { start?: { line?: number }; end?: { line?: number } } | undefined
                    if ("range" in symbol) r = symbol.range as typeof r
                    else if ("location" in symbol) r = (symbol.location as { range?: typeof r }).range
                    if (r?.start?.line && r.start.line === start) {
                      start = r.start.line
                      end = r.end?.line ?? start
                      break
                    }
                  }
                }
                offset = Math.max(start, 1)
                if (end) limit = end - (offset - 1)
              }
              const args = { filePath: filepath, offset, limit }
              const pieces: DraftPart[] = [
                {
                  messageID: input.messageID,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                },
              ]
              const exit = yield* provider.getModel(input.model.providerID, input.model.modelID).pipe(
                Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                Effect.catch(() => execRead(args)),
                Effect.exit,
              )
              if (Exit.isSuccess(exit)) {
                pieces.push({
                  messageID: input.messageID,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: exit.value.output,
                })
                pieces.push({ ...part, mime, messageID: input.messageID, sessionID: input.sessionID })
              } else {
                const error = Cause.squash(exit.cause)
                const message = error instanceof Error ? error.message : String(error)
                yield* events.publish(Session.Event.Error, {
                  sessionID: input.sessionID,
                  error: new NamedError.Unknown({ message }).toObject(),
                })
                pieces.push({
                  messageID: input.messageID,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                })
              }
              return pieces
            }
            if (mime === "application/x-directory") {
              const args = { filePath: filepath }
              const exit = yield* execRead(args).pipe(Effect.exit)
              if (Exit.isFailure(exit)) {
                const error = Cause.squash(exit.cause)
                const message = error instanceof Error ? error.message : String(error)
                yield* events.publish(Session.Event.Error, {
                  sessionID: input.sessionID,
                  error: new NamedError.Unknown({ message }).toObject(),
                })
                return [
                  {
                    messageID: input.messageID,
                    sessionID: input.sessionID,
                    type: "text" as const,
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  },
                ] satisfies DraftPart[]
              }
              return [
                {
                  messageID: input.messageID,
                  sessionID: input.sessionID,
                  type: "text" as const,
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                },
                {
                  messageID: input.messageID,
                  sessionID: input.sessionID,
                  type: "text" as const,
                  synthetic: true,
                  text: exit.value.output,
                },
                { ...part, mime, messageID: input.messageID, sessionID: input.sessionID },
              ] satisfies DraftPart[]
            }
            const bytes = yield* fsys.readFile(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!bytes) {
              return [
                {
                  messageID: input.messageID,
                  sessionID: input.sessionID,
                  type: "text" as const,
                  synthetic: true,
                  text: `Read tool failed to read ${filepath} with the following error: file not found`,
                },
              ] satisfies DraftPart[]
            }
            return [
              {
                messageID: input.messageID,
                sessionID: input.sessionID,
                type: "text" as const,
                synthetic: true,
                text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
              },
              {
                messageID: input.messageID,
                sessionID: input.sessionID,
                type: "file" as const,
                url: `data:${mime};base64,` + Buffer.from(bytes).toString("base64"),
                mime,
                filename: part.filename,
                source: part.source,
              },
            ] satisfies DraftPart[]
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, input.agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: input.messageID, sessionID: input.sessionID },
            {
              messageID: input.messageID,
              sessionID: input.sessionID,
              type: "text" as const,
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ] satisfies DraftPart[]
        }

        return [{ ...part, messageID: input.messageID, sessionID: input.sessionID } as DraftPart]
      })

      const resolved = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat()),
      )
      const assigned: SessionV1.Part[] = resolved.map((part) => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })) as SessionV1.Part[]
      return yield* Effect.forEach(assigned, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )
    })

    const stampUserParts = Effect.fn("SessionPrompt.stampUserParts")(function* (
      sessionID: SessionID,
      messageID: MessageID,
      parts: SessionV1.Part[],
    ) {
      const stored = yield* lastMatching(
        sessionID,
        (m) => m.info.role === "user" && m.info.id === String(messageID),
      )
      for (const part of stored.parts) {
        yield* sessions.removePart({ sessionID, messageID: stored.info.id, partID: part.id })
      }
      for (const part of parts) {
        yield* sessions.updatePart({
          ...part,
          id: part.id ?? PartID.ascending(),
          messageID: stored.info.id,
          sessionID,
        } as SessionV1.Part)
      }
    })

    const handlePendingSubtasks = Effect.fn("SessionPrompt.handlePendingSubtasks")(function* (sessionID: SessionID) {
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const pending = MessageV2.latest(msgs).tasks.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      if (pending.length === 0) return
      const lastUser = msgs.findLast((m) => m.info.role === "user")
      if (!lastUser || lastUser.info.role !== "user") return
      const ctx = yield* InstanceState.context
      const hostOpt = yield* Effect.serviceOption(TaskTool.HostService)
      const model = lastUser.info.model

      for (const task of pending) {
        const taskAgent = yield* agents.get(task.agent)
        if (!taskAgent) {
          yield* throwUnknownAgent(sessionID, task.agent)
          return
        }
        const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: lastUser.info.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.info.model.variant,
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: task.model?.modelID ?? model.modelID,
          providerID: task.model?.providerID ?? model.providerID,
          time: { created: Date.now() },
        })
        let part: SessionV1.ToolPart = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistantMessage.id,
          sessionID,
          type: "tool",
          callID: PartID.ascending(),
          tool: TaskTool.name,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            title: task.description,
            metadata: { parentSessionId: sessionID },
            time: { start: Date.now() },
          },
        })

        if (Option.isNone(hostOpt)) {
          yield* sessions.updatePart({
            ...part,
            state: {
              status: "error",
              error: "Tool execution failed: Task host is not available",
              time: { start: part.state.time.start, end: Date.now() },
              metadata: part.state.status === "running" ? part.state.metadata : { parentSessionId: sessionID },
              input: part.state.input,
            },
          } satisfies SessionV1.ToolPart)
          assistantMessage.finish = "tool-calls"
          assistantMessage.time.completed = Date.now()
          yield* sessions.updateMessage(assistantMessage)
          continue
        }

        const result = yield* hostOpt.value
          .run({
            parentSessionID: SessionSchema.ID.make(String(sessionID)),
            description: task.description || task.agent,
            prompt: task.prompt,
            subagentType: task.agent,
            command: task.command,
            background: false,
            agent: task.agent,
            assistantMessageID: String(assistantMessage.id),
            toolCallID: String(part.callID),
          })
          .pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
              return Effect.succeed({
                _failed: true as const,
                error: Cause.squash(cause),
              })
            }),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                assistantMessage.finish = "tool-calls"
                assistantMessage.time.completed = Date.now()
                yield* sessions.updateMessage(assistantMessage)
                if (part.state.status === "running") {
                  yield* sessions.updatePart({
                    ...part,
                    state: {
                      status: "error",
                      error: "Cancelled",
                      time: { start: part.state.time.start, end: Date.now() },
                      metadata: part.state.metadata,
                      input: part.state.input,
                    },
                  } satisfies SessionV1.ToolPart)
                }
              }),
            ),
          )

        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        yield* sessions.updateMessage(assistantMessage)

        if (result && "_failed" in result) {
          const err = result.error
          const message = err instanceof Error ? err.message : String(err)
          yield* sessions.updatePart({
            ...part,
            state: {
              status: "error",
              error: `Tool execution failed: ${message}`,
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.state.status === "pending" ? undefined : part.state.metadata,
              input: part.state.input,
            },
          } satisfies SessionV1.ToolPart)
          continue
        }

        if (part.state.status === "running") {
          yield* sessions.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: { parentSessionId: sessionID, sessionId: result.sessionID },
              output: result.output,
              time: { ...part.state.time, end: Date.now() },
            },
          } satisfies SessionV1.ToolPart)
        }
      }
    })

    const switchTo = Effect.fn("SessionPrompt.switchTo")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID; variant?: string }
    }) {
      const got = yield* v2.get(input.sessionID).pipe(Effect.exit)
      if (got._tag === "Failure") return
      const info = got.value
      if (input.agent && input.agent !== info.agent) {
        yield* v2.switchAgent({ sessionID: input.sessionID, agent: input.agent }).pipe(Effect.exit)
      }
      const target = {
        id: input.model.modelID,
        providerID: input.model.providerID,
        ...(input.model.variant ? { variant: input.model.variant } : {}),
      }
      const current = info.model
      if (
        current &&
        current.providerID === target.providerID &&
        current.id === target.id &&
        (current.variant ?? undefined) === (input.model.variant ?? undefined)
      ) {
        return
      }
      yield* v2.switchModel({ sessionID: input.sessionID, model: target }).pipe(Effect.exit)
    })

    const applyTools = Effect.fn("SessionPrompt.applyTools")(function* (input: PromptInput) {
      if (!input.tools) return
      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools)) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        yield* sessions.setPermission({ sessionID: input.sessionID, permission: permissions })
      }
    })

    const messageIDOf = (id?: MessageID) =>
      Effect.sync(() => {
        if (id === undefined) return undefined as SessionMessage.ID | undefined
        try {
          return SessionMessage.ID.make(id as string)
        } catch {
          return undefined
        }
      })

    const finalizeRunningTools = Effect.fn("SessionPrompt.finalizeRunningTools")(function* (sessionID: SessionID) {
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const lastUser = msgs.findLast((item) => item.info.role === "user")
      const shellUser =
        lastUser?.info.role === "user" &&
        lastUser.parts.some(
          (part) => part.type === "text" && part.text.includes("The following tool was executed by the user"),
        )
      if (!shellUser) return
      const last = msgs.findLast((item) => item.info.role === "assistant")
      if (!last || last.info.role !== "assistant") return
      let changed = false
      for (const part of last.parts) {
        if (part.type !== "tool") continue
        if (part.tool !== "bash") continue
        if (part.state.status !== "running" && part.state.status !== "pending") continue
        const start = part.state.time.start
        const output = part.state.status === "running" ? String(part.state.metadata?.output ?? "") : ""
        const aborted = output.includes("User aborted the command")
          ? output
          : `${output}${output ? "\n\n" : ""}<metadata>\nUser aborted the command\n</metadata>`
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: part.state.status === "running" ? part.state.title : part.tool,
            metadata: {
              ...(part.state.status === "running" ? part.state.metadata : {}),
              output: aborted,
            },
            output: aborted,
            time: { start, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
        changed = true
      }
      if (changed && !last.info.time.completed) {
        yield* sessions.updateMessage({
          ...last.info,
          finish: last.info.finish ?? "stop",
          time: { ...last.info.time, completed: Date.now() },
        })
      }
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      const kids = yield* sessions.children(sessionID).pipe(Effect.catch(() => Effect.succeed([] as SessionV1.Info[])))
      for (const kid of kids) {
        yield* v2.interrupt(kid.id).pipe(Effect.catchCause(() => Effect.void))
      }
      yield* v2.interrupt(sessionID)
      yield* finalizeRunningTools(sessionID)
      for (const kid of kids) {
        yield* state.cancel(kid.id).pipe(Effect.catchCause(() => Effect.void))
      }
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const applyContentFilter = Effect.fn("SessionPrompt.applyContentFilter")(function* (
      sessionID: SessionID,
      result: SessionV1.WithParts,
    ) {
      if (result.info.role !== "assistant" || result.info.finish !== "content-filter") return result
      const error =
        result.info.error ??
        new SessionV1.ContentFilterError({
          message: "The response was blocked by the provider's content filter",
        }).toObject()
      if (!result.info.error) {
        yield* sessions.updateMessage({ ...result.info, error })
      }
      yield* events.publish(Session.Event.Error, { sessionID, error })
      return { ...result, info: { ...result.info, error } }
    })

    const drain = (sessionID: SessionID) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let idleForce = 0
          while (true) {
            const existing = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
            if (shouldExitLoop(existing)) return yield* applyContentFilter(sessionID, yield* lastNonUser(sessionID))
            const priorAssistant = existing.findLast((item) => item.info.role === "assistant")

            const outcome = yield* restore(
              Effect.gen(function* () {
                yield* handlePendingSubtasks(sessionID)
                const after = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
                if (shouldExitLoop(after)) return "done" as const
                yield* v2.resume(sessionID)
                return "resumed" as const
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause) ? Effect.succeed("interrupted" as const) : Effect.failCause(cause),
              ),
            )

            if (outcome === "interrupted") {
              yield* finalizeRunningTools(sessionID)
              yield* ensureAbortedAssistant(sessionID)
              yield* waitForSettledTools(sessionID)
              return yield* applyContentFilter(sessionID, yield* lastNonUser(sessionID, true))
            }
            if (outcome === "done") {
              return yield* applyContentFilter(sessionID, yield* lastNonUser(sessionID))
            }

            const settled = yield* lastMatching(sessionID, (m, msgs) => {
              if (m.info.role !== "assistant") return false
              const last = msgs.findLast((item) => item.info.role === "assistant")
              if (!last || last.info.id !== m.info.id) return false
              if (shouldExitLoop(msgs)) return true
              if (priorAssistant && m.info.id === priorAssistant.info.id) return false
              return Boolean(m.info.finish || m.info.error || m.info.time.completed)
            })
            const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
            if (shouldExitLoop(msgs)) return yield* applyContentFilter(sessionID, settled)
            if (
              shouldExitLoop(msgs) === false &&
              settled.info.role === "assistant" &&
              (settled.info.error || settled.info.finish === "error" || settled.info.finish === "content-filter")
            ) {
              const lastUser = msgs.findLast((item) => item.info.role === "user")
              if (!lastUser || settled.info.parentID === lastUser.info.id) {
                return yield* applyContentFilter(sessionID, settled)
              }
            }
            const lastA = msgs.findLast((item) => item.info.role === "assistant")
            if (priorAssistant && lastA && lastA.info.id === priorAssistant.info.id) {
              idleForce += 1
              if (needsShellFollowUp(msgs) && idleForce < 8) continue
              if (idleForce >= 3 && !needsShellFollowUp(msgs)) return yield* applyContentFilter(sessionID, lastA)
              if (idleForce >= 8) return yield* applyContentFilter(sessionID, lastA)
              continue
            }
            idleForce = 0
          }
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? ensureAbortedAssistant(sessionID).pipe(
                Effect.andThen(lastNonUser(sessionID, true)),
                Effect.flatMap((result) => applyContentFilter(sessionID, result)),
              )
            : Effect.failCause(cause),
        ),
      )

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      yield* Effect.logInfo("prompt", {
        "session.id": input.sessionID,
        noReply: input.noReply === true,
      })
      if (input.format) {
        yield* Effect.logWarning("SessionPrompt.prompt: format is ignored on the live drain", {
          format: input.format.type,
        })
      }
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) return yield* throwUnknownAgent(input.sessionID, agentName)

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      yield* applyTools(input)
      yield* switchTo({
        sessionID: input.sessionID,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          ...(variant ? { variant } : {}),
        },
      })

      const userMessageID = input.messageID ?? MessageID.ascending()
      const resolved = yield* resolveUserParts({
        sessionID: input.sessionID,
        messageID: userMessageID,
        agent: ag,
        model: { providerID: model.providerID, modelID: model.modelID },
        parts: input.parts,
      })

      const noReply = input.noReply === true
      const id = yield* messageIDOf(userMessageID)
      const admitted = yield* v2
        .prompt({
          sessionID: input.sessionID,
          ...(id ? { id } : {}),
          prompt: toV2Prompt({ parts: resolved }),
          delivery: "steer",
          resume: false,
          projectUser: true,
        })
        .pipe(Effect.orDie)

      yield* stampUserParts(input.sessionID, MessageID.make(String(admitted.id)), resolved)
      const stored = yield* lastMatching(
        input.sessionID,
        (m) => m.info.role === "user" && m.info.id === String(admitted.id),
      )
      if (stored.info.role === "user") {
        yield* sessions.updateMessage({
          ...stored.info,
          agent: ag.name,
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
            variant,
          },
          tools: input.tools,
          system: input.system,
          format: input.format,
        })
      }
      if (noReply) {
        return yield* lastMatching(
          input.sessionID,
          (m) => m.info.role === "user" && m.info.id === String(admitted.id),
        )
      }
      return yield* loop({ sessionID: input.sessionID })
    })

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(
      function* (input) {
        return yield* state.ensureRunning(
          input.sessionID,
          lastNonUser(input.sessionID),
          drain(input.sessionID),
        )
      },
    )

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input) {
      yield* Effect.logInfo("shell", { "session.id": input.sessionID, command: input.command })
      const ag = yield* agents.get(input.agent)
      if (ag) {
        const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
        yield* switchTo({
          sessionID: input.sessionID,
          agent: ag.name,
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(model.variant ? { variant: model.variant } : {}),
          },
        })
      }
      const id = yield* messageIDOf(input.messageID)
      const cfg = yield* config.get()
      return yield* state.startShell(
        input.sessionID,
        lastNonUser(input.sessionID),
        Effect.gen(function* () {
          yield* v2
            .prompt({
              sessionID: input.sessionID,
              prompt: { text: "The following tool was executed by the user" },
              delivery: "steer",
              resume: false,
              projectUser: true,
            })
            .pipe(Effect.catch(() => Effect.void))
          return yield* mapBusy(
            v2.shell({
              sessionID: input.sessionID,
              ...(id ? { messageID: id } : {}),
              command: input.command,
              ...(cfg.shell ? { shell: cfg.shell } : {}),
            }),
          ).pipe(
            Effect.catch((error) =>
              error instanceof Session.BusyError ? Effect.fail(error) : Effect.die(error),
            ),
            Effect.andThen(lastNonUser(input.sessionID)),
          )
        }),
      )
    })

    const dispatchLoopCommand = Effect.fn("SessionPrompt.dispatchLoopCommand")(function* (
      sessionID: SessionID,
      raw: string,
    ) {
      const maybeRuntime = yield* Effect.serviceOption(SessionRuntime.Service)
      const maybeLocations = yield* Effect.serviceOption(LocationServiceMap.Service)
      if (Option.isSome(maybeRuntime)) {
        const instance = yield* maybeRuntime.value.getOrCreate(sessionID)
        return yield* loopCommandForInstance(raw, instance)
      }
      if (Option.isSome(maybeLocations)) {
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
        const locationLayer = LocationServiceMap.Service.get({
          directory: AbsolutePath.make(session.directory),
          workspaceID: session.workspaceID,
        })
        return yield* Effect.gen(function* () {
          const maybe = yield* Effect.serviceOption(SessionRuntime.Service)
          if (Option.isNone(maybe)) return yield* Effect.fail(new Error("session runtime unavailable"))
          const instance = yield* maybe.value.getOrCreate(sessionID)
          return yield* loopCommandForInstance(raw, instance)
        }).pipe(Effect.provide(locationLayer), Effect.provideService(LocationServiceMap.Service, maybeLocations.value))
      }
      return yield* loopCommand(raw).pipe(
        Effect.provideService(EventBus.Service, eventBus),
        Effect.provideService(GoalStore.Service, goalStore),
        Effect.provideService(IterationBudget.Service, iterationBudget),
        Effect.provideService(TimerDaemon.Service, timerDaemon),
        Effect.provideService(WorkerState.Service, workerState),
        Effect.provideService(TerminalController.Service, terminalController),
      )
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })

      if (input.command === "loop") {
        const text = yield* dispatchLoopCommand(input.sessionID, input.arguments).pipe(Effect.orDie)
        const user = yield* prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          agent: input.agent,
          model: input.model ? Provider.parseModel(input.model) : undefined,
          noReply: true,
          parts: [
            {
              type: "text",
              text: `/${input.command}${input.arguments.trim() ? ` ${input.arguments.trim()}` : ""}`,
              synthetic: true,
            },
          ],
        })
        if (user.info.role !== "user") return yield* Effect.die("Expected loop command user message")
        const ctx = yield* InstanceState.context
        const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        const model = user.info.model
        const messageID = MessageID.ascending()
        const completed = Date.now()
        const part: SessionV1.TextPart = {
          id: PartID.ascending(),
          messageID,
          sessionID: input.sessionID,
          type: "text",
          text,
          synthetic: true,
        }
        const info: SessionV1.Assistant = {
          id: messageID,
          role: "assistant",
          parentID: user.info.id,
          sessionID: input.sessionID,
          mode: input.agent ?? session.agent ?? "build",
          agent: input.agent ?? session.agent ?? "build",
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
          time: { created: completed, completed },
          finish: "stop",
        }
        yield* sessions.updateMessage(info)
        yield* sessions.updatePart(part)
        return { info, parts: [part] }
      }

      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template as string)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        if (session.model) {
          return {
            providerID: session.model.providerID,
            modelID: session.model.id,
            ...(session.model.variant && session.model.variant !== "default" ? { variant: session.model.variant } : {}),
          }
        }
        const def = yield* agents.defaultInfo()
        if (def.model) return def.model
        return yield* provider.defaultModel().pipe(Effect.orDie)
      })

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : session.model
            ? { providerID: session.model.providerID, modelID: session.model.id }
            : taskModel
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionV2.node,
    Session.node,
    Agent.node,
    Provider.node,
    Provider.node,
    Plugin.node,
    Command.node,
    Config.node,
    FSUtil.node,
    EventV2Bridge.node,
    EventBus.node,
    GoalStore.node,
    IterationBudget.node,
    TimerDaemon.node,
    WorkerState.node,
    ToolRegistry.node,
    LSP.node,
    MCP.node,
    Image.node,
    TerminalController.node,
    SessionRunState.node,
  ],
})

export * as SessionPrompt from "./prompt"
