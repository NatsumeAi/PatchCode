export * as SkillInstallTool from "./skill-install"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { Global } from "../global"
import { Permission } from "../permission"
import { SkillInstall } from "../skill/install"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill_install"

const Input = Schema.Struct({
  uri: Schema.String.annotate({ description: "https URL of a SKILL.md (file: URIs are rejected)" }),
})

const Output = Schema.Struct({
  name: Schema.String,
  state: Schema.Literal("quarantine"),
  sha256: Schema.String,
  directory: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* Permission.Service
    const http = yield* HttpClient.HttpClient
    const global = yield* Global.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Install a skill from an https URL into quarantine. file: URIs are rejected. Trust with skill_trust before it appears in skill list.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: `Installed ${output.name} in ${output.state} (${output.sha256.slice(0, 12)}…)` },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const uri = input.uri.trim()
              const denied = SkillInstall.rejectReason(uri)
              if (denied) return yield* new ToolFailure({ message: denied })
              yield* permission
                .assert({
                  action: "skill",
                  resources: [uri],
                  save: [uri],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: skill" })))
              const response = yield* http
                .execute(HttpClientRequest.get(uri))
                .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
              const buffer = yield* response.arrayBuffer
              const bytes = new Uint8Array(buffer)
              return yield* Effect.tryPromise({
                try: () => SkillInstall.quarantine({ uri, body: bytes, configDir: global.config }),
                catch: (error) =>
                  new ToolFailure({
                    message: error instanceof Error ? error.message : `skill_install failed: ${String(error)}`,
                  }),
              })
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const message = error instanceof Error ? error.message : String(error)
                return new ToolFailure({ message: `skill_install failed: ${message}` })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill-install",
  layer,
  deps: [ToolRegistry.node, Permission.node, Global.node, LayerNodePlatform.httpClient],
})
