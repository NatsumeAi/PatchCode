import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { RepositoryCache } from "@opencode-ai/core/repository-cache"
import { SessionV2 } from "@opencode-ai/core/session"
import { RepoCloneTool } from "@opencode-ai/core/tool/repo-clone"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_repo_clone")
const ensured: Array<{ remote: string }> = []
const cacheDir = mkdtempSync(path.join(os.tmpdir(), "oc-repo-cache-"))
writeFileSync(path.join(cacheDir, "README.md"), "from-cache\n")

const cache = Layer.mock(RepositoryCache.Service, {
  ensure: (input) =>
    Effect.sync(() => {
      ensured.push({ remote: input.reference.remote })
      return {
        repository: input.reference.label,
        host: input.reference.host,
        remote: input.reference.remote,
        localPath: cacheDir,
        status: "cloned" as const,
      }
    }),
})

const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: () => Effect.void,
    assertPolicyAsk: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, RepoCloneTool.node]),
    [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Permission.node, permission],
      [Location.node, tempLocationLayer],
      [RepositoryCache.node, cache],
    ],
  ),
)

describe("W8f repo_clone", () => {
  it.live("loopback URL is denied before RepositoryCache.ensure", () =>
    Effect.gen(function* () {
      ensured.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-loop",
          name: "repo_clone",
          input: { repository: "https://127.0.0.1/x.git" },
        },
      })
      expect(result.type).toBe("error")
      expect(ensured).toEqual([])
    }),
  )

  it.live("metadata IP is denied before RepositoryCache.ensure", () =>
    Effect.gen(function* () {
      ensured.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-meta",
          name: "repo_clone",
          input: { repository: "https://169.254.169.254/x.git" },
        },
      })
      expect(result.type).toBe("error")
      expect(ensured).toEqual([])
    }),
  )

  it.live("calls RepositoryCache.ensure for a public remote", () =>
    Effect.gen(function* () {
      ensured.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-ok",
          name: "repo_clone",
          input: { repository: "https://github.com/sst/opencode" },
        },
      })
      expect(result.type).not.toBe("error")
      expect(ensured.length).toBe(1)
      expect(ensured[0]?.remote).toContain("github.com")
    }),
  )

  it.live("dest copies through LocationMutation into the active location", () =>
    Effect.gen(function* () {
      ensured.length = 0
      const settlement = yield* settleTool(yield* ToolRegistry.Service, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-dest",
          name: "repo_clone",
          input: { repository: "https://github.com/sst/opencode", dest: "vendor/cloned" },
        },
      })
      expect(settlement.result.type).not.toBe("error")
      const dest = (settlement.output?.structured as { dest?: string } | undefined)?.dest
      expect(dest).toBeTruthy()
      expect(readFileSync(path.join(dest!, "README.md"), "utf8")).toBe("from-cache\n")
    }),
  )

  test("repo-clone.ts uses RepositoryCache.ensure", async () => {
    const src = await Bun.file(new URL("../src/tool/repo-clone.ts", import.meta.url)).text()
    expect(src).toContain("cache.ensure")
    expect(src).toContain("denyHost")
  })
})
