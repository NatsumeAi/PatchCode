import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Permission } from "@opencode-ai/core/permission"
import { Session } from "@opencode-ai/core/session"
import { BrowserHost } from "@opencode-ai/core/tool/browser-host"
import { BrowserTool } from "@opencode-ai/core/tool/browser"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_browser")
const clicks: string[] = []
const navigated: string[] = []

const host = Layer.succeed(
  BrowserHost.HostService,
  BrowserHost.HostService.of({
    navigate: (url) =>
      Effect.sync(() => {
        navigated.push(url)
        return { title: "Example", url }
      }),
    snapshot: () => Effect.succeed({ tree: "button ref=1" }),
    click: (ref) =>
      Effect.sync(() => {
        clicks.push(ref)
        return { ok: true }
      }),
    type: () => Effect.succeed({ ok: true }),
  }),
)

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

const enabled = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([{ type: "document" as const, info: { browser: { enabled: true } } }] as never),
    reload: () => Effect.void,
  }),
)

const disabled = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
    reload: () => Effect.void,
  }),
)

const withHost = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, BrowserTool.node]), [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Permission.node, permission],
    ]),
    host,
    enabled,
  ),
)

const withoutHost = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, BrowserTool.node]), [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Permission.node, permission],
    ]),
    disabled,
  ),
)

describe("W8g browser min", () => {
  withoutHost.live("tools are absent when disabled and host missing", () =>
    Effect.gen(function* () {
      const names = (yield* toolDefinitions(yield* ToolRegistry.Service)).map((item) => item.name)
      expect(names).not.toContain("browser_navigate")
      expect(names).not.toContain("browser_snapshot")
      expect(names).not.toContain("browser_act")
    }),
  )

  withHost.live("fake host navigate snapshot click", () =>
    Effect.gen(function* () {
      navigated.length = 0
      clicks.length = 0
      const registry = yield* ToolRegistry.Service
      const names = (yield* toolDefinitions(registry)).map((item) => item.name)
      expect(names).toContain("browser_navigate")
      const nav = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "nav",
          name: "browser_navigate",
          input: { url: "https://example.com" },
        },
      })
      expect(nav.type).not.toBe("error")
      expect(navigated).toEqual(["https://example.com"])
      const snap = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "snap", name: "browser_snapshot", input: {} },
      })
      expect(JSON.stringify(snap)).toContain("button")
      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "act",
          name: "browser_act",
          input: { action: "click", ref: "1" },
        },
      })
      expect(clicks).toEqual(["1"])
    }),
  )

  withHost.live("metadata URL is denied before Host", () =>
    Effect.gen(function* () {
      navigated.length = 0
      const result = yield* executeTool(yield* ToolRegistry.Service, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "meta",
          name: "browser_navigate",
          input: { url: "http://169.254.169.254/" },
        },
      })
      expect(result.type).toBe("error")
      expect(navigated).toEqual([])
    }),
  )

  test("browser.ts does not import webfetch or computer_use", async () => {
    const src = await Bun.file(new URL("../src/tool/browser.ts", import.meta.url)).text()
    expect(src).not.toContain("webfetch")
    expect(src).not.toContain("computer_use")
  })
})
