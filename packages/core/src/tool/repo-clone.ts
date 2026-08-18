export * as RepoCloneTool from "./repo-clone"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs"
import path from "node:path"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { DeniedUrl, denyHost, guardUrl } from "../net/deny-host"
import { Permission } from "../permission"
import { Repository } from "../repository"
import { RepositoryCache } from "../repository-cache"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "repo_clone"

const Input = Schema.Struct({
  repository: Schema.String.annotate({ description: "https or ssh git remote (github/gitlab/generic host)" }),
  branch: Schema.optional(Schema.String).annotate({ description: "Optional branch to track" }),
  dest: Schema.optional(Schema.String).annotate({
    description: "Optional Location-relative destination. Default is the shared repository cache.",
  }),
})

const Output = Schema.Struct({
  repository: Schema.String,
  localPath: Schema.String,
  dest: Schema.optional(Schema.String),
  status: Schema.String,
  output: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* Permission.Service
    const cache = yield* RepositoryCache.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Clone or refresh a remote git repository through the shared cache. Dest inside the location is copied after cache.ensure. Loopback and metadata hosts are denied.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (denyHost(input.repository)) {
                return yield* new ToolFailure({ message: `Repository host is not allowed: ${input.repository}` })
              }
              const reference = yield* Effect.try({
                try: () => Repository.parseRemote(input.repository),
                catch: (error) =>
                  new ToolFailure({
                    message: error instanceof Error ? error.message : `Invalid repository: ${input.repository}`,
                  }),
              })
              if (denyHost(reference.host) || denyHost(reference.remote)) {
                return yield* new ToolFailure({ message: `Repository host is not allowed: ${reference.host}` })
              }
              yield* Effect.tryPromise({
                try: () => guardUrl(reference.remote.startsWith("http") ? reference.remote : `https://${reference.host}`),
                catch: (error) =>
                  new ToolFailure({
                    message:
                      error instanceof DeniedUrl || error instanceof Error
                        ? `Repository host is not allowed: ${reference.host}`
                        : `Repository host is not allowed: ${reference.host}`,
                  }),
              })
              yield* permission
                .assert({
                  action: "repo",
                  resources: [reference.remote],
                  save: [reference.remote],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: repo" })))
              const ensured = yield* cache.ensure({
                reference,
                ...(input.branch ? { branch: input.branch } : {}),
              })
              let destPath: string | undefined
              if (input.dest) {
                const target = yield* mutation.resolve({
                  path: input.dest,
                  kind: "directory",
                  forWrite: true,
                  sessionID: context.sessionID,
                })
                fs.mkdirSync(target.canonical, { recursive: true })
                fs.cpSync(ensured.localPath, target.canonical, { recursive: true })
                destPath = target.canonical
              }
              const local = destPath ?? ensured.localPath
              return {
                repository: ensured.repository,
                localPath: ensured.localPath,
                ...(destPath ? { dest: destPath } : {}),
                status: ensured.status,
                output: `Cloned ${ensured.repository} → ${local} (${ensured.status})`,
              }
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const tag = error && typeof error === "object" && "_tag" in error ? String(error._tag) : ""
                const message = error instanceof Error && error.message ? error.message : tag || String(error)
                return new ToolFailure({ message: `repo_clone failed: ${message}` })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/repo-clone",
  layer,
  deps: [ToolRegistry.node, Permission.node, RepositoryCache.node, LocationMutation.node],
})
