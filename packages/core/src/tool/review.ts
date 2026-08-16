export * as ReviewTool from "./review"

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ReviewGate } from "../session/review-gate"
import { TaskTool } from "./task"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "review"

const TEMPLATE = readFileSync(fileURLToPath(new URL("../plugin/command/review.txt", import.meta.url)), "utf8")

const Input = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["diff", "paths"])).annotate({
    description: "diff (default): uncommitted changes. paths: listed files only.",
  }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "File paths to review when scope is paths",
  }),
  reviewGate: Schema.optional(Schema.Boolean).annotate({
    description: "When true, a fail verdict blocks later worktree merge for this session",
  }),
})

const Finding = Schema.Struct({
  file: Schema.String,
  line: Schema.optional(Schema.Number),
  severity: Schema.Literals(["error", "warning", "note"]),
  message: Schema.String,
})

const Output = Schema.Struct({
  findings: Schema.Array(Finding),
  verdict: Schema.Literals(["pass", "fail"]),
})

const extractJson = (text: string) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced?.[1]?.trim() ?? text.trim()
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end < start) return undefined
  return body.slice(start, end + 1)
}

const parseReview = (text: string) => {
  const json = extractJson(text)
  if (!json) return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

const asReview = (value: unknown): typeof Output.Type | undefined => {
  if (!value || typeof value !== "object") return undefined
  const record = value as { findings?: unknown; verdict?: unknown }
  if (!Array.isArray(record.findings)) return undefined
  const findings: Array<typeof Finding.Type> = []
  for (const item of record.findings) {
    if (!item || typeof item !== "object") return undefined
    const row = item as { file?: unknown; line?: unknown; severity?: unknown; message?: unknown }
    if (typeof row.file !== "string" || typeof row.message !== "string") return undefined
    if (row.severity !== "error" && row.severity !== "warning" && row.severity !== "note") return undefined
    findings.push({
      file: row.file,
      message: row.message,
      severity: row.severity,
      ...(typeof row.line === "number" ? { line: row.line } : {}),
    })
  }
  let verdict: "pass" | "fail" = record.verdict === "pass" || record.verdict === "fail" ? record.verdict : "fail"
  if (findings.some((finding) => finding.severity === "error")) verdict = "fail"
  if (record.verdict !== "pass" && record.verdict !== "fail") return undefined
  return { findings, verdict }
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const capturedHost = yield* Effect.serviceOption(TaskTool.HostService)
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Run an isolated read-only code review. The child must return JSON { findings, verdict }. Bad JSON is a tool error, never pass.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const liveHost = yield* Effect.serviceOption(TaskTool.HostService)
              const host = Option.isSome(liveHost) ? liveHost.value : Option.getOrUndefined(capturedHost)
              if (!host) return yield* new ToolFailure({ message: "Task host is not available for review" })
              const target =
                input.scope === "paths" && input.paths?.length
                  ? `Review these paths:\n${input.paths.join("\n")}`
                  : "Review uncommitted changes (`git diff` and `git diff --cached`)."
              const prompt = `${TEMPLATE}\n\n---\n\n${target}\n\nReturn ONLY JSON of the form {"findings":[{"file","line?","severity":"error"|"warning"|"note","message"}],"verdict":"pass"|"fail"}. verdict must be fail if any finding has severity error.`
              const result = yield* host.run({
                parentSessionID: context.sessionID,
                description: "code review",
                prompt,
                subagentType: "explore",
                agent: String(context.agent),
                assistantMessageID: String(context.assistantMessageID),
                toolCallID: context.toolCallID,
              })
              const parsed = asReview(parseReview(result.output))
              if (!parsed) return yield* new ToolFailure({ message: "Review child did not return valid JSON findings" })
              if (input.reviewGate) yield* ReviewGate.setEnabled(String(context.sessionID), true)
              yield* ReviewGate.record(String(context.sessionID), parsed.verdict)
              return parsed
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/review",
  layer,
  deps: [ToolRegistry.node, TaskTool.hostNode],
})
