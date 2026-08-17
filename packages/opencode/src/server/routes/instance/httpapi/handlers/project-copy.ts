import * as InstanceState from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { Catalog } from "@opencode-ai/core/catalog"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Slug } from "@opencode-ai/core/util/slug"
import { LLM, LLMClient, LLMEvent, Message, SystemPart } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service

    const withCatalog = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const generateName = Effect.fn("ProjectCopyHttpApi.generateName")(function* (context: string | undefined) {
      const text = context?.trim()
      if (!text) return Slug.create()
      const fallback = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!fallback) return Slug.create()
      const small =
        (yield* provider.getSmallModel(fallback.providerID)) ??
        (yield* provider.getModel(fallback.providerID, fallback.modelID))
      const catalog = yield* Catalog.Service
      const catalogModel = yield* catalog.model
        .get(small.providerID as never, small.id as never)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!catalogModel) return Slug.create()
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!model) return Slug.create()
      const result = yield* llm
        .stream(
          LLM.request({
            model,
            system: [SystemPart.make("Generate a short 2-3 word name. Output ONLY the name.")],
            messages: [Message.user(`Generate a short 2-3 word name that describes this task:\n${text}`)],
            tools: [],
          }),
        )
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
          Effect.catch(() => Effect.succeed("")),
        )
      const output = result.trim()
      return output ? slugify(output.split(/\s+/).slice(0, 3).join(" ")) : Slug.create()
    })

    return handlers.handle("generateName", (ctx) =>
      withCatalog(generateName(ctx.payload.context)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project copy name generation failed", {
            projectID: ctx.params.projectID,
            cause,
          }).pipe(Effect.as(Slug.create())),
        ),
        Effect.map((name) => ({ name })),
      ),
    )
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
