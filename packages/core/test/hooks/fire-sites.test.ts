import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Event } from "@opencode-ai/core/event"
import { Hooks } from "@opencode-ai/core/hooks"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const counts: Record<string, number> = {}

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp/hooks-fire") })),
)

const events = Layer.succeed(
  Event.Service,
  {
    publish: () => Effect.succeed({ durable: { aggregateID: "ses", seq: 1, version: 1 } }),
  } as unknown as Event.Interface,
)

const it = testEffect(
  Layer.provideMerge(
    AppNodeBuilder.build(Hooks.node, [
      [Location.node, current],
      [Event.node, events],
    ]),
    events,
  ),
)

const NAMES = [
  "UserPromptSubmit",
  "PermissionDenied",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const

describe("W5 fire sites in-process handlers", () => {
  it.effect("registered handler sees each locked event", () =>
    Effect.gen(function* () {
      const hooks = yield* Hooks.Service
      for (const name of NAMES) counts[name] = 0
      for (const name of NAMES) {
        yield* hooks.register({
          id: `h-${name}`,
          event: name,
          run: () =>
            Effect.sync(() => {
              counts[name] = (counts[name] ?? 0) + 1
              return { _tag: "Allow" as const }
            }),
        })
      }
      for (const name of NAMES) {
        yield* hooks.dispatch({ event: name, sessionID: "ses_fire" })
        expect(counts[name]).toBe(1)
      }
    }),
  )
})

test("live fire sites call Hooks.fire / fireSessionStart", async () => {
  const root = path.join(import.meta.dir, "../../src")
  const files: Record<string, string> = {
    "session/input.ts": "UserPromptSubmit",
    "permission.ts": "PermissionDenied",
    "session/compaction.ts": "PreCompact",
    "session/runner/llm.ts": 'event: "Stop"',
    "session/execution/local.ts": "fireSessionStart",
  }
  for (const [file, needle] of Object.entries(files)) {
    const text = await Bun.file(path.join(root, file)).text()
    expect(text).toContain("Hooks.")
    expect(text).toContain(needle)
  }
})
