import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionV2 } from "@opencode-ai/core/session"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { InstanceState } from "@/effect/instance-state"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { ApiNotFoundError, PermissionNotFoundError } from "../errors"
import * as SessionError from "./session-errors"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const v2Svc = yield* SessionV2.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.metadata !== undefined) {
        yield* session.setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      // One path: only the session drain is interruptible for agent work.
      yield* v2Svc.interrupt(ctx.params.sessionID)
      return true
    })

    const commandSvc = yield* Command.Service

    /** Expand a slash-command template the same way SessionPrompt.command does (args + $ARGUMENTS). */
    const expandCommandTemplate = Effect.fn("SessionHttpApi.expandCommandTemplate")(function* (input: {
      command: string
      arguments: string
    }) {
      const cmd = yield* commandSvc.get(input.command)
      if (!cmd) return undefined as string | undefined
      const argsRegex = /"[^"]+"|'[^']+'|\S+/g
      const quoteTrimRegex = /^["']|["']$/g
      const placeholderRegex = /\$\d+/g
      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)
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
      return template.trim()
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // One path: expand template → same prompt/drain entry as normal chat.
      const text = yield* expandCommandTemplate({ command: Command.Default.INIT, arguments: "" })
      if (text === undefined) return yield* new HttpApiError.BadRequest({})
      yield* switchTo(ctx.params.sessionID, {
        messageID: ctx.payload.messageID,
        model: { providerID: ctx.payload.providerID, modelID: ctx.payload.modelID },
        parts: [{ type: "text", text }],
      } as typeof PromptPayload.Type)
      const messageID = yield* Effect.try({
        try: () => SessionMessage.ID.make(ctx.payload.messageID as string),
        catch: () => new HttpApiError.BadRequest({}),
      })
      // init is a deliberate user kickoff — always steer (start/join drain).
      yield* v2Svc
        .prompt({
          sessionID: ctx.params.sessionID,
          id: messageID,
          prompt: { text },
          delivery: "steer",
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof SessionV2.NotFoundError
              ? new ApiNotFoundError({ name: "NotFoundError", data: { message: error.message } })
              : new HttpApiError.BadRequest({}),
          ),
        )
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* revertSvc.cleanup(yield* requireSession(ctx.params.sessionID))
      // V2 primary path: switch model and run one explicit compaction so the
      // runner's SessionCompaction emits a durable Compaction.Ended checkpoint
      // (summary + selection + keptFrom). No parallel summary prompt: the
      // compaction flow owns the summarization turn.
      yield* v2Svc
        .switchModel({
          sessionID: ctx.params.sessionID,
          model: { id: ctx.payload.modelID, providerID: ctx.payload.providerID },
        })
        .pipe(Effect.catch(() => Effect.void))
      yield* v2Svc
        .compact({ sessionID: ctx.params.sessionID })
        .pipe(
          Effect.mapError((error) =>
            error instanceof SessionV2.NotFoundError
              ? new ApiNotFoundError({ name: "NotFoundError", data: { message: error.message } })
              : new HttpApiError.BadRequest({}),
          ),
        )
      return true
    })

    const toV2Prompt = (payload: typeof PromptPayload.Type) =>
      Effect.gen(function* () {
        const parts = payload.parts ?? []
        const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        const files = parts.flatMap((part) =>
          part.type === "file"
            ? [{ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }]
            : [],
        )
        const agents = parts.flatMap((part) => (part.type === "agent" ? [{ name: part.name }] : []))
        const dropped = parts.filter((part) => part.type === "subtask").length
        if (dropped > 0) yield* Effect.logInfo("subtask parts dropped on v2 prompt", { count: dropped })
        return {
          text,
          ...(files.length > 0 ? { files } : {}),
          ...(agents.length > 0 ? { agents } : {}),
        } satisfies PromptInput.Prompt
      })

    const switchTo = (sessionID: SessionID, payload: typeof PromptPayload.Type) =>
      Effect.gen(function* () {
        // v2 NotFoundError is not on the HTTP prompt error channel — swallow via Exit and log.
        const got = yield* v2Svc.get(sessionID).pipe(Effect.exit)
        if (got._tag === "Failure") {
          yield* Effect.logWarning("switchTo: session get failed", { sessionID, cause: got.cause })
          return
        }
        const info = got.value
        if (payload.agent && payload.agent !== info.agent) {
          const switched = yield* v2Svc.switchAgent({ sessionID, agent: payload.agent }).pipe(Effect.exit)
          if (switched._tag === "Failure") {
            yield* Effect.logWarning("switchTo: switchAgent failed", {
              sessionID,
              agent: payload.agent,
              cause: switched.cause,
            })
          }
        }
        if (payload.model) {
          const current = info.model
          if (
            current === undefined ||
            current.providerID !== payload.model.providerID ||
            current.id !== payload.model.modelID
          ) {
            const switched = yield* v2Svc
              .switchModel({
                sessionID,
                model: { id: payload.model.modelID, providerID: payload.model.providerID },
              })
              .pipe(Effect.exit)
            if (switched._tag === "Failure") {
              yield* Effect.logWarning("switchTo: switchModel failed", {
                sessionID,
                model: payload.model,
                cause: switched.cause,
              })
            }
          }
        }
      })

    const runV2Prompt = (sessionID: SessionID, payload: typeof PromptPayload.Type) =>
      Effect.gen(function* () {
        const id =
          payload.messageID === undefined
            ? undefined
            : yield* Effect.try({
                // messageID is MessageID brand; narrow after undefined check for SessionMessage.ID.make(string)
                try: () => SessionMessage.ID.make(payload.messageID as string),
                catch: () => new HttpApiError.BadRequest({}),
              })
        const noReply = payload.noReply === true
        // Restore pre-V2 TUI queue semantics: while the agent drain is active,
        // follow-ups wait (delivery=queue) instead of defaulting to steer.
        // Idle sessions still admit as steer so the first turn starts immediately.
        // Explicit payload.delivery (when wired on PromptPayload later) would win;
        // legacy PromptPayload has no delivery field, so busy→queue is the rule.
        const active = yield* v2Svc.active
        const delivery = noReply ? "steer" : active.has(sessionID) ? "queue" : "steer"
        return yield* v2Svc
          .prompt({
            sessionID,
            ...(id ? { id } : {}),
            prompt: yield* toV2Prompt(payload),
            delivery,
            // noReply: admit + project user message, do not wake agent / run LLM
            ...(noReply ? { resume: false, projectUser: true } : {}),
          })
          .pipe(
            Effect.mapError((error) =>
              error instanceof SessionV2.NotFoundError
                ? new ApiNotFoundError({ name: "NotFoundError", data: { message: error.message } })
                : new HttpApiError.BadRequest({}),
            ),
          )
      })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* switchTo(ctx.params.sessionID, ctx.payload)
      const message = yield* runV2Prompt(ctx.params.sessionID, ctx.payload)
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* switchTo(ctx.params.sessionID, ctx.payload)
      yield* runV2Prompt(ctx.params.sessionID, ctx.payload).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
            yield* events.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // /loop is its own single path (loop-control + synthetic messages), not the agent drain.
      if (ctx.payload.command === "loop") {
        return yield* promptSvc
          .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
          .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      }
      // One path for slash commands: expand template → same prompt/drain entry as chat.
      const text = yield* expandCommandTemplate({
        command: ctx.payload.command,
        arguments: ctx.payload.arguments ?? "",
      })
      if (text === undefined) {
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.params.sessionID,
          error: new NamedError.Unknown({
            message: `Command not found: "${ctx.payload.command}"`,
          }).toObject(),
        })
        return yield* new HttpApiError.BadRequest({})
      }
      const model =
        ctx.payload.model === undefined
          ? undefined
          : (() => {
              const [providerID, ...rest] = ctx.payload.model.split("/")
              const modelID = rest.join("/")
              return providerID && modelID ? { providerID: providerID as never, modelID: modelID as never } : undefined
            })()
      yield* switchTo(ctx.params.sessionID, {
        ...(ctx.payload.messageID ? { messageID: ctx.payload.messageID } : {}),
        ...(ctx.payload.agent ? { agent: ctx.payload.agent } : {}),
        ...(model ? { model } : {}),
        parts: [{ type: "text", text }],
      } as typeof PromptPayload.Type)
      const id =
        ctx.payload.messageID === undefined
          ? undefined
          : yield* Effect.try({
              try: () => SessionMessage.ID.make(ctx.payload.messageID as string),
              catch: () => new HttpApiError.BadRequest({}),
            })
      {
        const active = yield* v2Svc.active
        const delivery = active.has(ctx.params.sessionID) ? "queue" : "steer"
        yield* v2Svc
          .prompt({
            sessionID: ctx.params.sessionID,
            ...(id ? { id } : {}),
            prompt: { text },
            delivery,
          })
          .pipe(
            Effect.mapError((error) =>
              error instanceof SessionV2.NotFoundError
                ? new ApiNotFoundError({ name: "NotFoundError", data: { message: error.message } })
                : new HttpApiError.BadRequest({}),
            ),
          )
      }
      // API contract still expects SessionV1.WithParts; return a lightweight user stub.
      const now = Date.now()
      const messageID = (ctx.payload.messageID ?? SessionMessage.ID.create()) as MessageID
      return {
        info: {
          id: messageID,
          sessionID: ctx.params.sessionID,
          role: "user" as const,
          time: { created: now },
          agent: ctx.payload.agent ?? "build",
          model: model
            ? { providerID: String(model.providerID), modelID: String(model.modelID) }
            : { providerID: "unknown", modelID: "unknown" },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID,
            sessionID: ctx.params.sessionID,
            type: "text" as const,
            text,
          },
        ],
      } as SessionV1.WithParts
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const messageID =
        ctx.payload.messageID === undefined
          ? undefined
          : yield* Effect.try({
              // messageID is the v1 MessageID brand; narrow after the undefined check
              try: () => SessionMessage.ID.make(ctx.payload.messageID as string),
              catch: () => new HttpApiError.BadRequest({}),
            })
      const ran = yield* v2Svc
        .shell({
          sessionID: ctx.params.sessionID,
          ...(messageID ? { messageID } : {}),
          command: ctx.payload.command,
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof SessionV2.SessionBusyError
              ? new Session.BusyError({ sessionID: ctx.params.sessionID })
              : new HttpApiError.BadRequest({}),
          ),
        )
      return yield* SessionError.mapBusy(Effect.succeed(ran))
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const assertNotBusy = Effect.fn("SessionHttpApi.assertNotBusy")(function* (sessionID: SessionID) {
      // One busy source: session drain (execution.active).
      const active = yield* v2Svc.active
      if (active.has(sessionID)) {
        yield* SessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID })))
      }
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* assertNotBusy(ctx.params.sessionID)
      // Publishes message.removed → projector deletes MessageTable + SessionMessageTable.
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      // Busy check is best-effort; deletePart endpoint has no SessionBusyError channel.
      yield* assertNotBusy(ctx.params.sessionID).pipe(Effect.catch(() => Effect.void))
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
