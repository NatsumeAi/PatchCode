import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SpawnEdge } from "../../src/session/loop-control/spawn-edge"

test("SpawnEdge open then close is idempotent", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const edge = yield* SpawnEdge.make("parent", "child")
      expect((yield* SpawnEdge.status(edge))._tag).toBe("Open")
      yield* SpawnEdge.close(edge)
      expect((yield* SpawnEdge.status(edge))._tag).toBe("Closed")
      yield* SpawnEdge.close(edge)
      expect((yield* SpawnEdge.status(edge))._tag).toBe("Closed")
    }),
  )
})
