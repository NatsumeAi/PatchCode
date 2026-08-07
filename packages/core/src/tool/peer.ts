export * as PeerTool from "./peer"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"
import { SiblingMessage } from "../session/sibling-message"
import { Database } from "../database/database"
import { EventV2 } from "../event"

export const name = "peer_message"

export const description =
  "Send a short message to another subagent by registry address (sibling communication). Use when coordinating parallel work."

export const Input = Schema.Struct({
  to_address: Schema.String.annotate({
    description: "Target address from task result or registry (e.g. /root/explore/<sessionID>)",
  }),
  text: Schema.String.annotate({ description: "Message body for the peer" }),
})

export const Output = Schema.Struct({
  delivered: Schema.Boolean,
  output: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: "task",
                  resources: ["peer"],
                  save: ["peer"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: peer_message" })))
              yield* SiblingMessage.deliver({
                db: database.db,
                events,
                fromSessionID: context.sessionID,
                toAddress: input.to_address,
                text: input.text,
              }).pipe(Effect.mapError((e) => new ToolFailure({ message: String(e) })))
              return { delivered: true, output: `Delivered to ${input.to_address}` }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/peer",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node, EventV2.node],
})
