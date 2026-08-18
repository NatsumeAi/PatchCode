export * as Catalog from "./catalog"

import { makeLocationNode } from "./effect/app-node"
import { Array, Context, Effect, Layer, Option, Order, pipe, Schema } from "effect"
import { Catalog } from "@opencode-ai/schema/catalog"
import { Model } from "./model"
import { Provider as CoreProvider } from "./provider"
import { Event as CoreEvent } from "./event"
import { Policy } from "./policy"
import { State } from "./state"
import { Integration } from "./integration"
import { registerSecretValue } from "./secret-redaction"

export type ProviderRecord = {
  provider: CoreProvider.MutableInfo
  models: Map<Model.ID, Model.MutableInfo>
}

export type DefaultModel = { providerID: CoreProvider.ID; modelID: Model.ID }

export const PolicyActions = Schema.Literals(["provider.use"])

export const Event = Catalog.Event

type Data = {
  providers: Map<CoreProvider.ID, ProviderRecord>
  defaultModel?: DefaultModel
}

export type Draft = {
  provider: {
    list: () => readonly ProviderRecord[]
    get: (providerID: CoreProvider.ID) => ProviderRecord | undefined
    update: (providerID: CoreProvider.ID, fn: (provider: CoreProvider.MutableInfo) => void) => void
    remove: (providerID: CoreProvider.ID) => void
  }
  model: {
    get: (providerID: CoreProvider.ID, modelID: Model.ID) => Model.Info | undefined
    update: (providerID: CoreProvider.ID, modelID: Model.ID, fn: (model: Model.MutableInfo) => void) => void
    remove: (providerID: CoreProvider.ID, modelID: Model.ID) => void
    default: {
      get: () => DefaultModel | undefined
      set: (providerID: CoreProvider.ID, modelID: Model.ID) => void
    }
  }
}

export interface Interface extends State.Transformable<Draft> {
  readonly provider: {
    readonly get: (providerID: CoreProvider.ID) => Effect.Effect<CoreProvider.Info | undefined>
    readonly all: () => Effect.Effect<CoreProvider.Info[]>
    readonly available: () => Effect.Effect<CoreProvider.Info[]>
  }
  readonly model: {
    readonly get: (providerID: CoreProvider.ID, modelID: Model.ID) => Effect.Effect<Model.Info | undefined>
    readonly all: () => Effect.Effect<Model.Info[]>
    readonly available: () => Effect.Effect<Model.Info[]>
    readonly default: () => Effect.Effect<Model.Info | undefined>
    readonly small: (providerID: CoreProvider.ID) => Effect.Effect<Model.Info | undefined>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Catalog") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* CoreEvent.Service
    const policy = yield* Policy.Service
    const integrations = yield* Integration.Service

    const available = (provider: CoreProvider.Info, integration: Integration.Info | undefined) => {
      if (provider.disabled) return false
      // Legacy Provider.getModel treated options.apiKey as enough. openai-compatible
      // migrate puts that key on api.settings, not request.body.
      if (typeof provider.request.body.apiKey === "string") return true
      if (typeof provider.api.settings?.apiKey === "string") return true
      if (integration?.connections.length) return true
      return provider.integrationID === undefined && !integration
    }

    const projectModel = (model: Model.Info, provider: CoreProvider.Info) => {
      const api =
        model.api.type === "native" && !model.api.url && Object.keys(model.api.settings).length === 0
          ? { ...provider.api, id: model.api.id }
          : model.api.type === "aisdk" && provider.api.type === "aisdk" && !model.api.url
            ? { ...model.api, url: provider.api.url, settings: { ...provider.api.settings, ...model.api.settings } }
            : model.api.type === "aisdk" && provider.api.type === "aisdk"
              ? { ...model.api, settings: { ...provider.api.settings, ...model.api.settings } }
              : model.api
      const request = {
        headers: { ...provider.request.headers, ...model.request.headers },
        body: { ...provider.request.body, ...model.request.body },
        variant: model.request.variant,
      }
      for (const value of [
        provider.request.body.apiKey,
        provider.api.settings?.apiKey,
        request.body.apiKey,
        api.settings?.apiKey,
      ]) {
        if (typeof value === "string") registerSecretValue(value)
      }
      return Model.Info.make({
        ...model,
        api,
        request,
      })
    }

    const normalizeApi = (item: CoreProvider.MutableInfo | Model.MutableInfo) => {
      if (typeof item.request.body.baseURL !== "string") return
      item.api.url = item.request.body.baseURL
      delete item.request.body.baseURL
    }

    const state = State.create<Data, Draft>({
      initial: () => ({ providers: new Map() }),
      draft: (draft) => {
        const result: Draft = {
          provider: {
            list: () => Array.fromIterable(draft.providers.values()) as ProviderRecord[],
            get: (providerID) => draft.providers.get(providerID),
            update: (providerID, fn) => {
              let current = draft.providers.get(providerID)
              if (!current) {
                current = {
                  provider: CoreProvider.Info.empty(providerID) as CoreProvider.MutableInfo,
                  models: new Map<Model.ID, Model.MutableInfo>(),
                }
                draft.providers.set(providerID, current)
              }
              fn(current.provider)
              normalizeApi(current.provider)
            },
            remove: (providerID) => {
              draft.providers.delete(providerID)
            },
          },
          model: {
            get: (providerID, modelID) => draft.providers.get(providerID)?.models.get(modelID),
            update: (providerID, modelID, fn) => {
              let record = draft.providers.get(providerID)
              if (!record) {
                record = {
                  provider: CoreProvider.Info.empty(providerID) as CoreProvider.MutableInfo,
                  models: new Map<Model.ID, Model.MutableInfo>(),
                }
                draft.providers.set(providerID, record)
              }
              const model =
                record.models.get(modelID) ?? (Model.Info.empty(providerID, modelID) as Model.MutableInfo)
              if (!record.models.has(modelID)) record.models.set(modelID, model)
              fn(model)
              model.id = modelID
              model.providerID = providerID
              normalizeApi(model)
            },
            remove: (providerID, modelID) => {
              draft.providers.get(providerID)?.models.delete(modelID)
            },
            default: {
              get: () => draft.defaultModel,
              set: (providerID, modelID) => {
                draft.defaultModel = { providerID, modelID }
              },
            },
          },
        }
        return result
      },
      finalize: Effect.fn("Catalog.finalize")(function* (catalog) {
        if (policy.hasStatements()) {
          for (const record of [...catalog.provider.list()]) {
            if ((yield* policy.evaluate("provider.use", record.provider.id, "allow")) === "deny") {
              catalog.provider.remove(record.provider.id)
            }
          }
        }
        yield* events.publish(Event.Updated, {})
      }),
    })
    const result: Interface = {
      transform: state.transform,
      reload: state.reload,

      provider: {
        get: Effect.fn("Catalog.provider.get")(function* (providerID) {
          return state.get().providers.get(providerID)?.provider
        }),

        all: Effect.fn("Catalog.provider.all")(function* () {
          return Array.fromIterable(state.get().providers.values()).map((record) => record.provider)
        }),

        available: Effect.fn("Catalog.provider.available")(function* () {
          const active = new Map((yield* integrations.list()).map((integration) => [integration.id, integration]))
          return (yield* result.provider.all()).filter((provider) =>
            available(provider, active.get(provider.integrationID ?? Integration.ID.make(provider.id))),
          )
        }),
      },

      model: {
        get: Effect.fn("Catalog.model.get")(function* (providerID, modelID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const model = record.models.get(modelID)
          return model && projectModel(model, record.provider)
        }),

        all: Effect.fn("Catalog.model.all")(function* () {
          return pipe(
            Array.fromIterable(state.get().providers.values()),
            Array.flatMap((record) => {
              return Array.fromIterable(record.models.values()).map((model) => projectModel(model, record.provider))
            }),
            Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
          )
        }),

        available: Effect.fn("Catalog.model.available")(function* () {
          const providers = new Set((yield* result.provider.available()).map((provider) => provider.id))
          return (yield* result.model.all()).filter((model) => providers.has(model.providerID) && model.enabled)
        }),

        default: Effect.fn("Catalog.model.default")(function* () {
          const defaultModel = state.get().defaultModel
          if (defaultModel) {
            const provider = yield* result.provider.get(defaultModel.providerID)
            if (provider && (yield* result.provider.available()).some((item) => item.id === provider.id)) {
              const model = yield* result.model.get(defaultModel.providerID, defaultModel.modelID)
              if (model?.enabled) return model
            }
          }

          return Option.getOrUndefined(
            pipe(
              yield* result.model.available(),
              Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
              Array.head,
            ),
          )
        }),

        small: Effect.fn("Catalog.model.small")(function* (providerID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const provider = record.provider

          // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
          if (providerID === CoreProvider.ID.azure || providerID === CoreProvider.ID.make("azure-cognitive-services")) {
            return
          }

          if (providerID === CoreProvider.ID.opencode) {
            const gpt5Nano = record.models.get(Model.ID.make("gpt-5-nano"))
            if (gpt5Nano?.enabled && gpt5Nano.status === "active") return projectModel(gpt5Nano, provider)
          }

          const candidates = pipe(
            Array.fromIterable(record.models.values()),
            Array.filter(
              (model) =>
                model.providerID === providerID &&
                model.enabled &&
                model.status === "active" &&
                model.capabilities.input.some((item) => item.startsWith("text")) &&
                model.capabilities.output.some((item) => item.startsWith("text")),
            ),
            Array.map((model) => ({
              model,
              cost: model.cost[0] ? model.cost[0].input + model.cost[0].output : 999,
              age: (Date.now() - model.time.released) / (1000 * 60 * 60 * 24 * 30),
              small: SMALL_MODEL_RE.test(`${model.id} ${model.family ?? ""} ${model.name}`.toLowerCase()),
            })),
            Array.filter((item) => item.cost > 0 && item.age <= 18),
          )

          const pick = (items: typeof candidates) => {
            const maxCost = Math.max(...items.map((item) => item.cost), 0.01)
            const maxAge = Math.max(...items.map((item) => item.age), 0.01)
            return pipe(
              items,
              Array.sortWith((item) => (item.cost / maxCost) * 0.8 + (item.age / maxAge) * 0.2, Order.Number),
              Array.map((item) => projectModel(item.model, provider)),
              Array.head,
            )
          }

          return Option.getOrUndefined(
            pipe(
              candidates,
              Array.filter((item) => item.small),
              (items) => (items.length > 0 ? pick(items) : pick(candidates)),
            ),
          )
        }),
      },
    }

    return Service.of(result)
  }),
)

const SMALL_MODEL_RE = /\b(nano|flash|lite|mini|haiku|small|fast)\b/

export const locationLayer = layer.pipe(
  Layer.provideMerge(Integration.locationLayer),
  Layer.provideMerge(Policy.locationLayer),
)

export const node = makeLocationNode({ service: Service, layer, deps: [CoreEvent.node, Policy.node, Integration.node] })
