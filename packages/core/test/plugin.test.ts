import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { define } from "@opencode-ai/plugin/effect"
import { Agent } from "@opencode-ai/core/agent"
import { Plugin } from "@opencode-ai/core/plugin"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

describe("Plugin", () => {
  it.effect("waits for a plugin and returns immediately once active", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const id = Plugin.ID.make("waited")
      const waiting = yield* plugins.wait(id).pipe(Effect.forkChild)

      yield* plugins.add(id, () => Effect.void)
      yield* Fiber.join(waiting)
      yield* plugins.wait(id)
    }),
  )

  it.effect("propagates plugin activation defects to waiters", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const id = Plugin.ID.make("failed")
      const waiting = yield* plugins.wait(id).pipe(Effect.exit, Effect.forkChild)

      const added = yield* plugins.add(id, () => Effect.die("boom")).pipe(Effect.exit)
      const pending = yield* Fiber.join(waiting)
      const later = yield* plugins.wait(id).pipe(Effect.exit)

      expect(Exit.isFailure(added)).toBe(true)
      expect(Exit.isFailure(pending)).toBe(true)
      expect(Exit.isFailure(later)).toBe(true)
    }),
  )

  it.effect("adds, replaces, and removes plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const agents = yield* Agent.Service
      let description = "first"

      const managed = () =>
        define({
          id: "managed",
          effect: (ctx) =>
            ctx.agent
              .transform((agents) =>
                agents.update("configured", (agent) => {
                  agent.description = description
                }),
              )
              .pipe(Effect.asVoid),
        })

      yield* plugins.add(Plugin.ID.make("managed"), managed().effect)

      expect((yield* agents.get(Agent.ID.make("configured")))?.description).toBe("first")

      description = "second"
      yield* plugins.add(Plugin.ID.make("managed"), managed().effect)
      expect((yield* agents.get(Agent.ID.make("configured")))?.description).toBe("second")

      yield* plugins.remove(Plugin.ID.make("managed"))
      expect(yield* agents.get(Agent.ID.make("configured"))).toBeUndefined()
    }),
  )
})
