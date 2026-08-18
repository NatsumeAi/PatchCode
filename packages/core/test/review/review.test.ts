import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV2 } from "@opencode-ai/core/session"
import { ReviewGate } from "@opencode-ai/core/session/review-gate"
import { ReviewTool } from "@opencode-ai/core/tool/review"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorktreeEngine } from "@opencode-ai/core/worktree-engine"
import { testEffect } from "../lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "../lib/tool"

const sessionID = SessionV2.ID.make("ses_review")

const host = (output: string) =>
  Layer.succeed(
    TaskTool.HostService,
    TaskTool.HostService.of({
      run: (input) =>
        Effect.sync(() => {
          expect(input.subagentType).toBe("explore")
          expect(input.prompt).not.toContain("Call the `review` tool")
          expect(input.prompt).toContain("Return ONLY JSON")
          return { title: "review", output }
        }),
    }),
  )

const graph = (output: string) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ReviewTool.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [TaskTool.hostNode, host(output)],
  ])

describe("W8e review loop", () => {
  const pass = testEffect(
    graph(`\`\`\`json\n{"findings":[],"verdict":"pass"}\n\`\`\``),
  )
  const bad = testEffect(graph("not json at all"))
  const fail = testEffect(
    graph(`{"findings":[{"file":"a.ts","severity":"error","message":"bug"}],"verdict":"fail"}`),
  )

  pass.live("review is registered and parses child JSON", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((item) => item.name)).toContain("review")
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-review", name: "review", input: {} },
      })
      expect(result.type).not.toBe("error")
      expect(JSON.stringify(result)).toContain("pass")
    }),
  )

  bad.live("malformed child JSON is a tool error not pass", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-bad", name: "review", input: {} },
      })
      expect(result.type).toBe("error")
      expect(JSON.stringify(result)).not.toContain('"verdict":"pass"')
    }),
  )

  fail.live("reviewGate fail blocks WorktreeEngine.merge", () =>
    Effect.gen(function* () {
      yield* ReviewGate.reset()
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-fail",
          name: "review",
          input: { reviewGate: true },
        },
      })
      expect(result.type).not.toBe("error")
      const blocked = yield* Effect.flip(
        WorktreeEngine.merge({ projectRoot: "/tmp", id: "missing", sessionID: String(sessionID) }),
      )
      expect(blocked).toBeInstanceOf(ReviewGate.Failed)
    }),
  )

  test("merge with sessionID and no review verdict is blocked", async () => {
    await ReviewGate.reset().pipe(Effect.runPromise)
    const blocked = await Effect.flip(
      WorktreeEngine.merge({ projectRoot: "/tmp", id: "missing", sessionID: "ses_no_review" }),
    ).pipe(Effect.runPromise)
    expect(blocked).toBeInstanceOf(ReviewGate.Failed)
    expect((blocked as InstanceType<typeof ReviewGate.Failed>).verdict).toBe("none")
  })

  test("review.ts child prompt is JSON reviewer, not slash parent", async () => {
    const src = await Bun.file(new URL("../../src/tool/review.ts", import.meta.url)).text()
    expect(src).not.toContain("Verifier")
    expect(src).toContain('subagentType: "explore"')
    expect(src).toContain("plugin/command/review.txt")
    const child = await Bun.file(new URL("../../src/plugin/command/review.txt", import.meta.url)).text()
    expect(child).not.toContain("Call the `review` tool")
    expect(child).toContain("Return ONLY JSON")
    const slash = await Bun.file(new URL("../../src/plugin/command/review-slash.txt", import.meta.url)).text()
    expect(slash).toContain("Call the `review` tool")
  })
})
