import type { ToolPart } from "@opencode-ai/sdk/v2"

/** Safe string coerce for tool input/metadata fields. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function inputOf(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

export function metadataOf(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

/**
 * File path on tool input. Runtime tools use `path`; dual-write / older parts
 * may still carry `filePath` — accept both without preferring legacy names.
 */
export function toolPath(inp: Record<string, unknown>): string {
  const p = str(inp.path) ?? str(inp.filePath)
  return p && p.length > 0 ? p : ""
}

/** Completed/error text payload: state.output, else metadata.output. */
export function toolOutputText(part: ToolPart): string {
  if (part.state.status === "completed" || part.state.status === "error") {
    const fromState = str((part.state as { output?: unknown }).output)
    if (fromState) return fromState
  }
  return str(metadataOf(part).output) ?? ""
}

/**
 * Extract a unified-diff string + path from settled tool metadata.
 * Runtime edit structured: { files: [{ file, patch, ... }], replacements }
 */
export function toolDiffFromMeta(meta: Record<string, unknown>, fallbackPath: string): {
  diff: string
  path: string
} | null {
  const direct = str(meta.diff)
  if (direct) return { diff: direct, path: fallbackPath }

  const filediff = record(meta.filediff)
  if (filediff) {
    const patch = str(filediff.patch)
    if (patch) return { diff: patch, path: str(filediff.file) ?? fallbackPath }
  }

  const files = meta.files
  if (Array.isArray(files)) {
    for (const item of files) {
      const f = record(item)
      if (!f) continue
      const patch = str(f.patch)
      if (patch) return { diff: patch, path: str(f.file) ?? str(f.filePath) ?? fallbackPath }
    }
  }

  return null
}

/**
 * File body text from read tool structured output:
 * - Content: { content, encoding: "utf8" | "base64", ... }
 * - TextPage: { type: "text-page", content, ... }
 * - ListPage: { entries: Entry[] }
 */
export function readBodyFromMeta(meta: Record<string, unknown>):
  | { kind: "text"; text: string }
  | { kind: "lines"; lines: string[] }
  | null {
  const encoding = str(meta.encoding)
  // Skip binary / image payloads
  if (encoding === "base64") return null

  const content = str(meta.content)
  if (content) return { kind: "text", text: content }

  if (Array.isArray(meta.entries)) {
    const lines: string[] = []
    for (const entry of meta.entries) {
      const e = record(entry)
      if (!e) continue
      const p = str(e.path) ?? str(e.name)
      if (p) lines.push(p)
    }
    if (lines.length > 0) return { kind: "lines", lines }
  }

  // Array structured wrapped as { value: Match[] } (grep when array→record)
  if (Array.isArray(meta.value)) {
    const lines: string[] = []
    for (const item of meta.value) {
      const m = record(item)
      if (!m) continue
      const entry = record(m.entry)
      const path = entry ? str(entry.path) : undefined
      const line = typeof m.line === "number" ? m.line : undefined
      const text = str(m.text) ?? ""
      if (path != null && line != null) lines.push(`${path}:${line}: ${text}`)
      else if (path) lines.push(path)
    }
    if (lines.length > 0) return { kind: "lines", lines }
  }

  return null
}

export function matchCountFromMeta(meta: Record<string, unknown>, output: string): number | undefined {
  const direct = num(meta.matches) ?? num(meta.count)
  if (direct != null) return direct
  if (Array.isArray(meta.value)) return meta.value.length
  if (Array.isArray(meta.files)) return meta.files.length
  const m = output.match(/Found (\d+) matches?/i)
  if (m) return Number(m[1])
  return undefined
}
