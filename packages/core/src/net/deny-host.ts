export * as Net from "./deny-host"

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.internal",
  "instance-data",
  "instance-data.ec2.internal",
])

const LOOPBACK_HOSTS = new Set(["localhost", "localhost.", "ip6-localhost", "ip6-loopback"])

const parseIpv4 = (value: string) => {
  const parts = value.split(".")
  if (parts.length !== 4) return undefined
  const nums = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    return n
  })
  if (nums.some((n) => n === undefined)) return undefined
  return nums as [number, number, number, number]
}

const stripBrackets = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)

const hostnameOf = (input: string) => {
  const trimmed = input.trim()
  if (trimmed.length === 0) return ""
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      return stripBrackets(new URL(trimmed).hostname).toLowerCase()
    }
  } catch {
    return ""
  }
  if (trimmed.includes("/") && !trimmed.includes("://")) {
    try {
      return stripBrackets(new URL(`https://${trimmed}`).hostname).toLowerCase()
    } catch {
      return stripBrackets(trimmed.split("/")[0] ?? "").toLowerCase()
    }
  }
  return stripBrackets(trimmed.split("/")[0]?.split(":")[0] ?? trimmed).toLowerCase()
}

const ipv4Mapped = (host: string) => {
  const match = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  return match?.[1]
}

const isLoopbackIpv4 = (octets: [number, number, number, number]) => octets[0] === 127 || octets.every((n) => n === 0)

const isLinkLocalIpv4 = (octets: [number, number, number, number]) => octets[0] === 169 && octets[1] === 254

const isLoopbackIpv6 = (host: string) => {
  const compact = host.replace(/^0+/, "") || "0"
  return host === "::1" || host === "0:0:0:0:0:0:0:1" || compact === "::1"
}

const isLinkLocalIpv6 = (host: string) => {
  const first = host.split(":")[0] ?? ""
  const n = Number.parseInt(first, 16)
  return Number.isFinite(n) && (n & 0xffc0) === 0xfe80
}

/** True when the URL or hostname must not be fetched (SSRF). No DNS lookup. */
export const denyHost = (urlOrHost: string) => {
  const host = hostnameOf(urlOrHost)
  if (host.length === 0) return true
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return true
  if (METADATA_HOSTS.has(host)) return true

  const mapped = ipv4Mapped(host)
  const ipv4 = parseIpv4(mapped ?? host)
  if (ipv4) return isLoopbackIpv4(ipv4) || isLinkLocalIpv4(ipv4)

  if (host.includes(":")) return isLoopbackIpv6(host) || isLinkLocalIpv6(host)
  return false
}
