import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "../lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const previous = process.env.OPENCODE_SANDBOX

afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODE_SANDBOX
  else process.env.OPENCODE_SANDBOX = previous
})

describe("session sandbox pin", () => {
  it.effect("explicit off is stored", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, sandboxProfile: "off" })
      expect(created.sandboxProfile).toBe("off")
    }),
  )

  it.effect("OPENCODE_SANDBOX=off is stored", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_SANDBOX = "off"
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      expect(created.sandboxProfile).toBe("off")
    }),
  )

  it.effect("OPENCODE_SANDBOX=workspace is stored", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_SANDBOX = "workspace"
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      expect(created.sandboxProfile).toBe("workspace")
    }),
  )

  it.effect("untrusted location defaults to strict on unix", () =>
    Effect.gen(function* () {
      delete process.env.OPENCODE_SANDBOX
      if (process.platform === "win32") return
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      expect(created.sandboxProfile).toBe("strict")
    }),
  )

  it.effect("child copies parent profile", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const parent = yield* session.create({ location, sandboxProfile: "workspace" })
      const child = yield* session.create({
        location,
        parentID: parent.id,
        sandboxProfile: "off",
      })
      expect(child.sandboxProfile).toBe("workspace")
    }),
  )

  it.effect("resume with a different OPENCODE_SANDBOX fails ProfileMismatch", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, sandboxProfile: "off" })
      process.env.OPENCODE_SANDBOX = "workspace"
      const exit = yield* session.resume(created.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Sandbox.ProfileMismatch" })
      }
    }),
  )
})
