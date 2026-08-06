import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { CredentialBridge } from "../../src/auth/credential-bridge"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Auth.node, Credential.node])))

function withAuthContent<A, E, R>(value: Record<string, unknown>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env["OPENCODE_AUTH_CONTENT"]
      process.env["OPENCODE_AUTH_CONTENT"] = JSON.stringify(value)
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env["OPENCODE_AUTH_CONTENT"]
        else process.env["OPENCODE_AUTH_CONTENT"] = previous
      }),
  )
}

describe("CredentialBridge", () => {
  it.effect("imports legacy api keys into V2 credentials", () =>
    withAuthContent({ "opencode-go": { type: "api", key: "sk-test" } }, () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const credentials = yield* Credential.Service
        yield* CredentialBridge.sync(auth, credentials)
        const stored = yield* credentials.list(Integration.ID.make("opencode-go"))
        expect(stored.map((item) => item.value)).toEqual([Credential.Key.make({ type: "key", key: "sk-test" })])
      }),
    ),
  )

  it.effect("keeps an existing V2 credential instead of overwriting it", () =>
    withAuthContent({ "opencode-go": { type: "api", key: "legacy-key" } }, () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const credentials = yield* Credential.Service
        const existing = yield* credentials.create({
          integrationID: Integration.ID.make("opencode-go"),
          label: "existing",
          value: Credential.Key.make({ type: "key", key: "v2-key" }),
        })
        yield* CredentialBridge.sync(auth, credentials)
        expect(yield* credentials.list(Integration.ID.make("opencode-go"))).toEqual([existing])
      }),
    ),
  )

  it.effect("ignores legacy entries that are not api keys", () =>
    withAuthContent(
      {
        "example-oauth": { type: "oauth", refresh: "r", access: "a", expires: 0 },
        "example-wellknown": { type: "wellknown", key: "k", token: "t" },
      },
      () =>
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          const credentials = yield* Credential.Service
          yield* CredentialBridge.sync(auth, credentials)
          expect(yield* credentials.list(Integration.ID.make("example-oauth"))).toEqual([])
          expect(yield* credentials.list(Integration.ID.make("example-wellknown"))).toEqual([])
        }),
    ),
  )
})
