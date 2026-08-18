export * as Net from "./deny-host"

import dns from "node:dns/promises"

export const METADATA_HOSTS = [
  "metadata.google.internal",
  "metadata.goog",
  "metadata.internal",
  "instance-data",
  "instance-data.ec2.internal",
] as const

const METADATA_HOST_SET = new Set<string>(METADATA_HOSTS)

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

/** RFC1918 + documentation/benchmark ranges used in SSRF. */
const isPrivateIpv4 = (octets: [number, number, number, number]) => {
  if (octets[0] === 10) return true
  if (octets[0] === 192 && octets[1] === 168) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  return false
}

const isLoopbackIpv6 = (host: string) => {
  const compact = host.replace(/^0+/, "") || "0"
  return host === "::1" || host === "0:0:0:0:0:0:0:1" || compact === "::1"
}

const isLinkLocalIpv6 = (host: string) => {
  const first = host.split(":")[0] ?? ""
  const n = Number.parseInt(first, 16)
  return Number.isFinite(n) && (n & 0xffc0) === 0xfe80
}

const isUniqueLocalIpv6 = (host: string) => {
  const first = host.split(":")[0] ?? ""
  const n = Number.parseInt(first, 16)
  return Number.isFinite(n) && (n & 0xfe00) === 0xfc00
}

const deniedIpv4 = (octets: [number, number, number, number]) =>
  isLoopbackIpv4(octets) || isLinkLocalIpv4(octets) || isPrivateIpv4(octets)

const deniedIpv6 = (host: string) => isLoopbackIpv6(host) || isLinkLocalIpv6(host) || isUniqueLocalIpv6(host)

const denyResolved = (host: string) => {
  if (host.length === 0) return false
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return true
  if (METADATA_HOST_SET.has(host)) return true
  const mapped = ipv4Mapped(host)
  const ipv4 = parseIpv4(mapped ?? host)
  if (ipv4) return deniedIpv4(ipv4)
  if (host.includes(":")) return deniedIpv6(host)
  return false
}

/** True when the URL or hostname must not be fetched (SSRF). No DNS lookup. Empty is not a host. */
export const denyHost = (urlOrHost: string) => denyResolved(hostnameOf(urlOrHost))

/** Check a DNS A/AAAA string (including bare IPv6) against the same SSRF rules. */
export const denyAddress = (address: string) => denyResolved(stripBrackets(address.trim()).toLowerCase())

export class DeniedUrl extends Error {
  readonly _tag = "Net.DeniedUrl"
  constructor(readonly href: string) {
    super(`URL is not allowed: ${href}`)
    this.name = "DeniedUrl"
  }
}

export type LookupAll = (hostname: string) => Promise<readonly string[]>

const defaultLookup: LookupAll = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

let lookupAll: LookupAll = defaultLookup

/** Test-only DNS injection. Pass `undefined` to restore the platform resolver. */
export function setLookupForTest(fn?: LookupAll) {
  lookupAll = fn ?? defaultLookup
}

const isLiteralIp = (host: string) => {
  if (ipv4Mapped(host) || parseIpv4(host)) return true
  return host.includes(":")
}

export type GuardedUrl = {
  readonly url: URL
  readonly addresses: readonly string[]
}

/**
 * Static denyHost plus DNS pin: every A/AAAA is re-checked against the same
 * private / loopback / link-local / metadata rules. Redirect hops must call this again.
 */
export async function guardUrl(urlOrHost: string, lookup: LookupAll = lookupAll): Promise<GuardedUrl> {
  let url: URL
  try {
    url = new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`)
  } catch {
    throw new DeniedUrl(urlOrHost)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http:// or https://")
  }
  if (denyHost(url.href) || denyHost(url.hostname)) {
    throw new DeniedUrl(url.href)
  }
  const host = url.hostname
  if (isLiteralIp(host)) {
    return { url, addresses: [host] }
  }
  let addresses: readonly string[]
  try {
    addresses = await lookup(host)
  } catch {
    throw new DeniedUrl(url.href)
  }
  if (addresses.length === 0) throw new DeniedUrl(url.href)
  for (const address of addresses) {
    if (denyAddress(address) || denyHost(address)) {
      throw new DeniedUrl(url.href)
    }
  }
  return { url, addresses }
}
