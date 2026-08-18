import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pinSession } from "@opencode-ai/core/sandbox/resolve"
import { Session } from "@opencode-ai/core/session"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "../fixture/location"
import { executeTool, toolIdentity } from "../lib/tool"

const sessionID = Session.ID.make("ses_read_deny_sandbox")

const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: () => Effect.void,
    assertPolicyAsk: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]), reload: () => Effect.void }))

describe("read deny .env", () => {
  test("read tool on .env under workspace is denied", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-read-deny-"))
    pinSession(sessionID, "workspace")
    try {
      await writeFile(path.join(work, ".env"), "SECRET=1\n")
      const activeLocation = Layer.succeed(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make(work) })),
      )
      const result = await Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const result = yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call" as const, id: "call-read-env", name: "read", input: { path: ".env" } },
        })
        const text = JSON.stringify(result)
        expect(text).not.toContain("SECRET=1")
        expect(text.toLowerCase()).toMatch(/denied|unable to read/)
      })
        .pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                ReadTool.node,
              ]),
              [
                [Location.node, activeLocation],
                [Permission.node, permission],
                [Config.node, config],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        )
        .pipe(Effect.runPromise)
      expect(result).toBeUndefined()
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
