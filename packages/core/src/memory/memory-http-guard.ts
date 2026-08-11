/**
 * Guards for experimental memory HTTP mutations when the server has no
 * OPENCODE_SERVER_PASSWORD. Unauthenticated servers still accept local TUI/CLI
 * (loopback) but reject non-loopback peers so random network clients cannot
 * rewrite memory without a password.
 *
 * When a server password *is* configured, Authorization middleware already
 * gates all experimental APIs — this guard is a no-op in that case.
 */

export function isLoopbackAddress(remote: string | undefined | null): boolean {
  if (!remote) return false
  const host = remote.replace(/^::ffff:/i, "").split("%")[0]!.toLowerCase()
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "0:0:0:0:0:0:0:1"
  )
}

/**
 * True when a mutating memory request is allowed without Basic Auth.
 * - Password configured → always true (caller still relies on Authorization).
 * - No password → only loopback (or explicit OPENCODE_MEMORY_HTTP_OPEN=1).
 */
export function allowUnauthedMemoryMutation(input: {
  readonly passwordConfigured: boolean
  readonly remoteAddress?: string | null
}): boolean {
  if (input.passwordConfigured) return true
  // Explicit opt-in for non-local unauthenticated memory HTTP (dangerous).
  if (process.env.OPENCODE_MEMORY_HTTP_OPEN === "1") return true
  // No peer address (in-process test server, unix socket) → treat as local.
  if (!input.remoteAddress) return true
  return isLoopbackAddress(input.remoteAddress)
}
