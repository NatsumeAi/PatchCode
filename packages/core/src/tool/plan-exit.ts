export * as PlanExitTool from "./plan-exit"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { Permission } from "../permission"
import { Question } from "../question"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { EventV2 } from "../event"
import { DateTime } from "effect"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "plan_exit"

export const description = `Use this tool when you have completed the planning phase and are ready to exit plan agent.

This tool will ask the user if they want to switch to build agent to start implementing the plan.

Call this tool:
- After you have written a complete plan to the plan file
- After you have clarified any questions with the user
- When you are confident the plan is ready for implementation

Do NOT call this tool:
- Before you have created or finalized the plan
- If you still have unanswered questions about the implementation
- If the user has indicated they want to continue planning`

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
                  action: "plan_exit",
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: plan_exit" })))

              const plan = path.join(".opencode", "plans", `${context.sessionID}.md`)
              const answers = yield* question
                .ask({
                  sessionID: context.sessionID,
                  questions: [
                    {
                      question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                      header: "Build Agent",
                      custom: false,
                      options: [
                        { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                        { label: "No", description: "Stay with plan agent to continue refining the plan" },
                      ],
                    },
                  ],
                  tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(
                  Effect.catchTag("Question.RejectedError", () =>
                    Effect.fail(new ToolFailure({ message: "User declined switching to build agent" })),
                  ),
                )

              if (answers[0]?.[0] === "No") {
                return yield* new ToolFailure({ message: "User declined switching to build agent" })
              }

              // Switch agent for subsequent turns (projector updates SessionTable.agent).
              yield* events.publish(SessionEvent.AgentSwitched, {
                sessionID: context.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                agent: "build",
              })

              return {
                title: "Switching to build agent",
                output: `User approved switching to build agent. Plan path: ${plan} (workspace: ${location.directory}). Continue by implementing the plan and editing files as needed.`,
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/plan-exit",
  layer,
  deps: [ToolRegistry.node, Permission.node, Question.node, Location.node, EventV2.node],
})
