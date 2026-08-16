export * as SessionV2 from "./session"
export * from "./session/schema"

import { Cause, DateTime, Effect, Exit, Fiber, Layer, Option, Schema, Context, Stream } from "effect"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, sql, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptResolve } from "./session/prompt-resolve"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { MemoryFlush } from "./memory/flush"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { Shell } from "./shell"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Identifier } from "./id/id"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "./cross-spawn-spawner"
import { SessionV1 } from "./session-legacy"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { SessionRuntime } from "./session/runtime"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { SessionContextEpoch } from "./session/context-epoch"
import { PromptTapeStore } from "./session/runner/prompt-tape-store"
import { CompactionCheckpoint } from "./session/compaction-checkpoint"
import { copyPrefix, getForkedTitle } from "./session/clone-prefix"
import { Revert } from "@opencode-ai/schema/revert"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"
import { Config } from "./config"
import { ensureBackend, pinSession, resolveNewProfileName } from "./sandbox/resolve"
import { ProfileMismatch, Unavailable, Unsupported } from "./sandbox/windows"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
  /** Parent session for subagent/task children. */
  parentID?: SessionSchema.ID
  /** Optional title; defaults to "New session - <iso>" (or child prefix when parentID is set). */
  title?: string
  /** Copied onto SessionTable for HTTP/TUI; not part of SessionSchema.Info. */
  metadata?: Record<string, unknown>
  /** Pin this session to an OS sandbox profile. Resolved if omitted. */
  sandboxProfile?: string
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export { ContextSnapshotDecodeError, MessageDecodeError, NotFoundError } from "./session/error"

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact"]),
  },
) {}

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export class SessionBusyError extends Schema.TaggedErrorClass<SessionBusyError>()("SessionBusyError", {
  sessionID: SessionSchema.ID,
}) {}

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | SessionBusyError
  | Unavailable
  | Unsupported
  | ProfileMismatch

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, Unavailable | Unsupported>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError | SessionBusyError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError | SessionBusyError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    /** false = do not wake the agent loop (default true). */
    resume?: boolean
    /**
     * When resume is false, still promote pending steers so a user message is
     * projected (HTTP noReply). Default false — admit-only inbox semantics.
     */
    projectUser?: boolean
    format?: { readonly type: string; readonly schema?: Record<string, unknown> }
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly shell: (input: {
    sessionID: SessionSchema.ID
    messageID?: SessionMessage.ID
    command: string
    shell?: string
  }) => Effect.Effect<SessionMessage.Shell, NotFoundError | SessionBusyError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | SessionBusyError | SessionRunner.RunError>
  readonly uncompact: (input: {
    sessionID: SessionSchema.ID
    checkpointID?: string
  }) => Effect.Effect<boolean, NotFoundError | SessionBusyError>
  readonly wait: (
    id: SessionSchema.ID,
    after?: number,
  ) => Effect.Effect<SessionMessage.Message[] | undefined, NotFoundError | MessageDecodeError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError | ProfileMismatch>
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly fork: (input: {
    sessionID: SessionSchema.ID
    messageID?: SessionMessage.ID
  }) => Effect.Effect<SessionSchema.Info, NotFoundError | SessionBusyError>
  readonly removeMessage: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<void, NotFoundError | SessionBusyError>
  readonly removePart: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
    partID: SessionV1.PartID
  }) => Effect.Effect<void, NotFoundError | SessionBusyError>
  readonly updatePart: (
    part: SessionV1.Part,
  ) => Effect.Effect<SessionV1.Part, NotFoundError | SessionBusyError>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | SessionBusyError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const spawner = yield* ChildProcessSpawner
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const persistTapes = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const rows = PromptTapeStore.epochs(sessionID)
        if (rows.length === 0) {
          yield* SessionContextEpoch.saveTape(db, sessionID, null)
          return
        }
        const row = rows.at(-1)!
        yield* SessionContextEpoch.saveTape(db, sessionID, {
          tape: row.tape,
          lastSeq: PromptTapeStore.getLastSeq(sessionID, row.baselineSeq),
          messageSeqs: PromptTapeStore.getMessageSeqs(sessionID, row.baselineSeq),
          recall: PromptTapeStore.getRecall(sessionID, row.baselineSeq) ?? "",
        })
      })
    const dropTape = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        PromptTapeStore.clear(sessionID)
        yield* SessionContextEpoch.saveTape(db, sessionID, null)
      })

    const shells = new Map<SessionSchema.ID, { fiber: Fiber.Fiber<unknown, unknown>; aborted: boolean }>()

    const occupiedSet = Effect.gen(function* () {
      const drain = yield* execution.active
      return new Set<SessionSchema.ID>([...drain, ...shells.keys()])
    })

    const occupied = (sessionID: SessionSchema.ID) => occupiedSet.pipe(Effect.map((set) => set.has(sessionID)))

    const publishStatus = (sessionID: SessionSchema.ID, type: "busy" | "idle") =>
      events.publish(SessionStatusEvent.Status, { sessionID, status: { type } })

    const awaitShell = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const entry = shells.get(sessionID)
        if (!entry) return false
        const current = Fiber.getCurrent()
        if (current === entry.fiber) return entry.aborted
        yield* Fiber.join(entry.fiber).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.asVoid,
        )
        return entry.aborted
      })

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const defaultTitle = input.parentID
          ? `Child session - ${new Date(now).toISOString()}`
          : `New session - ${new Date(now).toISOString()}`
        let parentProfile: string | undefined
        if (input.parentID) {
          const parent = yield* store.get(input.parentID)
          if (parent) parentProfile = parent.sandboxProfile ?? "off"
        }
        const maybeConfig = yield* Effect.serviceOption(Config.Service)
        let configProfile: string | undefined
        if (Option.isSome(maybeConfig)) {
          const entries = yield* maybeConfig.value.entries()
          configProfile = Config.latest(entries, "sandbox")?.profile
        }
        const sandboxProfile = yield* Effect.tryPromise({
          try: () =>
            resolveNewProfileName({
              input: input.sandboxProfile,
              config: configProfile,
              parent: parentProfile,
              location: input.location.directory,
            }),
          catch: (cause) =>
            new Unavailable({
              profile: input.sandboxProfile ?? "off",
              backend: process.platform,
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        })
        yield* Effect.try({
          try: () => ensureBackend(sandboxProfile),
          catch: (cause) =>
            cause instanceof Unavailable || cause instanceof Unsupported
              ? cause
              : new Unavailable({
                  profile: sandboxProfile,
                  backend: process.platform,
                  reason: cause instanceof Error ? cause.message : String(cause),
                }),
        })
        if (process.platform === "win32" && sandboxProfile === "off" && !input.sandboxProfile && !process.env.OPENCODE_SANDBOX && !configProfile) {
          yield* events
            .publish(SessionEvent.Sandbox, {
              sessionID,
              profile: "off",
              reason: "unsupported",
              backend: "win32",
            })
            .pipe(Effect.ignore)
        }
        pinSession(sessionID, sandboxProfile)
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          parentID: input.parentID,
          title: input.title ?? defaultTitle,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          metadata: { ...input.metadata, sandboxProfile },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events
          .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) {
          // Title (LIKE, backward compatible) OR message content via FTS5 (W7).
          // FTS query: tokenize like memory.ftsQuery (OR terms); fall back to LIKE if FTS empty.
          const term = `%${input.search}%`
          const ftsTerms = input.search
            .toLowerCase()
            .split(/[^\p{L}\p{N}_-]+/u)
            .filter((t) => t.length >= 2)
          const ftsQuery =
            ftsTerms.length > 0
              ? ftsTerms.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ")
              : `"${input.search.replaceAll('"', "")}"`
          conditions.push(
            or(
              like(SessionTable.title, term),
              sql`exists (
                select 1 from session_message_fts f
                where f.session_id = ${SessionTable.id}
                  and session_message_fts match ${ftsQuery}
              )`,
              // LIKE fallback for installs without FTS rows or pre-trigger data.
              sql`exists (
                select 1 from session_message sm
                where sm.session_id = ${SessionTable.id}
                  and cast(sm.data as text) like ${term}
              )`,
            )!,
          )
        }
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.gen(function* () {
          const admitted = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const session = yield* result.get(input.sessionID)
              if (input.format) PromptTapeStore.setFormat(input.sessionID, input.format)
              // V1 SessionPrompt cleanup parity: hard-delete staged undo tail before a new turn.
              // Commit failures must not fail the turn (see Follow-up F2); log + continue.
              if (session.revert) {
                yield* SessionRevert.commit(session)
                  .pipe(
                    Effect.provideService(EventV2.Service, events),
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.failCause(cause)
                        : Effect.logWarning("staged revert commit failed (prompt)", { cause }).pipe(Effect.asVoid),
                    ),
                  )
              }
              const resolved = yield* PromptResolve.resolve(input.prompt).pipe(
                PromptResolve.needsFilesystem(input.prompt)
                  ? Effect.provide(locations.get(session.location))
                  : (effect) => effect,
              )
              const extraParts = resolved.parts.some(
                (part) => part.type !== "text" || part.synthetic === true || resolved.parts.length > 1,
              )
              const prompt = Prompt.make({
                text: resolved.text,
                files: resolved.files,
                agents: resolved.agents,
                ...(extraParts ? { parts: resolved.parts } : {}),
              })
              const messageID = input.id ?? SessionMessage.ID.create()
              const delivery = input.delivery ?? "steer"
              const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
              const recorded = yield* SessionInput.admit(db, events, {
                id: messageID,
                sessionID: input.sessionID,
                prompt,
                delivery,
              }).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionInput.LifecycleConflict
                    ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                    : Effect.die(defect),
                ),
              )
              if (!SessionInput.equivalent(recorded, expected))
                return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
              return recorded
            }),
          )
          if (input.resume !== false) {
            // A real user prompt may restart work after /loop abort (or timeout /
            // budget). Slash /loop itself uses resume: false, so abort sticks.
            const maybeRuntime = yield* Effect.serviceOption(SessionRuntime.Service)
            if (Option.isSome(maybeRuntime)) {
              const inst = yield* maybeRuntime.value.getOrCreate(admitted.sessionID)
              yield* inst.terminal.reset
            }
            yield* awaitShell(admitted.sessionID)
            const running = yield* execution.active
            if (running.has(admitted.sessionID)) {
              // Busy: coalesce a follow-up without joining (steer/queue tests).
              yield* execution.wake(admitted.sessionID)
            } else {
              // Idle: wait until the live drain issues the provider turn.
              yield* execution.resume(admitted.sessionID)
            }
          } else if (input.projectUser === true) {
            // HTTP noReply: project user message (Prompted) without waking the agent/LLM.
            yield* SessionInput.promoteSteers(db, events, admitted.sessionID, Number.MAX_SAFE_INTEGER)
          }
          return admitted
        }),
      ),
      shell: Effect.fn("V2Session.shell")((input) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (yield* occupied(input.sessionID)) return yield* new SessionBusyError({ sessionID: input.sessionID })
            const fiber = Fiber.getCurrent()
            if (!fiber) return yield* Effect.die("V2Session.shell: no current fiber")
            const entry = { fiber, aborted: false }
            shells.set(input.sessionID, entry)
            yield* publishStatus(input.sessionID, "busy")
            return yield* Effect.gen(function* () {
            const session = yield* result.get(input.sessionID)
            if (session.revert) {
              yield* SessionRevert.commit(session).pipe(
                Effect.provideService(EventV2.Service, events),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("staged revert commit failed (shell)", { cause }).pipe(Effect.asVoid),
                ),
              )
            }
            const started = yield* DateTime.now
            const callID = Identifier.create("tool", "ascending")
            const messageID = input.messageID ?? SessionMessage.ID.create()
            yield* events.publish(SessionEvent.Shell.Started, {
              sessionID: input.sessionID,
              timestamp: started,
              messageID,
              callID,
              command: input.command,
            })
            // Run the command synchronously, streaming output like v1 shellImpl
            // (prompt.ts shellImpl); publish Shell.Ended even on interrupt so the
            // durable projection records a completed shell message.
            const sh = Shell.preferred(input.shell) ?? "/bin/sh"
            const cwd = session.location.directory
            const args = Shell.args(sh, input.command, cwd)
            let output = ""
            let aborted = false
            let exitCode: number | undefined
            // Live progress for TUI (same cadence/window as agent bash tool).
            const SHELL_PROGRESS_EVERY_MS = 500
            const SHELL_PROGRESS_TAIL_CHARS = 32 * 1024
            let lastProgressAt = 0
            const finish = Effect.gen(function* () {
              if (aborted) output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              const ended = yield* DateTime.now
              yield* events.publish(SessionEvent.Shell.Ended, {
                sessionID: input.sessionID,
                timestamp: ended,
                callID,
                output,
                ...(exitCode === undefined ? {} : { exit: exitCode }),
              })
              return ended
            })
            const exit = yield* restore(
              Effect.scoped(
                Effect.gen(function* () {
                  // Spawn directly and accumulate the raw decoded stream (like v1
                  // shellImpl) so output keeps its newlines; AppProcess.runStream
                  // splits lines and would drop blank lines and separators.
                  const handle = yield* spawner.spawn(
                    ChildProcess.make(sh, args, {
                      cwd,
                      extendEnv: true,
                      env: { TERM: "dumb" },
                      stdin: "ignore",
                      forceKillAfter: "3 seconds",
                    }),
                  )
                  yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                    Effect.gen(function* () {
                      output += chunk
                      const now = Date.now()
                      if (now - lastProgressAt < SHELL_PROGRESS_EVERY_MS) return
                      lastProgressAt = now
                      const tail =
                        output.length > SHELL_PROGRESS_TAIL_CHARS
                          ? output.slice(-SHELL_PROGRESS_TAIL_CHARS)
                          : output
                      yield* events.publish(SessionEvent.Shell.Progress, {
                        sessionID: input.sessionID,
                        timestamp: yield* DateTime.now,
                        messageID,
                        callID,
                        output: tail,
                      })
                    }),
                  )
                  exitCode = yield* handle.exitCode
                }),
              ).pipe(Effect.orDie, Effect.exit),
            )
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
              aborted = true
              entry.aborted = true
            }
            const completed = yield* finish
            if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause))
              return yield* Effect.failCause(exit.cause)
            return SessionMessage.Shell.make({
              id: messageID,
              type: "shell",
              callID,
              command: input.command,
              output,
              ...(exitCode === undefined ? {} : { exit: exitCode }),
              time: { created: started, completed },
            })
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                shells.delete(input.sessionID)
                if (!(yield* execution.active).has(input.sessionID)) {
                  yield* publishStatus(input.sessionID, "idle")
                }
              }),
            ),
          )
        }),
      ),
      ),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        if (yield* occupied(input.sessionID)) {
          return yield* new SessionBusyError({ sessionID: input.sessionID })
        }
        yield* dropTape(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        if (yield* occupied(input.sessionID)) {
          return yield* new SessionBusyError({ sessionID: input.sessionID })
        }
        yield* dropTape(input.sessionID)
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (yield* occupied(input.sessionID)) {
          return yield* new SessionBusyError({ sessionID: input.sessionID })
        }
        // One flush cycle per compact so auto+manual cannot double-write.
        MemoryFlush.beginFlushCycle(String(input.sessionID))
        // Memory flush hook: guarded optional service; no-op when memory is not wired.
        yield* Effect.serviceOption(MemoryFlush.Service).pipe(
          Effect.flatMap((option) =>
            option._tag === "Some" ? option.value.flush(input.sessionID).pipe(Effect.catch(() => Effect.void)) : Effect.void,
          ),
          Effect.provide(locations.get(session.location)),
        )
        yield* SessionRunner.Service.use((runner) => runner.compact(input.sessionID)).pipe(
          Effect.provide(locations.get(session.location)),
        )
      }),
      uncompact: Effect.fn("V2Session.uncompact")(function* (input) {
        yield* result.get(input.sessionID)
        if (yield* occupied(input.sessionID)) {
          return yield* new SessionBusyError({ sessionID: input.sessionID })
        }
        // Restore tape + messages from checkpoint through stores directly. Do
        // not prompt: SessionV2.prompt resets the loop terminal (user_abort).
        return yield* CompactionCheckpoint.restore(String(input.sessionID), input.checkpointID)
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID, after) {
        yield* result.get(sessionID)
        return yield* store.wait(sessionID, undefined, after)
      }),
      active: occupiedSet,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        const stored = session.sandboxProfile ?? "off"
        const requested = process.env.OPENCODE_SANDBOX
        if (requested && requested !== stored) {
          return yield* new ProfileMismatch({ sessionID, stored, requested })
        }
        const shellAborted = yield* awaitShell(sessionID)
        if (shellAborted) return
        yield* execution.resume(sessionID)
      }),
      wake: Effect.fn("V2Session.wake")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.wake(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const maybeRuntime = yield* Effect.serviceOption(SessionRuntime.Service)
              if (Option.isSome(maybeRuntime)) {
                const inst = yield* maybeRuntime.value.getOrCreate(sessionID)
                yield* inst.terminal.request("user_abort")
                return
              }
              const session = yield* result.get(sessionID)
              const layer = locations.get(session.location)
              yield* Effect.gen(function* () {
                const runtime = yield* SessionRuntime.Service
                const inst = yield* runtime.getOrCreate(sessionID)
                yield* inst.terminal.request("user_abort")
              }).pipe(Effect.provide(layer))
            }).pipe(Effect.catchCause(() => Effect.void))
            const entry = shells.get(sessionID)
            if (entry) {
              entry.aborted = true
              yield* Fiber.interrupt(entry.fiber).pipe(Effect.catchCause(() => Effect.void))
            }
            yield* execution.interrupt(sessionID)
          }),
        ),
      ),
      fork: Effect.fn("V2Session.fork")(function* (input) {
        const original = yield* result.get(input.sessionID)
        if (yield* occupied(input.sessionID)) {
          return yield* new SessionBusyError({ sessionID: input.sessionID })
        }
        const row = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        const child = yield* result.create({
          location: original.location,
          title: getForkedTitle(original.title),
          agent: original.agent,
          model: original.model,
          metadata: row?.metadata ?? undefined,
          sandboxProfile: original.sandboxProfile,
        })
        yield* copyPrefix({
          db,
          events,
          from: input.sessionID,
          to: child.id,
          messageID: input.messageID,
          location: original.location,
        })
        return child
      }),
      removeMessage: Effect.fn("V2Session.removeMessage")(function* (input) {
        yield* result.get(input.sessionID)
        if (yield* occupied(input.sessionID)) {
          return yield* new SessionBusyError({ sessionID: input.sessionID })
        }
        const target = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
          .get()
          .pipe(Effect.orDie)
        const last = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, input.sessionID))
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        yield* events.publish(SessionV1.Event.MessageRemoved, {
          sessionID: input.sessionID,
          messageID: SessionV1.MessageID.make(String(input.messageID)),
        })
        if (!target || !last || target.seq < last.seq) {
          yield* dropTape(input.sessionID)
          return
        }
        PromptTapeStore.truncateToSeq(input.sessionID, target.seq - 1)
        yield* persistTapes(input.sessionID)
      }),
      removePart: Effect.fn("V2Session.removePart")(function* (input) {
        yield* result.get(input.sessionID)
        if (yield* occupied(input.sessionID)) {
          return yield* new SessionBusyError({ sessionID: input.sessionID })
        }
        yield* events.publish(SessionV1.Event.PartRemoved, {
          sessionID: input.sessionID,
          messageID: SessionV1.MessageID.make(String(input.messageID)),
          partID: input.partID,
        })
        yield* dropTape(input.sessionID)
      }),
      updatePart: Effect.fn("V2Session.updatePart")(function* (part) {
        const session = yield* result.get(part.sessionID)
        if (yield* occupied(part.sessionID)) {
          return yield* new SessionBusyError({ sessionID: part.sessionID })
        }
        yield* events.publish(
          SessionV1.Event.PartUpdated,
          { sessionID: part.sessionID, part: structuredClone(part), time: Date.now() },
          { location: session.location },
        )
        yield* dropTape(part.sessionID)
        return part
      }),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          if (yield* occupied(input.sessionID)) {
            return yield* new SessionBusyError({ sessionID: input.sessionID })
          }
          const staged = yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
          PromptTapeStore.snapshotRevert(input.sessionID)
          return staged
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
          if (PromptTapeStore.restoreRevert(sessionID)) yield* persistTapes(sessionID)
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          const boundaryID = session.revert?.messageID
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
          if (!boundaryID) {
            yield* dropTape(sessionID)
            return
          }
          const row = yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, boundaryID)))
            .get()
            .pipe(Effect.orDie)
          if (row) PromptTapeStore.truncateToSeq(sessionID, row.seq)
          else PromptTapeStore.clear(sessionID)
          yield* persistTapes(sessionID)
        }),
      },
    })

    return result
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
    CrossSpawnSpawner.node,
  ],
})
