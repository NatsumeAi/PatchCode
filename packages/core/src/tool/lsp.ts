export * as LspTool from "./lsp"

import path from "path"
import { pathToFileURL } from "url"
import { ToolFailure } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Permission } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "lsp"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export type Operation = (typeof operations)[number]

export const Input = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The character offset (1-based, as shown in editors)",
  }),
  query: Schema.String.pipe(Schema.optional).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
})

export const Output = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
})

export const description = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: List project-wide symbols matching a query string
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

workspaceSymbol also accepts:
- query: A query string to filter symbols by. Empty string requests all symbols.

For workspaceSymbol, filePath is not sent in the LSP workspace/symbol request. It is used by opencode to select and start the matching LSP server.

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`

/** Host-provided LSP bridge so core tools can call the opencode LSP stack without coupling. */
export interface Host {
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (file: string, reason: "document") => Effect.Effect<void>
  readonly definition: (input: { file: string; line: number; character: number }) => Effect.Effect<unknown[]>
  readonly references: (input: { file: string; line: number; character: number }) => Effect.Effect<unknown[]>
  readonly hover: (input: { file: string; line: number; character: number }) => Effect.Effect<unknown[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<unknown[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<unknown[]>
  readonly implementation: (input: { file: string; line: number; character: number }) => Effect.Effect<unknown[]>
  readonly prepareCallHierarchy: (input: {
    file: string
    line: number
    character: number
  }) => Effect.Effect<unknown[]>
  readonly incomingCalls: (input: { file: string; line: number; character: number }) => Effect.Effect<unknown[]>
  readonly outgoingCalls: (input: { file: string; line: number; character: number }) => Effect.Effect<unknown[]>
}

export class HostService extends Context.Service<HostService, Host>()("@opencode/LspTool.Host") {}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (args, context) =>
            Effect.gen(function* () {
              // Resolve host at execute time so app-layer bridges can provide it.
              const hostOpt = yield* Effect.serviceOption(HostService)
              if (Option.isNone(hostOpt)) {
                return yield* new ToolFailure({
                  message: "LSP host is not available in this environment",
                })
              }
              const lsp = hostOpt.value
              const file = path.isAbsolute(args.filePath)
                ? args.filePath
                : path.join(location.directory, args.filePath)

              yield* permission
                .assert({
                  action: "lsp",
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  metadata: {
                    operation: args.operation,
                    filePath: file,
                    line: args.line,
                    character: args.character,
                  },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: lsp" })))

              const exists = yield* fs.existsSafe(file)
              if (!exists) return yield* new ToolFailure({ message: `File not found: ${file}` })

              const available = yield* lsp.hasClients(file)
              if (!available) {
                return yield* new ToolFailure({ message: "No LSP server available for this file type." })
              }

              yield* lsp.touchFile(file, "document")
              const uri = pathToFileURL(file).href
              const position = { file, line: args.line - 1, character: args.character - 1 }
              const relPath = path.relative(location.project.directory, file)
              const detail =
                args.operation === "workspaceSymbol"
                  ? ""
                  : args.operation === "documentSymbol"
                    ? relPath
                    : `${relPath}:${args.line}:${args.character}`
              const title = detail ? `${args.operation} ${detail}` : args.operation

              const result: unknown[] = yield* (() => {
                switch (args.operation) {
                  case "goToDefinition":
                    return lsp.definition(position)
                  case "findReferences":
                    return lsp.references(position)
                  case "hover":
                    return lsp.hover(position)
                  case "documentSymbol":
                    return lsp.documentSymbol(uri)
                  case "workspaceSymbol":
                    return lsp.workspaceSymbol(args.query ?? "")
                  case "goToImplementation":
                    return lsp.implementation(position)
                  case "prepareCallHierarchy":
                    return lsp.prepareCallHierarchy(position)
                  case "incomingCalls":
                    return lsp.incomingCalls(position)
                  case "outgoingCalls":
                    return lsp.outgoingCalls(position)
                }
              })().pipe(
                Effect.mapError((error) => new ToolFailure({ message: `LSP ${args.operation} failed`, error })),
              )

              return {
                title,
                output:
                  result.length === 0
                    ? `No results found for ${args.operation}`
                    : JSON.stringify(result, null, 2),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/lsp",
  layer,
  deps: [ToolRegistry.node, Permission.node, FSUtil.node, Location.node],
})
