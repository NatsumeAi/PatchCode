export * as BrowserTool from "./browser"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { denyHost } from "../net/deny-host"
import { Permission } from "../permission"
import { BrowserHost } from "./browser-host"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export { HostService, type Host } from "./browser-host"

const unavailable = () => new ToolFailure({ message: "Browser host is unavailable" })

const NavigateInput = Schema.Struct({
  url: Schema.String.annotate({ description: "http(s) URL to open" }),
})
const NavigateOutput = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
})

const SnapshotInput = Schema.Struct({})
const SnapshotOutput = Schema.Struct({
  tree: Schema.String,
})

const ActInput = Schema.Struct({
  action: Schema.Literals(["click", "type"]).annotate({ description: "click a ref, or type text into a ref" }),
  ref: Schema.String.annotate({ description: "Snapshot element ref" }),
  text: Schema.optional(Schema.String).annotate({ description: "Text to type when action is type" }),
})
const ActOutput = Schema.Struct({
  ok: Schema.Boolean,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* Permission.Service
    const captured = yield* Effect.serviceOption(BrowserHost.HostService)

    const hostOf = () =>
      Effect.gen(function* () {
        const live = yield* Effect.serviceOption(BrowserHost.HostService)
        const host = Option.isSome(live) ? live.value : Option.getOrUndefined(captured)
        if (!host) return yield* unavailable()
        return host
      })

    yield* tools
      .register({
        browser_navigate: Tool.make({
          description: "Navigate the optional browser host to a URL. Metadata and loopback hosts are denied.",
          input: NavigateInput,
          output: NavigateOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: `${output.title} — ${output.url}` }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (denyHost(input.url)) return yield* new ToolFailure({ message: `URL is not allowed: ${input.url}` })
              yield* permission
                .assert({
                  action: "browser",
                  resources: [input.url],
                  save: [input.url],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: browser" })))
              const host = yield* hostOf()
              return yield* host.navigate(input.url)
            }),
        }),
        browser_snapshot: Tool.make({
          description: "Read a bounded accessibility/text snapshot of the current browser page.",
          input: SnapshotInput,
          output: SnapshotOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.tree }],
          execute: (_input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: "browser",
                  resources: ["snapshot"],
                  save: ["snapshot"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: browser" })))
              const host = yield* hostOf()
              return yield* host.snapshot()
            }),
        }),
        browser_act: Tool.make({
          description: "Click or type on a snapshot ref in the optional browser host.",
          input: ActInput,
          output: ActOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.ok ? "ok" : "failed" }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: "browser",
                  resources: [input.ref],
                  save: [input.ref],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: browser" })))
              const host = yield* hostOf()
              if (input.action === "type") return yield* host.type(input.ref, input.text ?? "")
              return yield* host.click(input.ref)
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/browser",
  layer,
  deps: [ToolRegistry.node, Permission.node],
})
