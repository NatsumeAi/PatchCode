import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Event } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { testEffect } from "../lib/effect"

const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Event.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [Project.node, projects],
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
      const session = yield* Session.Service
      const created = yield* session.create({ location, sandboxProfile: "off" })
      expect(created.sandboxProfile).toBe("off")
    }),
  )

  it.effect("OPENCODE_SANDBOX=off is stored", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_SANDBOX = "off"
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      expect(created.sandboxProfile).toBe("off")
    }),
  )

  it.effect("OPENCODE_SANDBOX=workspace is stored", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_SANDBOX = "workspace"
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      expect(created.sandboxProfile).toBe("workspace")
    }),
  )

  it.effect("untrusted location defaults to strict on unix", () =>
    Effect.gen(function* () {
      delete process.env.OPENCODE_SANDBOX
      if (process.platform === "win32") return
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      expect(created.sandboxProfile).toBe("strict")
    }),
  )

  it.effect("child copies parent profile", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
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
      const session = yield* Session.Service
      const created = yield* session.create({ location, sandboxProfile: "off" })
      process.env.OPENCODE_SANDBOX = "workspace"
      const exit = yield* session.resume(created.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Sandbox.ProfileMismatch" })
      }
    }),
  )

  it.effect("DEFAULT off SQL row is upgraded on load", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      delete process.env.OPENCODE_SANDBOX
      const { db } = yield* Database.Service
      const store = yield* SessionStore.Service
      const id = Session.ID.make("ses_legacy_off")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id,
          project_id: Project.ID.global,
          slug: "legacy-off",
          directory: "/project",
          title: "legacy-off",
          version: "test",
          sandbox_profile: "off",
        })
        .run()
      const loaded = yield* store.get(id)
      expect(loaded?.sandboxProfile).toBe("strict")
      const explicit = yield* (yield* Session.Service).create({ location, sandboxProfile: "off" })
      expect((yield* store.get(explicit.id))?.sandboxProfile).toBe("off")
    }),
  )
})
