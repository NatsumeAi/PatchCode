import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { pinSession } from "@opencode-ai/core/sandbox/resolve"
import { SessionV2 } from "@opencode-ai/core/session"

const sessionID = SessionV2.ID.make("ses_rg_live_sandbox")

describe.skipIf(process.platform !== "linux")("ripgrep live sandbox", () => {
  test("workspace ripgrep cannot read denied .env", async () => {
    expect(await Bun.file("/usr/bin/bwrap").exists()).toBe(true)
    const work = await mkdtemp(path.join(tmpdir(), "oc-rg-live-"))
    pinSession(sessionID, "workspace")
    try {
      await writeFile(path.join(work, ".env"), "SECRET=1\n")
      await writeFile(path.join(work, "ok.txt"), "SECRET=visible\n")
      const matches = await Effect.gen(function* () {
        const rg = yield* Ripgrep.Service
        return yield* rg.grep({
          cwd: work,
          pattern: "SECRET",
          limit: 20,
          sessionID,
        })
      }).pipe(Effect.provide(AppNodeBuilder.build(Ripgrep.node)), Effect.runPromise)
      const texts = matches.map((match) => match.text).join("\n")
      expect(texts).toContain("visible")
      expect(texts).not.toContain("SECRET=1")
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
