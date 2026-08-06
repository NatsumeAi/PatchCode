// Legacy auth.json keys are consumed by the V1 Provider service only. The V2
// catalog derives provider availability from Integration connections stored in
// Credential.Service, so auth.json-only providers stay "Model unavailable".
// Import api keys at startup so V2 model resolution sees them.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"

const legacyValue = (info: Auth.Info) => {
  if (info.type !== "api") return
  return Credential.Key.make({
    type: "key",
    key: info.key,
    ...(info.metadata ? { metadata: info.metadata } : {}),
  })
}

/** Copies legacy auth.json api keys into V2 credentials, skipping integrations that already have one. */
export const sync = Effect.fn("CredentialBridge.sync")(function* (
  auth: Auth.Interface,
  credentials: Credential.Interface,
) {
  // Soft-fail: malformed auth.json must not take down the whole app graph.
  const legacy = yield* auth.all().pipe(
    Effect.catch((error) => {
      console.error("CredentialBridge: failed to read auth.json", error)
      return Effect.succeed({} as Record<string, Auth.Info>)
    }),
  )
  let imported = 0
  for (const [providerID, info] of Object.entries(legacy)) {
    const value = legacyValue(info)
    if (!value) continue
    const integrationID = Integration.ID.make(providerID)
    if ((yield* credentials.list(integrationID)).length > 0) continue
    yield* credentials.create({ integrationID, label: "auth.json", value }).pipe(
      Effect.catch((error) => {
        console.error(`CredentialBridge: failed to import ${providerID}`, error)
        return Effect.void
      }),
    )
    imported++
  }
  return imported
})

export const node = LayerNode.make({
  name: "credential-bridge",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const credentials = yield* Credential.Service
      yield* sync(auth, credentials).pipe(
        Effect.catch((error) => {
          console.error("CredentialBridge: startup sync failed", error)
          return Effect.void
        }),
      )
    }),
  ),
  deps: [Auth.node, Credential.node],
})

export * as CredentialBridge from "./credential-bridge"
