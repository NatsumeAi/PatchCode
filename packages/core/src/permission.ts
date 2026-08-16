export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Option, Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { NotFoundError as SessionNotFoundError } from "./session/error"
import { SessionSchema } from "./session/schema"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { evaluate } from "./permission/evaluate"
import { PermissionSaved } from "./permission/saved"
import { toCurrentRule } from "./session/subagent-permissions"
import { Hooks } from "./hooks"

export { Effect, Rule, Ruleset } from "@opencode-ai/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export { evaluate, merge } from "./permission/evaluate"

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionNotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionNotFoundError>
  readonly assertPolicyAsk: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionNotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly policyAsk: boolean
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const pending = new Map<ID, Pending>()

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionSchema.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionNotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      const agentRules = agent?.permissions ?? missingAgentPermissions
      // Merge session-scoped rules (stored as V1 shape in the permission column)
      // on top of agent rules so child-session permissions (subagent derivation)
      // take effect. V1 {permission,pattern,action} → V2 {action,resource,effect}.
      const sessionRules = yield* sessions.sessionPermission(sessionID).pipe(EffectRuntime.orDie)
      return sessionRules && sessionRules.length > 0
        ? [...agentRules, ...sessionRules.map((rule) => toCurrentRule(rule))]
        : agentRules
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    /** Catch-all `* / *` is ignored for policy-ask except deny, which still denies. */
    function policyAskRules(rules: Permission.Ruleset) {
      return rules.filter((rule) => rule.action !== "*" || rule.resource !== "*")
    }

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: all }
    })

    const evaluatePolicyAsk = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const specific = policyAskRules([...rules, ...(yield* savedRules())])
      const effects = input.resources.map((resource) => evaluate(input.action, resource, specific).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: specific }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (request: Request, agent?: AgentV2.ID, policyAsk = false) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, policyAsk, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            yield* Hooks.fire({
              event: "PermissionDenied",
              sessionID: input.sessionID,
              toolName: input.action,
            }).pipe(EffectRuntime.ignore)
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const assertPolicyAsk = EffectRuntime.fn("PermissionV2.assertPolicyAsk")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluatePolicyAsk(input)
          if (result.effect === "deny") {
            yield* Hooks.fire({
              event: "PermissionDenied",
              sessionID: input.sessionID,
              toolName: input.action,
            }).pipe(EffectRuntime.ignore)
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent, true)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new DeclinedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            const resources = existing.request.save.filter((resource) => resource !== "*")
            if (resources.length) {
              yield* saved.add({
                projectID: location.project.id,
                action: existing.request.action,
                resources,
              })
            }
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules)) continue
            const remembered = existing.policyAsk || item.policyAsk ? policyAskRules(rememberedRules) : rememberedRules
            const configuredRules = item.policyAsk ? policyAskRules(rules) : rules
            const effective = [...configuredRules, ...remembered]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, assertPolicyAsk, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node],
})
