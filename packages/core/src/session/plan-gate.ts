export * as PlanGate from "./plan-gate"

import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { classify } from "../exec-policy/parse"
import { reduce } from "../exec-policy/peel"
import { Global } from "../global"
import { Location } from "../location"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

export class Denied extends Schema.TaggedErrorClass<Denied>()("PlanGate.Denied", {
  sessionID: Schema.String,
  kind: Schema.Literals(["fs", "bash"]),
  detail: Schema.String,
}) {
  override get message() {
    return `Plan mode blocked ${this.kind}: ${this.detail}`
  }
}

const isMdUnder = (absPath: string, root: string) => {
  const resolved = path.resolve(absPath)
  const base = path.resolve(root)
  const prefix = base.endsWith(path.sep) ? base : base + path.sep
  if (resolved !== base && !resolved.startsWith(prefix)) return false
  return resolved.endsWith(".md")
}

export const isPlanPath = (absPath: string, locationDir: string) => {
  const workspacePlans = path.join(locationDir, ".opencode", "plans")
  const globalPlans = path.join(Global.Path.data, "plans")
  return isMdUnder(absPath, workspacePlans) || isMdUnder(absPath, globalPlans)
}

const basename = (token: string) => path.basename(token.replace(/\\/g, "/"))

const segmentAllowed = (argv: string[], locationDir: string) => {
  const bin = basename(argv[0] ?? "")
  if (bin === "ls" || bin === "pwd") return true
  if (bin === "rg") return true
  if (bin === "git") return argv[1] === "status" || argv[1] === "diff"
  if (bin === "cat") {
    const files = argv.slice(1).filter((token) => !token.startsWith("-") || token === "-")
    return files.length > 0 && files.every((file) => isPlanPath(path.resolve(locationDir, file), locationDir))
  }
  return false
}

export type AssertInput = {
  readonly sessionID: string
  readonly kind: "fs" | "bash"
  readonly paths?: readonly string[]
  readonly command?: string
  readonly shell?: string
}

export interface Interface {
  readonly assertMutation: (input: AssertInput) => Effect.Effect<void, Denied>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PlanGate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const dbOpt = yield* Effect.serviceOption(Database.Service)

    const planMode = (sessionID: string) =>
      Effect.gen(function* () {
        if (Option.isNone(dbOpt)) return false
        const row = yield* dbOpt.value.db
          .select({ plan_mode: SessionTable.plan_mode })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
          .get()
          .pipe(Effect.orDie)
        return row?.plan_mode === 1
      })

    return Service.of({
      assertMutation: (input) =>
        Effect.gen(function* () {
          if (!(yield* planMode(input.sessionID))) return
          if (input.kind === "fs") {
            const blocked = (input.paths ?? []).find((item) => !isPlanPath(item, location.directory))
            if (blocked)
              return yield* new Denied({ sessionID: input.sessionID, kind: "fs", detail: blocked })
            return
          }
          const classified = yield* Effect.promise(() => classify(input.command ?? "", input.shell ?? "bash"))
          const reduced = yield* Effect.promise(() =>
            reduce(classified, { classify, depth: 0, source: input.command ?? "" }),
          )
          if (reduced.tag !== "segments" || !reduced.segments.every((segment) => segmentAllowed(segment, location.directory))) {
            return yield* new Denied({
              sessionID: input.sessionID,
              kind: "bash",
              detail: input.command ?? "",
            })
          }
          const redirects = reduced.redirects ?? []
          const blockedRedirect = redirects.find(
            (target) => !isPlanPath(path.resolve(location.directory, target), location.directory),
          )
          if (blockedRedirect) {
            return yield* new Denied({
              sessionID: input.sessionID,
              kind: "bash",
              detail: input.command ?? "",
            })
          }
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, Database.node],
})

export const assertMutation = (input: AssertInput) =>
  Effect.serviceOption(Service).pipe(
    Effect.flatMap((opt) => (Option.isSome(opt) ? opt.value.assertMutation(input) : Effect.void)),
  )
