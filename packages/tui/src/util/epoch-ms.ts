/**
 * Coerce event / part timestamps (epoch ms | seconds | ISO | DateTime-like) to epoch ms.
 * Shared by sync bridge, part-order, and v2-message-bridge so ordering stays consistent.
 */
export function toEpochMs(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: unix seconds → ms
    if (value > 1e9 && value < 1e12) return Math.round(value * 1000)
    return value
  }
  if (typeof value === "string" && value.length > 0) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) {
      const n = Number(value)
      if (Number.isFinite(n)) return toEpochMs(n)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (value != null && typeof value === "object") {
    const o = value as { epochMilliseconds?: unknown; epochMillis?: unknown }
    if (typeof o.epochMilliseconds === "number") return toEpochMs(o.epochMilliseconds)
    if (typeof o.epochMillis === "number") return toEpochMs(o.epochMillis)
  }
  return null
}

export function toEpochMsOr(value: unknown, fallback: number): number {
  return toEpochMs(value) ?? fallback
}
