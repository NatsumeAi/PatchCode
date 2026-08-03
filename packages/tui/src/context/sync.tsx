import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
  SessionMessage,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"
import {
  assistantMessageFromStep,
  emptyReasoningPart,
  emptyTextPart,
  reasoningPartID,
  sessionMessageToLegacy,
  sessionMeta,
  textPartID,
  toolPartID,
  toolPartPending,
  userMessageFromPrompt,
  userTextPart,
} from "./v2-message-bridge"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

/** Coerce SSE timestamps (epoch ms | ISO string | DateTime-like) to epoch ms. */
function epochMs(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.length > 0) {
    const asNum = Number(value)
    if (Number.isFinite(asNum) && value.trim() !== "") return asNum
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (value != null && typeof value === "object") {
    const obj = value as { epochMilliseconds?: unknown }
    if (typeof obj.epochMilliseconds === "number" && Number.isFinite(obj.epochMilliseconds)) {
      return obj.epochMilliseconds
    }
  }
  return fallback
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string> }>()
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    /** Map PermissionV2.Request → PermissionRequest shape the existing prompt UI uses. */
    const fromV2Permission = (props: {
      id: string
      sessionID: string
      action: string
      resources: string[]
      save?: string[]
      metadata?: Record<string, unknown>
      source?: { type: string; messageID?: string; callID?: string }
    }): PermissionRequest => ({
      id: props.id,
      sessionID: props.sessionID,
      permission: props.action,
      patterns: props.resources ?? [],
      metadata: { ...(props.metadata ?? {}) },
      always: props.save?.length ? [...props.save] : [...(props.resources ?? [])],
      ...(props.source?.type === "tool" && props.source.messageID && props.source.callID
        ? { tool: { messageID: props.source.messageID, callID: props.source.callID } }
        : {}),
    })

    /** Map QuestionV2.Request → QuestionRequest for the existing QuestionPrompt UI. */
    const fromV2Question = (props: {
      id: string
      sessionID: string
      questions: QuestionRequest["questions"]
      tool?: QuestionRequest["tool"]
    }): QuestionRequest => ({
      id: props.id,
      sessionID: props.sessionID,
      questions: props.questions,
      ...(props.tool ? { tool: props.tool } : {}),
    })

    const upsertQuestion = (request: QuestionRequest) => {
      const requests = store.question[request.sessionID]
      if (!requests) {
        setStore("question", request.sessionID, [request])
        return
      }
      const match = search(requests, request.id, (r) => r.id)
      if (match.found) {
        setStore("question", request.sessionID, match.index, reconcile(request))
        return
      }
      setStore(
        "question",
        request.sessionID,
        produce((draft) => {
          draft.splice(match.index, 0, request)
        }),
      )
    }

    /** One reply path for auto-permission (same API as PermissionPrompt). */
    const replyPermission = (
      request: { id: string; sessionID: string },
      reply: "once" | "always" | "reject",
      directory: string,
      workspace: string | undefined,
      message?: string,
    ) => {
      return sdk.client.v2.session.permission.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        reply,
        ...(message ? { message } : {}),
      })
    }

    const upsertPermission = (request: PermissionRequest) => {
      const requests = store.permission[request.sessionID]
      if (!requests) {
        setStore("permission", request.sessionID, [request])
        return
      }
      const match = search(requests, request.id, (r) => r.id)
      if (match.found) {
        setStore("permission", request.sessionID, match.index, reconcile(request))
        return
      }
      setStore(
        "permission",
        request.sessionID,
        produce((draft) => {
          draft.splice(match.index, 0, request)
        }),
      )
    }

    const removePermission = (sessionID: string, requestID: string) => {
      const requests = store.permission[sessionID]
      if (!requests) return
      const match = search(requests, requestID, (r) => r.id)
      if (!match.found) return
      setStore(
        "permission",
        sessionID,
        produce((draft) => {
          draft.splice(match.index, 1)
        }),
      )
    }

    /** Upsert a V1 message into the sync store (same shape as message.updated). */
    const applyMessage = (info: Message) => {
      touchMessage(info.sessionID, info.id)
      const messages = store.message[info.sessionID]
      if (!messages) {
        setStore("message", info.sessionID, [info])
        return
      }
      const result = search(messages, info.id, (m) => m.id)
      if (result.found) {
        setStore("message", info.sessionID, result.index, reconcile(info))
        return
      }
      setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      const updated = store.message[info.sessionID]
      if (updated.length > 100) {
        const oldest = updated[0]
        batch(() => {
          setStore(
            "message",
            info.sessionID,
            produce((draft) => {
              draft.shift()
            }),
          )
          setStore(
            "part",
            produce((draft) => {
              delete draft[oldest.id]
            }),
          )
        })
      }
    }

    /** Upsert a V1 part into the sync store (same shape as message.part.updated). */
    const applyPart = (part: Part) => {
      touchPart(part.sessionID, part.id)
      const parts = store.part[part.messageID]
      if (!parts) {
        setStore("part", part.messageID, [part])
        return
      }
      const result = search(parts, part.id, (p) => p.id)
      if (result.found) {
        setStore("part", part.messageID, result.index, reconcile(part))
        return
      }
      setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
    }

    const applyPartText = (messageID: string, partID: string, sessionID: string, text: string, append = false) => {
      const parts = store.part[messageID]
      if (!parts) return false
      const result = search(parts, partID, (p) => p.id)
      if (!result.found) return false
      touchPart(sessionID, partID)
      setStore(
        "part",
        messageID,
        produce((draft) => {
          const part = draft[result.index]
          if (part.type !== "text" && part.type !== "reasoning") return
          part.text = append ? part.text + text : text
        }),
      )
      return true
    }

    const metaFor = (sessionID: string) => {
      const match = search(store.session, sessionID, (s) => s.id)
      return sessionMeta(match.found ? store.session[match.index] : undefined)
    }

    const lastUserMessageID = (sessionID: string) => {
      const messages = store.message[sessionID] ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
      return undefined
    }

    const applySessionMessages = (sessionID: string, items: SessionMessage[]) => {
      const meta = metaFor(sessionID)
      let parentID: string | undefined
      const infos: Message[] = []
      const partMap: Record<string, Part[]> = {}
      // API may return newest-first or oldest-first; normalize ascending by id (ulid-ish)
      const ordered = [...items].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      for (const item of ordered) {
        const legacy = sessionMessageToLegacy(sessionID, item, meta, parentID)
        if (!legacy) continue
        infos.push(legacy.info)
        partMap[legacy.info.id] = legacy.parts
        if (legacy.info.role === "user") parentID = legacy.info.id
      }
      setStore(
        produce((draft) => {
          draft.message[sessionID] = infos.slice(-100)
          for (const id of Object.keys(partMap)) {
            draft.part[id] = partMap[id]
          }
        }),
      )
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    event.subscribe((event, { directory, workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied":
        case "permission.v2.replied": {
          removePermission(event.properties.sessionID, event.properties.requestID)
          break
        }

        // Legacy event name: still upsert UI, but reply always goes through one API.
        case "permission.asked": {
          const request = event.properties as PermissionRequest
          if (permission.mode === "auto") {
            void replyPermission(request, "once", directory, workspace)
            break
          }
          upsertPermission(request)
          break
        }

        case "permission.v2.asked": {
          const raw = event.properties as {
            id: string
            sessionID: string
            action: string
            resources: string[]
            save?: string[]
            metadata?: Record<string, unknown>
            source?: { type: string; messageID?: string; callID?: string }
          }
          const request = fromV2Permission(raw)
          if (permission.mode === "auto") {
            void replyPermission(request, "once", directory, workspace)
            break
          }
          upsertPermission(request)
          break
        }

        case "question.replied":
        case "question.rejected":
        case "question.v2.replied":
        case "question.v2.rejected": {
          const props = event.properties as { sessionID: string; requestID: string }
          const requests = store.question[props.sessionID]
          if (!requests) break
          const match = search(requests, props.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            props.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties as QuestionRequest
          upsertQuestion(request)
          break
        }

        // V2 runner question tool publishes this; TUI previously only handled
        // question.asked so the prompt never appeared and the tool hung.
        case "question.v2.asked": {
          const raw = event.properties as {
            id: string
            sessionID: string
            questions: QuestionRequest["questions"]
            tool?: QuestionRequest["tool"]
          }
          upsertQuestion(fromV2Question(raw))
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          const result = search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        // --- V2 runner live bridge → V1 message/part store (TUI still renders V1) ---
        case "session.next.prompted": {
          const p = event.properties
          const meta = metaFor(p.sessionID)
          applyMessage(
            userMessageFromPrompt({
              sessionID: p.sessionID,
              messageID: p.messageID,
              text: p.prompt.text,
              timestamp: p.timestamp,
              meta,
            }),
          )
          applyPart(
            userTextPart({
              sessionID: p.sessionID,
              messageID: p.messageID,
              text: p.prompt.text,
            }),
          )
          for (const [index, file] of (p.prompt.files ?? []).entries()) {
            applyPart({
              id: `prt_${p.messageID}_file_${index}`,
              sessionID: p.sessionID,
              messageID: p.messageID,
              type: "file",
              url: file.uri,
              mime: file.mime ?? "application/octet-stream",
              filename: file.name ?? file.uri.split("/").at(-1) ?? file.uri,
            })
          }
          for (const [index, agent] of (p.prompt.agents ?? []).entries()) {
            applyPart({
              id: `prt_${p.messageID}_agent_${index}`,
              sessionID: p.sessionID,
              messageID: p.messageID,
              type: "agent",
              name: agent.name,
            })
          }
          break
        }
        case "session.next.shell.started": {
          const p = event.properties
          const meta = metaFor(p.sessionID)
          applyMessage(
            assistantMessageFromStep({
              sessionID: p.sessionID,
              messageID: p.messageID,
              agent: meta.agent,
              model: { id: meta.model.modelID, providerID: meta.model.providerID, variant: meta.model.variant },
              timestamp: p.timestamp,
              parentID: lastUserMessageID(p.sessionID),
              directory: meta.directory,
            }),
          )
          applyPart({
            id: `prt_${p.messageID}_shell`,
            sessionID: p.sessionID,
            messageID: p.messageID,
            type: "tool",
            tool: "bash",
            callID: p.callID,
            state: {
              status: "running",
              input: { command: p.command },
              time: { start: p.timestamp },
            },
          })
          break
        }
        case "session.next.shell.ended": {
          const p = event.properties
          const messages = store.message[p.sessionID] ?? []
          // Find assistant shell message by tool callID on parts
          for (const msg of messages) {
            const parts = store.part[msg.id] ?? []
            const tool = parts.find((x) => x.type === "tool" && x.callID === p.callID)
            if (!tool || tool.type !== "tool") continue
            applyPart({
              ...tool,
              state: {
                status: "completed",
                input: typeof tool.state.input === "object" && tool.state.input ? tool.state.input : {},
                output: p.output,
                title: "bash",
                metadata: {},
                time: {
                  start: "time" in tool.state ? tool.state.time.start : p.timestamp,
                  end: p.timestamp,
                },
              },
            })
            if (msg.role === "assistant") {
              applyMessage({
                ...msg,
                time: { ...msg.time, completed: p.timestamp },
                finish: "stop",
              })
            }
            break
          }
          break
        }
        case "session.next.context.updated":
        case "session.next.synthetic": {
          const p = event.properties
          const meta = metaFor(p.sessionID)
          applyMessage(
            userMessageFromPrompt({
              sessionID: p.sessionID,
              messageID: p.messageID,
              text: p.text,
              timestamp: p.timestamp,
              meta,
            }),
          )
          applyPart(
            userTextPart({
              sessionID: p.sessionID,
              messageID: p.messageID,
              text: p.text,
              synthetic: event.type === "session.next.synthetic",
            }),
          )
          break
        }
        case "session.next.step.started": {
          const p = event.properties
          const meta = metaFor(p.sessionID)
          // Complete any prior incomplete assistant so pending UI settles
          const existing = store.message[p.sessionID] ?? []
          const open = existing.findLast((m) => m.role === "assistant" && !m.time.completed)
          if (open && open.id !== p.assistantMessageID && open.role === "assistant") {
            applyMessage({
              ...open,
              time: { ...open.time, completed: p.timestamp },
            })
          }
          applyMessage(
            assistantMessageFromStep({
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              agent: p.agent,
              model: p.model,
              timestamp: p.timestamp,
              parentID: lastUserMessageID(p.sessionID),
              directory: meta.directory,
            }),
          )
          break
        }
        case "session.next.step.ended": {
          const p = event.properties
          const messages = store.message[p.sessionID] ?? []
          const match = search(messages, p.assistantMessageID, (m) => m.id)
          if (!match.found) break
          const current = messages[match.index]
          if (current.role !== "assistant") break
          applyMessage({
            ...current,
            finish: p.finish,
            cost: p.cost,
            tokens: {
              total:
                p.tokens.input + p.tokens.output + p.tokens.reasoning + p.tokens.cache.read + p.tokens.cache.write,
              input: p.tokens.input,
              output: p.tokens.output,
              reasoning: p.tokens.reasoning,
              cache: p.tokens.cache,
            },
            time: { ...current.time, completed: p.timestamp },
          })
          break
        }
        case "session.next.step.failed": {
          const p = event.properties
          const messages = store.message[p.sessionID] ?? []
          const match = search(messages, p.assistantMessageID, (m) => m.id)
          if (!match.found) break
          const current = messages[match.index]
          if (current.role !== "assistant") break
          applyMessage({
            ...current,
            finish: "error",
            error: { name: "UnknownError", data: { message: p.error?.message ?? "error" } },
            time: { ...current.time, completed: p.timestamp },
          })
          break
        }
        case "session.next.text.started": {
          const p = event.properties
          applyPart(
            emptyTextPart({
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              textID: p.textID,
            }),
          )
          break
        }
        case "session.next.text.delta": {
          const p = event.properties
          const partID = textPartID(p.assistantMessageID, p.textID)
          if (!applyPartText(p.assistantMessageID, partID, p.sessionID, p.delta, true)) {
            applyPart({
              id: partID,
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              type: "text",
              text: p.delta,
            })
          }
          break
        }
        case "session.next.text.ended": {
          const p = event.properties
          const partID = textPartID(p.assistantMessageID, p.textID)
          if (!applyPartText(p.assistantMessageID, partID, p.sessionID, p.text, false)) {
            applyPart({
              id: partID,
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              type: "text",
              text: p.text,
            })
          }
          break
        }
        case "session.next.reasoning.started": {
          const p = event.properties as {
            sessionID: string
            assistantMessageID: string
            reasoningID: string
            timestamp: unknown
          }
          applyPart(
            emptyReasoningPart({
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              reasoningID: p.reasoningID,
              start: epochMs(p.timestamp),
            }),
          )
          break
        }
        case "session.next.reasoning.delta": {
          const p = event.properties as {
            sessionID: string
            assistantMessageID: string
            reasoningID: string
            timestamp: unknown
            delta: string
          }
          const partID = reasoningPartID(p.assistantMessageID, p.reasoningID)
          const start = epochMs(p.timestamp)
          if (!applyPartText(p.assistantMessageID, partID, p.sessionID, p.delta, true)) {
            applyPart({
              id: partID,
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              type: "reasoning",
              text: p.delta,
              time: { start },
            })
          }
          break
        }
        case "session.next.reasoning.ended": {
          const p = event.properties as {
            sessionID: string
            assistantMessageID: string
            reasoningID: string
            timestamp: unknown
            text: string
          }
          const partID = reasoningPartID(p.assistantMessageID, p.reasoningID)
          const end = epochMs(p.timestamp)
          if (!applyPartText(p.assistantMessageID, partID, p.sessionID, p.text, false)) {
            applyPart({
              id: partID,
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              type: "reasoning",
              text: p.text,
              time: { start: end, end },
            })
          } else {
            // mark end time if part exists — keep original start for duration
            const parts = store.part[p.assistantMessageID]
            const result = search(parts, partID, (x) => x.id)
            if (result.found) {
              const part = parts[result.index]
              if (part.type === "reasoning") {
                const start = epochMs(part.time?.start) || end
                applyPart({
                  ...part,
                  text: p.text,
                  time: { start, end },
                })
              }
            }
          }
          break
        }
        case "session.next.tool.input.started": {
          const p = event.properties
          applyPart(
            toolPartPending({
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              callID: p.callID,
              name: p.name,
              start: p.timestamp,
            }),
          )
          break
        }
        case "session.next.tool.input.delta":
        case "session.next.tool.input.ended":
          // input streaming is not required for transcript paint; tool.called sets final input
          break
        case "session.next.tool.called": {
          const p = event.properties
          const partID = toolPartID(p.assistantMessageID, p.callID)
          const existing = store.part[p.assistantMessageID]?.find((x) => x.id === partID)
          const name = existing && existing.type === "tool" ? existing.tool : "tool"
          applyPart({
            id: partID,
            sessionID: p.sessionID,
            messageID: p.assistantMessageID,
            type: "tool",
            tool: name,
            callID: p.callID,
            state: {
              status: "running",
              input: p.input ?? {},
              time: { start: p.timestamp },
            },
          })
          break
        }
        case "session.next.tool.success": {
          const p = event.properties
          const partID = toolPartID(p.assistantMessageID, p.callID)
          const existing = store.part[p.assistantMessageID]?.find((x) => x.id === partID)
          const name = existing && existing.type === "tool" ? existing.tool : "tool"
          const input =
            existing && existing.type === "tool" && existing.state.status !== "pending"
              ? existing.state.input
              : {}
          const output = Array.isArray(p.content)
            ? p.content
                .map((item: { type?: string; text?: string }) => (item.type === "text" ? item.text ?? "" : ""))
                .filter(Boolean)
                .join("\n")
            : ""
          applyPart({
            id: partID,
            sessionID: p.sessionID,
            messageID: p.assistantMessageID,
            type: "tool",
            tool: name,
            callID: p.callID,
            state: {
              status: "completed",
              input: typeof input === "object" && input ? input : {},
              output,
              title: name,
              metadata: {},
              time: {
                start:
                  existing && existing.type === "tool" && "time" in existing.state
                    ? existing.state.time.start
                    : p.timestamp,
                end: p.timestamp,
              },
            },
          })
          break
        }

        // Running-tool state checkpoints (structured/content) carry no V1 part
        // equivalent; the settled tool.success already carries the full output.
        case "session.next.tool.progress":
          break

        case "session.next.agent.switched": {
          const p = event.properties
          const result = search(store.session, p.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.agent = p.agent
              session.time.updated = p.timestamp
            }),
          )
          break
        }
        case "session.next.model.switched": {
          const p = event.properties
          const result = search(store.session, p.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.model = {
                id: p.model.id,
                providerID: p.model.providerID,
                ...(p.model.variant === undefined ? {} : { variant: p.model.variant }),
              }
              session.time.updated = p.timestamp
            }),
          )
          break
        }

        // Admitted steers become visible on session.next.prompted; nothing to
        // paint here (admission is provisional until the runner promotes it).
        case "session.next.prompt.admitted":
          break

        case "session.next.revert.staged": {
          const p = event.properties
          const result = search(store.session, p.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.revert = p.revert
            }),
          )
          break
        }
        case "session.next.revert.cleared": {
          const p = event.properties
          const result = search(store.session, p.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.revert = undefined
            }),
          )
          break
        }
        case "session.next.revert.committed": {
          const p = event.properties
          const result = search(store.session, p.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.revert = undefined
              session.time.updated = p.timestamp
            }),
          )
          break
        }

        case "session.next.compaction.ended": {
          const p = event.properties
          const meta = metaFor(p.sessionID)
          applyMessage(
            userMessageFromPrompt({
              sessionID: p.sessionID,
              messageID: p.messageID,
              text: p.text,
              timestamp: p.timestamp,
              meta,
            }),
          )
          applyPart({
            id: `prt_${p.messageID}_compaction`,
            sessionID: p.sessionID,
            messageID: p.messageID,
            type: "compaction",
            auto: p.reason === "auto",
          })
          break
        }
        case "session.next.compaction.started":
        case "session.next.compaction.delta":
          // Checkpoint paints on the replayable compaction.ended boundary.
          break
        case "session.next.tool.failed": {
          const p = event.properties
          const partID = toolPartID(p.assistantMessageID, p.callID)
          const existing = store.part[p.assistantMessageID]?.find((x) => x.id === partID)
          const name = existing && existing.type === "tool" ? existing.tool : "tool"
          const input =
            existing && existing.type === "tool" && existing.state.status !== "pending"
              ? existing.state.input
              : {}
          applyPart({
            id: partID,
            sessionID: p.sessionID,
            messageID: p.assistantMessageID,
            type: "tool",
            tool: name,
            callID: p.callID,
            state: {
              status: "error",
              input: typeof input === "object" && input ? input : {},
              error: p.error?.message ?? "tool error",
              metadata: {},
              time: {
                start:
                  existing && existing.type === "tool" && "time" in existing.state
                    ? existing.state.time.start
                    : p.timestamp,
                end: p.timestamp,
              },
            },
          })
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]
            const sessions = responses[6]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          // If a prior sync raced empty (V2 write lag / no live message.updated),
          // allow a re-fetch so the TUI does not stay permanently blank.
          const existing = store.message[sessionID]
          if (fullSyncedSessions.has(sessionID) && existing && existing.length > 0) return
          if (fullSyncedSessions.has(sessionID)) fullSyncedSessions.delete(sessionID)
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: 100 }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
            ])
            // V1 MessageTable may be empty for V2-only history; fall back to projected
            // SessionMessage rows so reopening a session still paints the transcript.
            let legacyList = messages.data ?? []
            if (legacyList.length === 0) {
              try {
                const v2 = await sdk.client.v2.session.messages({ sessionID, limit: 100 })
                const items = (v2.data?.data ?? []) as SessionMessage[]
                if (items.length > 0) {
                  applySessionMessages(sessionID, items)
                  setStore(
                    produce((draft) => {
                      const match = search(draft.session, sessionID, (s) => s.id)
                      if (match.found) draft.session[match.index] = session.data!
                      if (!match.found) draft.session.splice(match.index, 0, session.data!)
                      draft.todo[sessionID] = todo.data ?? []
                      draft.session_diff[sessionID] = diff.data ?? []
                    }),
                  )
                  fullSyncedSessions.add(sessionID)
                  return
                }
              } catch {
                // V2 fallback is best-effort; keep the empty V1 path below.
              }
            }
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
                draft.todo[sessionID] = todo.data ?? []
                const currentMessages = draft.message[sessionID] ?? []
                const infos = legacyList.flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of legacyList) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
                draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    return result
  },
})
