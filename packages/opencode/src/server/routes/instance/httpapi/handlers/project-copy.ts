import { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import { Slug } from "@opencode-ai/core/util/slug"
import { LLM, LLMClient, LLMEvent, Message, SystemPart } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const provider = yield* Provider.Service

    const generateName = Effect.fn("ProjectCopyHttpApi.generateName")(function* (context: string | undefined) {
      const text = context?.trim()
      if (!text) return Slug.create()
      const fallback = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!fallback) return Slug.create()
      const small =
        (yield* provider.getSmallModel(fallback.providerID)) ??
        (yield* provider.getModel(fallback.providerID, fallback.modelID))
      const catalog = yield* Effect.promise(() => import("@opencode-ai/core/catalog"))
      const models = yield* catalog.Catalog.Service.pipe(Effect.catch(() => Effect.succeed(undefined)))
      const model = models
        ? yield* models.model
            .get(small.providerID as never, small.id as never)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
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
      generateName(ctx.payload.context).pipe(
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
