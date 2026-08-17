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
} from "./session-message-bridge"
import { findPartIndex, insertPartIndex } from "./part-order"
import { toEpochMsOr } from "../util/epoch-ms"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

/** Coerce SSE timestamps (epoch ms | ISO string | DateTime-like) to epoch ms. */
function epochMs(value: unknown, fallback = Date.now()): number {
  return toEpochMsOr(value, fallback)
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
      hooks: {
        loaded: { id: string; origin?: string; file?: string }[]
        untrusted: boolean
        lastDeny?: { hookId: string; event: string; reason: string }
      }
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
      hooks: {
        loaded: [],
        untrusted: false,
      },
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
    const toPermissionRequest = (props: {
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

    const stampFirstToken = (sessionID: string, messageID: string, timestamp: unknown) => {
      const first = epochMs(timestamp)
      const messages = store.message[sessionID] ?? []
      const match = search(messages, messageID, (m) => m.id)
      if (!match.found) return
      const current = messages[match.index]
      if (current.role !== "assistant") return
      if ((current.time as { first?: number }).first != null) return
      applyMessage({
        ...current,
        time: { ...current.time, first } as typeof current.time,
      })
    }

    /** Upsert a V1 part into the sync store (same shape as message.part.updated). */
    const applyPart = (part: Part) => {
      touchPart(part.sessionID, part.id)
      const parts = store.part[part.messageID]
      if (!parts) {
        setStore("part", part.messageID, [part])
        return
      }
      // Lookup by id must be linear: list is chronological, not id-sorted.
      // (Provider reasoning/tool ids are not ULID-time-ordered across types.)
      const existing = findPartIndex(parts, part.id)
      if (existing >= 0) {
        setStore("part", part.messageID, existing, reconcile(part))
        return
      }
      const index = insertPartIndex(parts, part)
      setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(index, 0, part)
        }),
      )
    }

    const applyPartText = (messageID: string, partID: string, sessionID: string, text: string, append = false) => {
      const parts = store.part[messageID]
      if (!parts) return false
      const index = findPartIndex(parts, partID)
      if (index < 0) return false
      touchPart(sessionID, partID)
      setStore(
        "part",
        messageID,
        produce((draft) => {
          const part = draft[index]
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
          // Drop orphan parts for messages no longer in the transcript
          const keep = new Set(infos.map((m) => m.id))
          const prev = draft.message[sessionID] ?? []
          for (const m of prev) {
            if (!keep.has(m.id)) delete draft.part[m.id]
          }
          draft.message[sessionID] = infos.slice(-100)
          for (const id of Object.keys(partMap)) {
            draft.part[id] = partMap[id]
          }
        }),
      )
    }

    /** After compaction, re-fetch transcript so pruned messages leave the UI. */
    const rehydrateAfterCompaction = async (sessionID: string) => {
      fullSyncedSessions.delete(sessionID)
      try {
        const v2 = await sdk.client.v2.session.messages({ sessionID, limit: 100 })
        const items = (v2.data?.data ?? []) as SessionMessage[]
        if (items.length > 0) {
          applySessionMessages(sessionID, items)
          fullSyncedSessions.add(sessionID)
          return
        }
      } catch {
        // fall through to V1 messages
      }
      try {
        const messages = await sdk.client.session.messages({ sessionID, limit: 100 })
        const legacyList = messages.data ?? []
        if (legacyList.length === 0) return
        setStore(
          produce((draft) => {
            const keep = new Set(legacyList.map((m) => m.info.id))
            const prev = draft.message[sessionID] ?? []
            for (const m of prev) {
              if (!keep.has(m.id)) delete draft.part[m.id]
            }
            draft.message[sessionID] = legacyList.map((m) => m.info).slice(-100)
            for (const message of legacyList) {
              draft.part[message.info.id] = message.parts
            }
          }),
        )
        fullSyncedSessions.add(sessionID)
      } catch {
        // best-effort; live compaction marker already painted
      }
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

        case "permission.v2.asked":
        case "permission.asked": {
          const raw = event.properties as {
            id: string
            sessionID: string
            action?: string
            permission?: string
            resources?: string[]
            patterns?: string[]
            save?: string[]
            always?: string[]
            metadata?: Record<string, unknown>
            source?: { type: string; messageID?: string; callID?: string }
            tool?: PermissionRequest["tool"]
          }
          const request = raw.action !== undefined ? toPermissionRequest({
            id: raw.id,
            sessionID: raw.sessionID,
            action: raw.action,
            resources: raw.resources ?? [],
            save: raw.save,
            metadata: raw.metadata,
            source: raw.source,
          }) : raw as PermissionRequest
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

        case "question.asked":
        case "question.v2.asked": {
          const request = event.properties as QuestionRequest
          upsertQuestion(request)
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
        // Child sessions are published as session.created (with parentID) at spawn time.
        // Without this case the sidebar Subagents list and ctrl+x down stay empty until a
        // later session.updated or full list refresh — App already handles created.
        case "session.created":
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

        case "session.hook": {
          const props = event.properties as {
            event?: string
            hookId?: string
            source?: string
            decision?: string
            reason?: string
          }
          if (props.source === "hooks.untrusted" || props.event === "untrusted") {
            setStore("hooks", "untrusted", true)
          }
          if (props.source === "hooks.list" && typeof props.reason === "string") {
            const ids = props.reason
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
            setStore(
              "hooks",
              "loaded",
              ids.map((id) => ({ id })),
            )
            if (props.decision !== "untrusted") setStore("hooks", "untrusted", false)
          }
          if (props.decision === "deny") {
            setStore("hooks", "lastDeny", {
              hookId: props.hookId ?? "",
              event: props.event ?? "",
              reason: props.reason ?? "",
            })
          }
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
          // Reuse chronological applyPart (not id binary-insert).
          applyPart(event.properties.part)
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const resultIndex = findPartIndex(parts, event.properties.partID)
          if (resultIndex < 0) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[resultIndex]
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
          if (!parts) break
          const resultIndex = findPartIndex(parts, event.properties.partID)
          if (resultIndex >= 0) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(resultIndex, 1)
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
        case "session.next.shell.progress": {
          const p = event.properties as {
            sessionID: string
            messageID?: string
            callID: string
            timestamp: number
            output?: string
          }
          const messages = store.message[p.sessionID] ?? []
          for (const msg of messages) {
            const parts = store.part[msg.id] ?? []
            const tool = parts.find((x) => x.type === "tool" && x.callID === p.callID)
            if (!tool || tool.type !== "tool") continue
            if (tool.state.status !== "running" && tool.state.status !== "pending") continue
            const input =
              tool.state.status !== "pending" && typeof tool.state.input === "object" && tool.state.input
                ? tool.state.input
                : {}
            applyPart({
              ...tool,
              state: {
                status: "running",
                input,
                title: "bash",
                metadata: { output: p.output ?? "" },
                time: {
                  start: "time" in tool.state ? tool.state.time.start : p.timestamp,
                },
              },
            })
            break
          }
          break
        }
        case "session.next.shell.ended": {
          const p = event.properties as {
            sessionID: string
            callID: string
            output: string
            timestamp: number
            exit?: number
          }
          const messages = store.message[p.sessionID] ?? []
          // Find assistant shell message by tool callID on parts
          for (const msg of messages) {
            const parts = store.part[msg.id] ?? []
            const tool = parts.find((x) => x.type === "tool" && x.callID === p.callID)
            if (!tool || tool.type !== "tool") continue
            const failed = typeof p.exit === "number" && p.exit !== 0
            applyPart({
              ...tool,
              state: failed
                ? {
                    status: "error",
                    input: typeof tool.state.input === "object" && tool.state.input ? tool.state.input : {},
                    error: `exit ${p.exit}`,
                    metadata: {
                      output: p.output ?? "",
                      ...(p.exit === undefined ? {} : { exit: p.exit }),
                    },
                    time: {
                      start: "time" in tool.state ? tool.state.time.start : p.timestamp,
                      end: p.timestamp,
                    },
                  }
                : {
                    status: "completed",
                    input: typeof tool.state.input === "object" && tool.state.input ? tool.state.input : {},
                    output: p.output,
                    title: "bash",
                    metadata: {
                      output: p.output ?? "",
                      ...(p.exit === undefined ? {} : { exit: p.exit }),
                    },
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
                finish: failed ? "error" : "stop",
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
          // Safety: collapse open reasoning if reasoning.ended was missed
          // (kernel done→collapsed requires time.end).
          {
            const end = epochMs(p.timestamp)
            for (const part of store.part[p.assistantMessageID] ?? []) {
              if (part.type !== "reasoning") continue
              if (part.time?.end != null) continue
              const start = epochMs(part.time?.start) || end
              applyPart({ ...part, time: { start, end } })
            }
          }
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
          {
            const end = epochMs(p.timestamp)
            for (const part of store.part[p.assistantMessageID] ?? []) {
              if (part.type !== "reasoning") continue
              if (part.time?.end != null) continue
              const start = epochMs(part.time?.start) || end
              applyPart({ ...part, time: { start, end } })
            }
          }
          break
        }
        case "session.next.text.started": {
          const p = event.properties
          stampFirstToken(p.sessionID, p.assistantMessageID, p.timestamp)
          applyPart(
            emptyTextPart({
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              textID: p.textID,
              start: epochMs(p.timestamp),
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
              time: { start: epochMs(p.timestamp) },
            })
          }
          break
        }
        case "session.next.text.ended": {
          const p = event.properties
          const partID = textPartID(p.assistantMessageID, p.textID)
          const existing = store.part[p.assistantMessageID]?.find((x) => x.id === partID)
          const start =
            existing && existing.type === "text" && existing.time?.start != null
              ? existing.time.start
              : epochMs(p.timestamp)
          if (!applyPartText(p.assistantMessageID, partID, p.sessionID, p.text, false)) {
            applyPart({
              id: partID,
              sessionID: p.sessionID,
              messageID: p.assistantMessageID,
              type: "text",
              text: p.text,
              time: { start, end: epochMs(p.timestamp) },
            })
          } else if (existing && existing.type === "text") {
            // Stamp end without clobbering streamed text body
            applyPart({
              ...existing,
              text: p.text,
              time: { start, end: epochMs(p.timestamp) },
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
          stampFirstToken(p.sessionID, p.assistantMessageID, p.timestamp)
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
            const idx = parts ? findPartIndex(parts, partID) : -1
            if (idx >= 0) {
              const part = parts![idx]
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
          stampFirstToken(p.sessionID, p.assistantMessageID, p.timestamp)
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
          const p = event.properties as {
            sessionID: string
            assistantMessageID: string
            callID: string
            timestamp: number
            /** Schema field on Tool.Called (not `name`). */
            tool?: string
            name?: string
            input?: Record<string, unknown>
          }
          const partID = toolPartID(p.assistantMessageID, p.callID)
          const existing = store.part[p.assistantMessageID]?.find((x) => x.id === partID)
          // Prefer event.tool (Called schema), then prior input.started name, never the
          // literal "tool" fallback — that breaks verb-group eagerFoldKind lookups.
          const fromEvent =
            typeof p.tool === "string" && p.tool.length > 0
              ? p.tool
              : typeof p.name === "string" && p.name.length > 0
                ? p.name
                : undefined
          const fromExisting = existing && existing.type === "tool" && existing.tool !== "tool" ? existing.tool : undefined
          const name = fromEvent ?? fromExisting ?? "tool"
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
          const p = event.properties as {
            sessionID: string
            assistantMessageID: string
            callID: string
            timestamp: number
            tool?: string
            name?: string
            content?: Array<{ type?: string; text?: string }>
            structured?: Record<string, unknown>
          }
          const partID = toolPartID(p.assistantMessageID, p.callID)
          const existing = store.part[p.assistantMessageID]?.find((x) => x.id === partID)
          const fromEvent =
            typeof p.tool === "string" && p.tool.length > 0
              ? p.tool
              : typeof p.name === "string" && p.name.length > 0
                ? p.name
                : undefined
          const fromExisting = existing && existing.type === "tool" && existing.tool !== "tool" ? existing.tool : undefined
          const name = fromEvent ?? fromExisting ?? "tool"
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
          const structured = p.structured && typeof p.structured === "object" ? p.structured : {}
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
              // Shell display reads metadata.output; keep structured if present.
              metadata: { ...structured, output },
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

        // Running-tool checkpoints: merge structured/content onto the running part
        // so long-running tools can stream output once the runner publishes progress.
        case "session.next.tool.progress": {
          const p = event.properties as {
            sessionID: string
            assistantMessageID: string
            callID: string
            timestamp: number
            structured?: Record<string, unknown>
            content?: Array<{ type?: string; text?: string }>
          }
          const partID = toolPartID(p.assistantMessageID, p.callID)
          const existing = store.part[p.assistantMessageID]?.find((x) => x.id === partID)
          if (!existing || existing.type !== "tool") break
          if (existing.state.status !== "running" && existing.state.status !== "pending") break
          const output = Array.isArray(p.content)
            ? p.content
                .map((item) => (item.type === "text" ? item.text ?? "" : ""))
                .filter(Boolean)
                .join("\n")
            : ""
          const structured =
            p.structured && typeof p.structured === "object" && !Array.isArray(p.structured)
              ? p.structured
              : {}
          const prevMeta =
            existing.state.status === "running" && "metadata" in existing.state
              ? ((existing.state as { metadata?: Record<string, unknown> }).metadata ?? {})
              : {}
          const input =
            existing.state.status !== "pending" && typeof existing.state.input === "object" && existing.state.input
              ? existing.state.input
              : {}
          applyPart({
            id: existing.id,
            sessionID: existing.sessionID,
            messageID: existing.messageID,
            type: "tool",
            tool: existing.tool,
            callID: existing.callID,
            state: {
              status: "running",
              input,
              title: existing.tool,
              metadata: output
                ? { ...prevMeta, ...structured, output }
                : { ...prevMeta, ...structured },
              time: {
                start:
                  "time" in existing.state && existing.state.time?.start != null
                    ? existing.state.time.start
                    : p.timestamp,
              },
            },
          })
          break
        }

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

        // Paint admitted inputs immediately so TUI can show QUEUED while the
        // runner has not yet promoted them (steer waits next turn; queue waits
        // agent idle). session.next.prompted re-applies the same message id
        // (idempotent) once the runner promotes.
        case "session.next.prompt.admitted": {
          const p = event.properties as {
            sessionID: string
            messageID: string
            prompt: { text: string; files?: Array<{ uri: string; name?: string; mime?: string }>; agents?: Array<{ name: string }> }
            timestamp: number
            delivery?: string
          }
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
          applyPart(
            userTextPart({
              sessionID: p.sessionID,
              messageID: p.messageID,
              text: p.text,
            }),
          )
          applyPart({
            id: `prt_${p.messageID}_compaction`,
            sessionID: p.sessionID,
            messageID: p.messageID,
            type: "compaction",
            auto: p.reason === "auto",
          })
          // Allow full rehydrate so pruned messages drop from the local store.
          fullSyncedSessions.delete(p.sessionID)
          queueMicrotask(() => {
            void rehydrateAfterCompaction(p.sessionID)
          })
          break
        }
        case "session.next.compaction.started":
        case "session.next.compaction.delta":
          // Checkpoint paints on the replayable compaction.ended boundary.
          break

        case "session.next.retried": {
          const p = event.properties as {
            sessionID: string
            attempt: number
            timestamp: number
            error?: { message?: string; isRetryable?: boolean }
          }
          // Surface supplier retries in the same status chip the prompt already renders.
          setStore("session_status", p.sessionID, {
            type: "retry",
            attempt: Math.max(0, Math.floor(p.attempt)),
            message: p.error?.message ?? "retrying",
            next: Date.now() + 3_000,
          })
          break
        }

        case "session.next.tool.failed": {
          const p = event.properties as {
            sessionID: string
            assistantMessageID: string
            callID: string
            timestamp: number
            tool?: string
            name?: string
            error?: { message?: string }
            result?: unknown
          }
          const partID = toolPartID(p.assistantMessageID, p.callID)
          const existing = store.part[p.assistantMessageID]?.find((x) => x.id === partID)
          const fromEvent =
            typeof p.tool === "string" && p.tool.length > 0
              ? p.tool
              : typeof p.name === "string" && p.name.length > 0
                ? p.name
                : undefined
          const fromExisting = existing && existing.type === "tool" && existing.tool !== "tool" ? existing.tool : undefined
          const name = fromEvent ?? fromExisting ?? "tool"
          const input =
            existing && existing.type === "tool" && existing.state.status !== "pending"
              ? existing.state.input
              : {}
          // Preserve any progress metadata accumulated while running.
          const prevMeta =
            existing &&
            existing.type === "tool" &&
            existing.state.status !== "pending" &&
            "metadata" in existing.state
              ? ((existing.state as { metadata?: Record<string, unknown> }).metadata ?? {})
              : {}
          const errMsg = p.error?.message ?? "tool error"
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
              error: errMsg,
              metadata: { ...prevMeta, error: errMsg },
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
