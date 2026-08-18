import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Event } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pinSession } from "@opencode-ai/core/sandbox/resolve"
import { Session } from "@opencode-ai/core/session"
import { location } from "../fixture/location"

const sessionID = Session.ID.make("ses_pty_live_sandbox")
const config = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })

describe.skipIf(process.platform !== "linux")("pty live sandbox", () => {
  test("workspace PTY cannot write the home probe file", async () => {
    expect(await Bun.file("/usr/bin/bwrap").exists()).toBe(true)
    const work = await mkdtemp(path.join(tmpdir(), "oc-pty-live-"))
    const probe = path.join(homedir(), "opencode-sandbox-probe-pty")
    pinSession(sessionID, "workspace")
    const activeLocation = Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(work) })),
    )
    try {
      await Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* pty.create({
          command: "/bin/sh",
          args: ["-c", `echo leaked > '${probe}'; exit`],
          cwd: work,
          sessionID,
        })
        for (let i = 0; i < 50; i++) {
          const current = yield* pty.get(info.id)
          if (current.status === "exited") break
          yield* Effect.sleep("50 millis")
        }
        yield* pty.remove(info.id).pipe(Effect.ignore)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Pty.node, Event.node]), [
            [Config.node, config],
            [Location.node, activeLocation],
          ]),
        ),
        Effect.runPromise,
      )
      expect(await Bun.file(probe).exists()).toBe(false)
    } finally {
      await rm(work, { recursive: true, force: true })
      await rm(probe, { force: true })
    }
  })
})
