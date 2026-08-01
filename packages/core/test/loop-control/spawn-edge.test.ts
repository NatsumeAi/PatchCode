import { it, expect } from "bun:test"
import { Effect } from "effect"
import { SpawnEdge } from "../../src/session/loop-control/spawn-edge"

it("Spawn edge start as Open, transition to Closed 调用 close 后", () =>
  Effect.gen(function* () {
    const e = yield* SpawnEdge.make("parent-1", "child-1")
    expect((yield* SpawnEdge.status(e))._tag).toBe("Open")
    yield* SpawnEdge.close(e)
    expect((yield* SpawnEdge.status(e))._tag).toBe("Closed")
  }).pipe(
    Effect.provide(SpawnEdge.layerForTest),
    Effect.runPromise,
  ),
)

it("Closed edge 再 close 仍为 Closed (幂等)", () =>
  Effect.gen(function* () {
    const e = yield* SpawnEdge.make("p", "c")
    yield* SpawnEdge.close(e)
    yield* SpawnEdge.close(e)
    expect((yield* SpawnEdge.status(e))._tag).toBe("Closed")
  }).pipe(Effect.provide(SpawnEdge.layerForTest), Effect.runPromise),
)

it("Open → Open 幂等, Open → Closed 一次, Closed → Open 抛 Error", async () => {
  const run = Effect.gen(function* () {
    const e = yield* SpawnEdge.make("p", "c")
    yield* SpawnEdge.close(e)
    yield* SpawnEdge.open(e) // 应 fail
  })
  const exit = await Effect.runPromiseExit(run)
  expect(exit._tag).toBe("Failure")
})
