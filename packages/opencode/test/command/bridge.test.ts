import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Command } from "@/command"
import { CommandV2 } from "@opencode-ai/core/command"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { InstanceState } from "@/effect/instance-state"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(Command.node), locationServiceMapLayer))

describe("Command W10 CommandV2 bridge", () => {
  it.instance("lists and gets location CommandV2-only names via slash Command", () =>
    Effect.gen(function* () {
      const commands = yield* Command.Service
      const locations = yield* LocationServiceMap.Service
      const ctx = yield* InstanceState.context
      const ref = Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) })
      yield* Effect.gen(function* () {
        const v2 = yield* CommandV2.Service
        yield* v2.transform((draft) => {
          draft.update("v2-only-cmd", (item) => {
            item.template = "hello $ARGUMENTS"
            item.description = "from v2"
          })
        })
      }).pipe(Effect.provide(locations.get(ref)))

      const hit = yield* commands.get("v2-only-cmd")
      expect(hit?.name).toBe("v2-only-cmd")
      expect(hit?.template).toBe("hello $ARGUMENTS")
      expect(hit?.description).toBe("from v2")
      expect((yield* commands.list()).some((c) => c.name === "v2-only-cmd")).toBe(true)
    }),
  )
})
