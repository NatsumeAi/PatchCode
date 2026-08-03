/** Shorten an absolute path relative to cwd for display. */
export function shortenPath(filePath: string, cwd: string): string {
  if (!cwd || cwd === "/") return filePath
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/"
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length)
  return filePath
}

/** Truncate text to max characters, appending ellipsis if truncated. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "\u2026"
}

/** Coerce DateTime / ISO / millis into epoch ms; null if unusable. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.length > 0) {
    const asNum = Number(value)
    if (Number.isFinite(asNum) && value.trim() !== "") return asNum
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (value != null && typeof value === "object") {
    const obj = value as { epochMilliseconds?: unknown; epochMillis?: unknown }
    if (typeof obj.epochMilliseconds === "number" && Number.isFinite(obj.epochMilliseconds)) {
      return obj.epochMilliseconds
    }
    if (typeof obj.epochMillis === "number" && Number.isFinite(obj.epochMillis)) return obj.epochMillis
  }
  return null
}

/** Format milliseconds as human-readable duration (e.g. "2.1s", "1m30s"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remaining = Math.round(secs - mins * 60)
  return `${mins}m${remaining}s`
}

/** Extract filename from a path. */
export function filename(filePath: string): string {
  const idx = filePath.lastIndexOf("/")
  if (idx === -1) return filePath
  return filePath.slice(idx + 1)
}

/**
 * Coerce any value to a display string. opentui text nodes only accept
 * strings; dirty part data (objects, arrays, numbers from provider/tool
 * output) must never reach a <text> children expression.
 */
export function toText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (typeof value === "object") {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}
