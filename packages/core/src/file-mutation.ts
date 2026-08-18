export * as FileMutation from "./file-mutation"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { dirname } from "path"
import { lstat } from "fs/promises"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"

export interface Target {
  readonly canonical: string
  readonly resource: string
}

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

export interface ConditionalWriteInput extends WriteInput {
  readonly expected: Uint8Array
}

export interface RemoveInput {
  readonly target: Target
}

export interface RenameInput {
  readonly from: Target
  readonly to: Target
  readonly expected?: Uint8Array
}

export class StaleContentError extends Schema.TaggedErrorClass<StaleContentError>()("FileMutation.StaleContentError", {
  path: Schema.String,
}) {}

export class TargetExistsError extends Schema.TaggedErrorClass<TargetExistsError>()("FileMutation.TargetExistsError", {
  path: Schema.String,
}) {}

export class HardlinkDenied extends Schema.TaggedErrorClass<HardlinkDenied>()("FileMutation.HardlinkDenied", {
  path: Schema.String,
  nlink: Schema.Number,
}) {
  override get message() {
    return `Refusing to write through a hard link: ${this.path}`
  }
}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  readonly diagnostics?: string
}

export interface AfterCommitInput {
  readonly path: string
  readonly existed: boolean
  readonly operation: "write" | "create" | "remove" | "rename"
  readonly from?: string
}

export interface AfterCommitResult {
  readonly diagnostics: string
}

export interface Effects {
  readonly afterCommit: (input: AfterCommitInput) => Effect.Effect<AfterCommitResult>
}

export class EffectsService extends Context.Service<EffectsService, Effects>()("@opencode/v2/FileMutation.Effects") {}

export interface RemoveResult {
  readonly operation: "remove"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface RenameResult {
  readonly operation: "rename"
  readonly from: string
  readonly to: string
  readonly resource: string
}

export interface Interface {
  /** Create without replacing an existing target. */
  readonly create: (input: WriteInput) => Effect.Effect<WriteResult, TargetExistsError | HardlinkDenied | FSUtil.Error>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, HardlinkDenied | FSUtil.Error>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (input: TextWriteInput) => Effect.Effect<WriteResult, HardlinkDenied | FSUtil.Error>
  /** Commit only if an existing target still has the expected bytes. */
  readonly writeIfUnchanged: (
    input: ConditionalWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | HardlinkDenied | FSUtil.Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<RemoveResult, FSUtil.Error>
  readonly rename: (
    input: RenameInput,
  ) => Effect.Effect<RenameResult, TargetExistsError | StaleContentError | HardlinkDenied | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileMutation") {}

/**
 * Serialize file changes by canonical target. Conditional writes compare and
 * write under the same process-local lock so cooperating OpenCode mutations do
 * not overwrite changes made from the same stale content.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const afterCommit = (input: AfterCommitInput) =>
      Effect.gen(function* () {
        const effects = yield* Effect.serviceOption(EffectsService)
        if (Option.isNone(effects)) return { diagnostics: "" }
        return yield* effects.value.afterCommit(input)
      })
    const withDiagnostics = (result: WriteResult, extra: AfterCommitResult): WriteResult =>
      extra.diagnostics ? { ...result, diagnostics: extra.diagnostics } : result
    const locks = KeyedMutex.makeUnsafe<string>()
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.canonical)(Effect.uninterruptible(effect))

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const removeResult = (target: Target, existed: boolean): RemoveResult => ({
      operation: "remove",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const assertNotHardlink = (targetPath: string) =>
      Effect.tryPromise({
        try: async () => {
          let info: Awaited<ReturnType<typeof lstat>>
          try {
            info = await lstat(targetPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return
            throw error
          }
          if (info.nlink > 1) throw new HardlinkDenied({ path: targetPath, nlink: info.nlink })
        },
        catch: (cause) => (cause instanceof HardlinkDenied ? cause : (cause as Error)),
      })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          yield* assertNotHardlink(input.target.canonical)
          const existed = yield* fs.exists(input.target.canonical)
          yield* fs.writeWithDirs(input.target.canonical, input.content)
          const extra = yield* afterCommit({
            path: input.target.canonical,
            existed,
            operation: "write",
          })
          return withDiagnostics(writeResult(input.target, existed), extra)
        }),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          yield* assertNotHardlink(input.target.canonical)
          const next = splitBom(input.content)
          const current = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          yield* fs.writeWithDirs(
            input.target.canonical,
            joinBom(next.text, Boolean(current && hasUtf8Bom(current)) || next.bom),
          )
          const extra = yield* afterCommit({
            path: input.target.canonical,
            existed: current !== undefined,
            operation: "write",
          })
          return withDiagnostics(writeResult(input.target, current !== undefined), extra)
        }),
      ),
    )

    const create = Effect.fn("FileMutation.create")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          yield* assertNotHardlink(input.target.canonical)
          const write =
            typeof input.content === "string"
              ? fs.writeFileString(input.target.canonical, input.content, { flag: "wx" })
              : fs.writeFile(input.target.canonical, input.content, { flag: "wx" })
          yield* write.pipe(
            Effect.catchReason("PlatformError", "NotFound", () =>
              fs.ensureDir(dirname(input.target.canonical)).pipe(Effect.andThen(write)),
            ),
            Effect.catchReason("PlatformError", "AlreadyExists", () =>
              Effect.fail(new TargetExistsError({ path: input.target.canonical })),
            ),
          )
          const extra = yield* afterCommit({
            path: input.target.canonical,
            existed: false,
            operation: "create",
          })
          return withDiagnostics(writeResult(input.target, false), extra)
        }),
      ),
    )

    const writeIfUnchanged = Effect.fn("FileMutation.writeIfUnchanged")((input: ConditionalWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          yield* assertNotHardlink(input.target.canonical)
          const current = yield* fs.readFile(input.target.canonical)
          if (!sameBytes(current, input.expected)) {
            return yield* new StaleContentError({ path: input.target.canonical })
          }
          yield* typeof input.content === "string"
            ? fs.writeFileString(input.target.canonical, input.content)
            : fs.writeFile(input.target.canonical, input.content)
          const extra = yield* afterCommit({
            path: input.target.canonical,
            existed: true,
            operation: "write",
          })
          return withDiagnostics(writeResult(input.target, true), extra)
        }),
      ),
    )

    const remove = Effect.fn("FileMutation.remove")((input: RemoveInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* fs.remove(input.target.canonical).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          )
          if (existed) {
            yield* afterCommit({
              path: input.target.canonical,
              existed: true,
              operation: "remove",
            })
          }
          return removeResult(input.target, existed)
        }),
      ),
    )

    const withBothLocks =
      (from: Target, to: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        if (from.canonical === to.canonical) return withTargetLock(from)(effect)
        const [first, second] = from.canonical < to.canonical ? [from, to] : [to, from]
        return withTargetLock(first)(withTargetLock(second)(effect))
      }

    const rename = Effect.fn("FileMutation.rename")((input: RenameInput) =>
      withBothLocks(input.from, input.to)(
        Effect.gen(function* () {
          yield* assertNotHardlink(input.from.canonical)
          if (yield* fs.exists(input.to.canonical)) {
            return yield* new TargetExistsError({ path: input.to.canonical })
          }
          const current = yield* fs.readFile(input.from.canonical)
          if (input.expected && !sameBytes(current, input.expected)) {
            return yield* new StaleContentError({ path: input.from.canonical })
          }
          yield* fs.ensureDir(dirname(input.to.canonical))
          yield* fs.rename(input.from.canonical, input.to.canonical).pipe(
            Effect.catchIf(isExdev, () =>
              Effect.gen(function* () {
                yield* fs.writeFile(input.to.canonical, current, { flag: "wx" }).pipe(
                  Effect.catchReason("PlatformError", "AlreadyExists", () =>
                    Effect.fail(new TargetExistsError({ path: input.to.canonical })),
                  ),
                )
                yield* fs.remove(input.from.canonical)
              }),
            ),
          )
          yield* afterCommit({
            path: input.to.canonical,
            existed: false,
            operation: "rename",
            from: input.from.canonical,
          })
          return {
            operation: "rename" as const,
            from: input.from.canonical,
            to: input.to.canonical,
            resource: input.to.resource,
          }
        }),
      ),
    )

    return Service.of({ create, write, writeTextPreservingBom, writeIfUnchanged, remove, rename })
  }),
)

function splitBom(text: string) {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}

function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

function hasUtf8Bom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

function isExdev(error: { readonly _tag?: string; readonly reason?: { readonly _tag?: string; readonly cause?: unknown } }) {
  if (error._tag !== "PlatformError") return false
  const reason = error.reason
  if (!reason || reason._tag !== "Unknown") return false
  return Boolean(
    reason.cause &&
      typeof reason.cause === "object" &&
      "code" in reason.cause &&
      (reason.cause as { code: unknown }).code === "EXDEV",
  )
}

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node] })

