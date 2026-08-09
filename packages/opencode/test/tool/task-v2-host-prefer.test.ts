/**
 * End-to-end proof: when Core TaskTool.HostService is in the environment
 * (app graph / shell+command with V2 host), V1 TaskTool.execute prefers the
 * V2 host and never enters the legacy SessionPrompt spawn path.
 *
 * Residual risk from audit ACCEPT-WITH-GAPS #3.
 */
import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { TaskTool as CoreTaskTool } from "@opencode-ai/core/tool/task"
import { SessionSchema } from "@opencode-ai/core/session/schema"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
    EventBus.node,
  ]),
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)

const it = testEffect(layer)

const seed = Effect.fn("TaskV2HostPrefer.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "parent" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function trackingPromptOps() {
  let calls = 0
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: () =>
      Effect.sync(() => {
        calls++
        throw new Error("V1 SessionPrompt path must not run when V2 HostService is present")
      }),
  }
  return {
    ops,
    get calls() {
      return calls
    },
  }
}

describe("tool.task V2 host prefer (shell/command e2e gate)", () => {
  it.instance(
    "with HostService present: V1 TaskTool routes to host.run and skips V1 SessionPrompt spawn",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const prompt = trackingPromptOps()

        const hostCalls: Array<{
          parentSessionID: string
          description: string
          prompt: string
          subagentType: string
          agent: string
          background?: boolean
          command?: string
          forkMode?: string
        }> = []

        const host = CoreTaskTool.HostService.of({
          run: (input) =>
            Effect.sync(() => {
              hostCalls.push({
                parentSessionID: String(input.parentSessionID),
                description: input.description,
                prompt: input.prompt,
                subagentType: input.subagentType,
                agent: input.agent,
                background: input.background,
                command: input.command,
                forkMode: input.forkMode,
              })
              return {
                title: input.description,
                output: "spawned-via-v2-host",
                task_id: "ses_v2_child",
                sessionID: "ses_v2_child",
                background: false,
                structured: { exit: "completed" as const, resumeFrom: "ses_v2_child" },
              }
            }),
        })

        const result = yield* def
          .execute(
            {
              description: "shell task",
              prompt: "run from command path",
              subagent_type: "general",
              command: "explore",
              fork_mode: "LastNTurns",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              callID: "call_shell_1",
              abort: new AbortController().signal,
              extra: { promptOps: prompt.ops },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.provideService(CoreTaskTool.HostService, host))

        // Host is the single spawn authority.
        expect(hostCalls).toHaveLength(1)
        expect(hostCalls[0]?.parentSessionID).toBe(String(chat.id))
        expect(hostCalls[0]?.description).toBe("shell task")
        expect(hostCalls[0]?.prompt).toBe("run from command path")
        expect(hostCalls[0]?.subagentType).toBe("general")
        expect(hostCalls[0]?.agent).toBe("build")
        expect(hostCalls[0]?.command).toBe("explore")
        expect(hostCalls[0]?.forkMode).toBe("LastNTurns")

        // Result is host-shaped (not V1 <task id=…> wrapper from legacy path).
        expect(result.output).toBe("spawned-via-v2-host")
        expect(result.metadata.sessionId).toBe("ses_v2_child")
        expect(result.title).toBe("shell task")

        // V1 SessionPrompt never invoked.
        expect(prompt.calls).toBe(0)

        // No V1-created child under parent (host mock does not create sessions).
        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(0)
      }),
    30000,
  )

  it.instance(
    "with HostService present: host failure surfaces as Task failed (no V1 fallback)",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const prompt = trackingPromptOps()

        const host = CoreTaskTool.HostService.of({
          run: () => Effect.die(new Error("Permission denied: task (general)")),
        })

        const exit = yield* def
          .execute(
            {
              description: "blocked",
              prompt: "should not fall back",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: prompt.ops },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.provideService(CoreTaskTool.HostService, host), Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(prompt.calls).toBe(0)
        if (exit._tag === "Failure") {
          const msg = String(exit.cause)
          expect(msg).toMatch(/Task failed|Permission denied/)
        }
      }),
    30000,
  )

  it.instance(
    "without HostService: still uses V1 SessionPrompt path (fallback preserved)",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let v1Prompted = false
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              v1Prompted = true
              const id = MessageID.ascending()
              return {
                info: {
                  id,
                  role: "assistant" as const,
                  parentID: input.messageID ?? MessageID.ascending(),
                  sessionID: input.sessionID,
                  mode: "general",
                  agent: "general",
                  cost: 0,
                  path: { cwd: "/tmp", root: "/tmp" },
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: ref.modelID,
                  providerID: ref.providerID,
                  time: { created: Date.now() },
                  finish: "stop" as const,
                },
                parts: [
                  {
                    id: PartID.ascending(),
                    messageID: id,
                    sessionID: input.sessionID,
                    type: "text" as const,
                    text: "v1-fallback-done",
                  },
                ],
              }
            }),
        }

        // No HostService in environment — pure V1 fallback.
        const result = yield* def.execute(
          {
            description: "fallback task",
            prompt: "legacy path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(v1Prompted).toBe(true)
        expect(result.output).toContain("state=\"completed\"")
        const kids = yield* sessions.children(chat.id)
        expect(kids.length).toBeGreaterThanOrEqual(1)
      }),
    30000,
  )

  it.instance(
    "HostService receives branded parent SessionSchema.ID matching V1 session id",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seenParent: string | undefined

        const host = CoreTaskTool.HostService.of({
          run: (input) =>
            Effect.sync(() => {
              seenParent = String(input.parentSessionID)
              // Round-trip brand: same string as V1 SessionID
              expect(SessionSchema.ID.make(String(chat.id))).toBe(input.parentSessionID)
              return {
                title: "ok",
                output: "ok",
                sessionID: "child",
                task_id: "child",
              }
            }),
        })

        yield* def
          .execute(
            {
              description: "id check",
              prompt: "p",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  cancel: () => Effect.void,
                  resolvePromptParts: () => Effect.succeed([]),
                  prompt: () => Effect.die("no v1"),
                } satisfies TaskPromptOps,
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.provideService(CoreTaskTool.HostService, host))

        expect(seenParent).toBe(String(chat.id))
        expect(seenParent).toBe(String(SessionID.make(String(chat.id))))
      }),
    30000,
  )
})
