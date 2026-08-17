export * as PlanEnterTool from "./plan-enter"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { Permission } from "../permission"
import { Question } from "../question"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "plan_enter"

export const description = `Use this tool to suggest switching to plan agent when the user's request would benefit from planning before implementation.

If they explicitly mention wanting to create a plan ALWAYS call this tool first.

This tool will ask the user if they want to switch to plan agent.

Call this tool when:
- The user's request is complex and would benefit from planning first
- You want to research and design before making changes
- The task involves multiple files or significant architectural decisions

Do NOT call this tool:
- For simple, straightforward tasks
- When the user explicitly wants immediate implementation`

export const Input = Schema.Struct({})

export const Output = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const question = yield* Question.Service
    const permission = yield* Permission.Service
    const location = yield* Location.Service
    const events = yield* EventV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (_input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: "plan_enter",
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: plan_enter" })))

              const plan = path.join(".opencode", "plans", `${context.sessionID}.md`)
              const answers = yield* question
                .ask({
                  sessionID: context.sessionID,
                  questions: [
                    {
                      question: `Switch to plan agent to design before implementing? Plan will be written to ${plan}.`,
                      header: "Plan Agent",
                      custom: false,
                      options: [
                        { label: "Yes", description: "Switch to plan agent and design before coding" },
                        { label: "No", description: "Stay with build agent and implement directly" },
                      ],
                    },
                  ],
                  tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(
                  Effect.catchTag("Question.RejectedError", () =>
                    Effect.fail(new ToolFailure({ message: "User declined switching to plan agent" })),
                  ),
                )

              if (answers[0]?.[0] === "No") {
                return yield* new ToolFailure({ message: "User declined switching to plan agent" })
              }

              yield* events.publish(SessionEvent.AgentSwitched, {
                sessionID: context.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                agent: "plan",
              })

              return {
                title: "Switching to plan agent",
                output: `User approved switching to plan agent. Write the plan to ${plan} (workspace: ${location.directory}). Research and design before implementing.`,
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/plan-enter",
  layer,
  deps: [ToolRegistry.node, Permission.node, Question.node, Location.node, EventV2.node],
})
