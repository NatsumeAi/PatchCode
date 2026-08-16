export * as McpAttachments from "./mcp-attachments"

const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export type Attachment = {
  readonly type: "file"
  readonly mime: string
  readonly url: string
  readonly filename: string
}

export type Expanded = {
  readonly text: string[]
  readonly attachments: Attachment[]
}

const base64Size = (value: string) => {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Official MCP blob rules: supported image/pdf mimes, 10MB cap, data: URLs. */
export const expand = (uri: string, contents: unknown): Expanded => {
  const items = (Array.isArray(contents) ? contents : [contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Attachment[] = []
  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string" && item.text) {
      text.push(item.text)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    if (typeof item.resource === "object" && item.resource) {
      const nested = expand(itemUri, item.resource)
      text.push(...nested.text)
      attachments.push(...nested.attachments)
    }
  }
  return { text, attachments }
}
