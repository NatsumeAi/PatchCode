import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { MemoryContext } from "../../src/memory/context"
import { writeTextAtomic } from "../../src/memory/storage"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const layer = (tmp: string) =>
  AppNodeBuilder.build(LayerNode.group([MemoryContext.node, SystemContextRegistry.node, FSUtil.node]), [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(`${tmp}/proj`) }))),
    ],
    [Global.node, Global.layerWith({ data: `${tmp}/global` })],
  ])

const it = testEffect(Layer.empty)

describe("Memory SystemContext", () => {
  it.live("renders decision framework with workspace summary first", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const globalSummary = path.join(dir.path, "global", "memory", "memory_summary.md")
          const workspaceSummary = path.join(dir.path, "proj", ".opencode", "memory", "memory_summary.md")
          yield* writeTextAtomic(fs, globalSummary, "global note")
          yield* writeTextAtomic(fs, workspaceSummary, "workspace note")
          const registry = yield* SystemContextRegistry.Service
          const ctx = yield* registry.load()
          const generation = yield* SystemContext.initialize(ctx)
          expect(generation.baseline).toContain("workspace note")
          expect(generation.baseline).toContain("global note")
          expect(generation.baseline).toContain("## Memory")
          expect(generation.baseline).toContain("USER/PROJECT DATA")
          expect(generation.baseline).toContain("untrusted")
          expect(generation.baseline).toContain("USER-PROVIDED MEMORY DATA")
          expect(generation.baseline.indexOf("workspace-memory")).toBeLessThan(
            generation.baseline.indexOf("global-memory"),
          )
        }).pipe(Effect.provide(layer(dir.path))),
      ),
    ),
  )

  it.live("renders framework alone when no summaries exist", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const registry = yield* SystemContextRegistry.Service
          const ctx = yield* registry.load()
          const generation = yield* SystemContext.initialize(ctx)
          expect(generation.baseline).toContain("## Memory")
        }).pipe(Effect.provide(layer(dir.path))),
      ),
    ),
  )

  it.live("describes real consolidation pipeline: notes + session logs → dream → MEMORY.md", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const registry = yield* SystemContextRegistry.Service
          const ctx = yield* registry.load()
          const generation = yield* SystemContext.initialize(ctx)
          expect(generation.baseline).toContain("session logs")
          expect(generation.baseline).toContain("Background consolidation (dream)")
          expect(generation.baseline).toContain("memory_search")
          expect(generation.baseline).toMatch(/never edit those two files directly/i)
          expect(generation.baseline).toContain("Until consolidated")
        }).pipe(Effect.provide(layer(dir.path))),
      ),
    ),
  )
})
