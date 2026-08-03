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

/** Format milliseconds as human-readable duration (e.g. "2.1s", "1m30s"). */
export function formatDuration(ms: number): string {
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
