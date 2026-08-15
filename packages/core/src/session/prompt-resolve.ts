export * as PromptResolve from "./prompt-resolve"

import { fileURLToPath } from "url"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import type { Prompt } from "./prompt"
import type { PromptInput } from "@opencode-ai/schema/prompt-input"

const filePathFromUri = (uri: string) => {
  if (!uri.startsWith("file:")) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""))
  }
}

const calledRead = (filePath: string) =>
  `Called the Read tool with the following input: ${JSON.stringify({ filePath })}`

const failedRead = (filePath: string, error: string) =>
  `Read tool failed to read ${filePath} with the following error: ${error}`

export type Resolved = {
  readonly text: string
  readonly files: Prompt["files"]
  readonly agents: Prompt["agents"]
  readonly parts: NonNullable<Prompt["parts"]>
}

const fromInputParts = (input: PromptInput.Prompt): NonNullable<Prompt["parts"]> => {
  if (input.parts && input.parts.length > 0) {
    return input.parts.map((part) => {
      if (part.type === "file") {
        return {
          type: "file" as const,
          uri: part.uri,
          mime: "mime" in part && typeof part.mime === "string" ? part.mime : undefined,
          name: part.name,
          description: part.description,
          source: part.source,
        }
      }
      return part
    }) as NonNullable<Prompt["parts"]>
  }
  const parts: NonNullable<Prompt["parts"]> = []
  if (input.text) parts.push({ type: "text", text: input.text })
  for (const file of input.files ?? []) {
    parts.push({
      type: "file",
      uri: file.uri,
      name: file.name,
      description: file.description,
      source: file.source,
    })
  }
  for (const agent of input.agents ?? []) {
    parts.push({ type: "agent", name: agent.name, source: agent.source })
  }
  return parts
}

const assemble = (parts: NonNullable<Prompt["parts"]>): Resolved => {
  // Include synthetic Read/agent-coaching text so the live tape sees the same
  // body V1 text parts used to concatenate for the model.
  const text = parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const files = parts
    .filter((part): part is Extract<typeof part, { type: "file" }> => part.type === "file")
    .map((part) => ({
      uri: part.uri,
      mime: part.mime ?? "application/octet-stream",
      ...(part.name === undefined ? {} : { name: part.name }),
      ...(part.description === undefined ? {} : { description: part.description }),
    }))
  const agents = parts
    .filter((part): part is Extract<typeof part, { type: "agent" }> => part.type === "agent")
    .map((part) => ({ name: part.name }))
  return {
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    parts,
  }
}

const expandAgents = (incoming: NonNullable<Prompt["parts"]>) => {
  const parts: NonNullable<Prompt["parts"]> = []
  for (let index = 0; index < incoming.length; index++) {
    const part = incoming[index]!
    if (part.type !== "agent") {
      parts.push(part)
      continue
    }
    parts.push(part)
    const next = incoming[index + 1]
    if (!(next?.type === "text" && next.text.includes("call the task tool with subagent"))) {
      parts.push({
        type: "text",
        synthetic: true,
        text:
          " Use the above message and context to generate a prompt and call the task tool with subagent: " + part.name,
      })
    }
  }
  return parts
}

export const needsFilesystem = (input: PromptInput.Prompt) => {
  const incoming = fromInputParts(input)
  return incoming.some((part) => part.type === "file" && part.uri.startsWith("file:"))
}

export const resolve = Effect.fn("PromptResolve.resolve")(function* (input: PromptInput.Prompt) {
  const incoming = fromInputParts(input)
  if (!incoming.some((part) => part.type === "file" && part.uri.startsWith("file:"))) {
    return assemble(expandAgents(incoming))
  }
  const fs = yield* FSUtil.Service
  const parts: NonNullable<Prompt["parts"]> = []

  for (let index = 0; index < incoming.length; index++) {
    const part = incoming[index]!
    if (part.type !== "file") {
      if (part.type === "agent") {
        parts.push(part)
        const next = incoming[index + 1]
        const coached =
          next?.type === "text" && next.text.includes("call the task tool with subagent")
        if (!coached) {
          parts.push({
            type: "text",
            synthetic: true,
            text:
              " Use the above message and context to generate a prompt and call the task tool with subagent: " +
              part.name,
          })
        }
        continue
      }
      parts.push(part)
      continue
    }

    const uri = part.uri
    const mimeHint = part.mime
    if (uri.startsWith("data:") && mimeHint === "text/plain") {
      const comma = uri.indexOf(",")
      const payload = comma >= 0 ? uri.slice(comma + 1) : ""
      const text = Buffer.from(payload, "base64").toString("utf8")
      parts.push({
        type: "text",
        synthetic: true,
        text: calledRead(part.name ?? "file"),
      })
      parts.push({ type: "text", synthetic: true, text })
      parts.push({ ...part, mime: mimeHint })
      continue
    }
    if (!uri.startsWith("file:")) {
      parts.push({
        ...part,
        mime: mimeHint ?? (uri.match(/^data:([^;,]+)[;,]/i)?.[1] || "application/octet-stream"),
      })
      continue
    }

    const filepath = filePathFromUri(uri)
    const exists = yield* fs.existsSafe(filepath)
    const isDir = exists ? yield* fs.isDir(filepath) : false
    const mime = isDir ? "application/x-directory" : (mimeHint ?? FSUtil.mimeType(filepath))

    if (!exists) {
      parts.push({ type: "text", synthetic: true, text: calledRead(filepath) })
      parts.push({ type: "text", synthetic: true, text: failedRead(filepath, "file not found") })
      continue
    }

    if (mime.startsWith("image/")) {
      const bytes = yield* fs.readFile(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!bytes) {
        parts.push({ type: "text", synthetic: true, text: calledRead(filepath) })
        parts.push({ type: "text", synthetic: true, text: failedRead(filepath, "file not found") })
        continue
      }
      parts.push({
        ...part,
        mime,
        uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
      })
      continue
    }

    parts.push({ type: "text", synthetic: true, text: calledRead(filepath) })
    if (isDir) {
      const entries = yield* fs.readDirectoryEntries(filepath).pipe(Effect.catch(() => Effect.succeed([])))
      const listing = entries.map((entry) => entry.name).join("\n")
      parts.push({ type: "text", synthetic: true, text: listing })
      parts.push({ ...part, mime, uri })
      continue
    }
    const content = yield* fs.readFileStringSafe(filepath)
    if (content === undefined) {
      parts.push({ type: "text", synthetic: true, text: failedRead(filepath, "file not found") })
      continue
    }
    parts.push({ type: "text", synthetic: true, text: content })
    parts.push({ ...part, mime, uri })
  }

  return assemble(parts)
})
