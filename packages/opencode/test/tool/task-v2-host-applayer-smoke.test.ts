/**
 * Production-graph smoke: AppLayer wires the real task host bridge (not the
 * die-stub HostService). Proves V1 TaskTool can resolve HostService from the
 * same assembly production shell/command uses.
 */
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { TaskTool as CoreTaskTool } from "@opencode-ai/core/tool/task"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AppLayer } from "../../src/effect/app-runtime"
import { ToolHostBridges } from "../../src/tool/tool-host-bridges"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const STUB_MSG = "Task host is not available. Subagent spawning requires the opencode task host bridge."

const it = testEffect(LayerNode.compile(LayerNode.group([])))

describe("AppLayer / real taskHostNode smoke", () => {
  it.live(
    "AppLayer provides HostService that is not the die stub",
    () =>
      Effect.gen(function* () {
        const host = yield* CoreTaskTool.HostService
        // Real host without a full V2 session context fails at runtime — but the
        // failure must be "missing SessionExecution/AgentV2/parent", never the
        // placeholder stub message from core TaskTool.hostNode.
        const exit = yield* host
          .run({
            parentSessionID: SessionSchema.ID.make("ses_smoke_parent_missing"),
            description: "app-layer smoke",
            prompt: "probe host wiring",
            subagentType: "general",
            agent: "build",
            assistantMessageID: "msg_smoke",
            toolCallID: "call_smoke",
          })
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (exit._tag === "Failure") {
          const pretty = Cause.pretty(exit.cause)
          expect(pretty).not.toContain(STUB_MSG)
          // Real bridge is installed: it progresses past "host missing" into
          // session/execution/agent resolution.
          expect(pretty).toMatch(
            /SessionExecution|AgentV2|Parent session not found|session not found|Unknown subagent/i,
          )
        }
      }).pipe(Effect.provide(AppLayer)),
    60000,
  )

  it.live(
    "taskHostNode layer alone is not the die stub",
    () =>
      Effect.gen(function* () {
        // Compile only the host bridge node (and its deps via LayerNode.compile).
        // If wiring is wrong and stub remains, STUB_MSG appears.
        const host = yield* CoreTaskTool.HostService
        const exit = yield* host
          .run({
            parentSessionID: SessionSchema.ID.make("ses_bridge_only"),
            description: "bridge smoke",
            prompt: "p",
            subagentType: "general",
            agent: "build",
            assistantMessageID: "m",
            toolCallID: "c",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (exit._tag === "Failure") {
          expect(Cause.pretty(exit.cause)).not.toContain(STUB_MSG)
        }
      }).pipe(Effect.provide(LayerNode.compile(ToolHostBridges.taskHostNode))),
    60000,
  )

  it.live(
    "AppLayer HostService is Some for serviceOption (V1 prefer gate opens)",
    () =>
      Effect.gen(function* () {
        const opt = yield* Effect.serviceOption(CoreTaskTool.HostService)
        expect(Option.isSome(opt)).toBe(true)
      }).pipe(Effect.provide(AppLayer)),
    30000,
  )
})
