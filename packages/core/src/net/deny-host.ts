export * as Net from "./deny-host"

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.internal",
  "instance-data",
  "instance-data.ec2.internal",
])

const LOOPBACK_HOSTS = new Set(["localhost", "localhost.", "ip6-localhost", "ip6-loopback"])

const parseOctet = (part: string) => {
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const n = Number.parseInt(part.slice(2), 16)
    return Number.isFinite(n) && n <= 255 ? n : undefined
  }
  if (!/^\d{1,10}$/.test(part)) return undefined
  const n = Number(part)
  if (n > 255) return undefined
  return n
}

/** inet_aton-style IPv4, including 127.1 and hex octets. */
const parseIpv4 = (value: string) => {
  if (/^0x[0-9a-f]+$/i.test(value) && !value.includes(".")) {
    const n = Number.parseInt(value.slice(2), 16)
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return undefined
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255] as [number, number, number, number]
  }
  const parts = value.split(".")
  if (parts.length === 0 || parts.length > 4) return undefined
  if (parts.length === 4) {
    const nums = parts.map(parseOctet)
    if (nums.some((n) => n === undefined)) return undefined
    return nums as [number, number, number, number]
  }
  if (parts.length === 1) {
    const n = Number(parts[0])
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return undefined
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255] as [number, number, number, number]
  }
  if (parts.length === 2) {
    const a = parseOctet(parts[0] ?? "")
    const rest = Number(parts[1])
    if (a === undefined || !Number.isFinite(rest) || rest < 0 || rest > 0xffffff) return undefined
    return [a, (rest >>> 16) & 255, (rest >>> 8) & 255, rest & 255] as [number, number, number, number]
  }
  const a = parseOctet(parts[0] ?? "")
  const b = parseOctet(parts[1] ?? "")
  const rest = Number(parts[2])
  if (a === undefined || b === undefined || !Number.isFinite(rest) || rest < 0 || rest > 0xffff) return undefined
  return [a, b, (rest >>> 8) & 255, rest & 255] as [number, number, number, number]
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

/** True when the URL or hostname must not be fetched (SSRF). No DNS lookup. Empty is not a host. */
export const denyHost = (urlOrHost: string) => {
  const host = hostnameOf(urlOrHost)
  if (host.length === 0) return false
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return true
  if (METADATA_HOSTS.has(host)) return true

  const mapped = ipv4Mapped(host)
  const ipv4 = parseIpv4(mapped ?? host)
  if (ipv4) return isLoopbackIpv4(ipv4) || isLinkLocalIpv4(ipv4)

  if (host.includes(":")) return isLoopbackIpv6(host) || isLinkLocalIpv6(host)
  return false
}
