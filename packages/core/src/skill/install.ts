export * as SkillInstall from "./install"

import { inflateRawSync } from "node:zlib"
import fs from "node:fs/promises"
import path from "node:path"
import { ConfigMarkdown } from "../config/markdown"
import { denyHost } from "../net/deny-host"
import { AbsolutePath } from "../schema"
import { SkillLock } from "./lock"

export type QuarantineResult = {
  readonly name: string
  readonly state: "quarantine"
  readonly sha256: string
  readonly directory: string
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function rejectReason(uri: string): string | undefined {
  const trimmed = uri.trim()
  if (trimmed.startsWith("file:")) return "file: skill install is rejected"
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return `Invalid skill URI: ${trimmed}`
  }
  if (parsed.protocol !== "https:") return "skill_install only accepts https URLs"
  if (denyHost(trimmed) || denyHost(parsed.hostname) || denyHost(parsed.host)) {
    return `Skill host is not allowed: ${trimmed}`
  }
  return undefined
}

const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)

const readU16 = (bytes: Uint8Array, offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8)
const readU32 = (bytes: Uint8Array, offset: number) =>
  (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0

const safeJoin = (root: string, rel: string) => {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "")
  if (cleaned.includes("..") || path.isAbsolute(cleaned)) throw new Error("zip-slip path rejected")
  const dest = path.resolve(root, cleaned)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (dest !== root && !dest.startsWith(prefix)) throw new Error("zip-slip path rejected")
  return dest
}

export const extractZip = async (bytes: Uint8Array, dest: string) => {
  await fs.mkdir(dest, { recursive: true })
  let offset = 0
  const decoder = new TextDecoder()
  while (offset + 30 <= bytes.length) {
    if (readU32(bytes, offset) !== 0x04034b50) break
    const flags = readU16(bytes, offset + 6)
    const method = readU16(bytes, offset + 8)
    const compressed = readU32(bytes, offset + 18)
    const nameLen = readU16(bytes, offset + 26)
    const extraLen = readU16(bytes, offset + 28)
    const nameStart = offset + 30
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen))
    const dataStart = nameStart + nameLen + extraLen
    if (flags & 0x8) throw new Error("zip data descriptors are not supported")
    const data = bytes.subarray(dataStart, dataStart + compressed)
    offset = dataStart + compressed
    if (name.endsWith("/")) {
      await fs.mkdir(safeJoin(dest, name), { recursive: true })
      continue
    }
    const out = safeJoin(dest, name)
    await fs.mkdir(path.dirname(out), { recursive: true })
    if (method === 0) await fs.writeFile(out, data)
    else if (method === 8) await fs.writeFile(out, inflateRawSync(data))
    else throw new Error(`unsupported zip method ${method}`)
  }
}

const asBytes = (body: string | Uint8Array) => (typeof body === "string" ? new TextEncoder().encode(body) : body)

export async function quarantine(input: {
  readonly uri: string
  readonly body: string | Uint8Array
  readonly configDir: string
}): Promise<QuarantineResult> {
  const uri = input.uri.trim()
  const denied = rejectReason(uri)
  if (denied) throw new Error(denied)
  const parsed = new URL(uri)
  const bytes = asBytes(input.body)
  const nameFromUri = path.basename(parsed.pathname).replace(/\.(md|zip|tgz|tar\.gz)$/i, "") || "skill"
  if (isZip(bytes)) {
    const staging = path.join(SkillLock.skillsDir(input.configDir), `.staging-${Date.now()}`)
    await extractZip(bytes, staging)
    const skillMd =
      (await fs.readFile(path.join(staging, "SKILL.md"), "utf8").catch(() => undefined)) ??
      (await fs.readFile(path.join(staging, "skill.md"), "utf8").catch(() => undefined))
    if (!skillMd) {
      await fs.rm(staging, { recursive: true, force: true })
      throw new Error("Skill archive is missing SKILL.md")
    }
    const markdown = ConfigMarkdown.parseOption(skillMd)
    const fm = (markdown?.data ?? {}) as { name?: unknown }
    const skillName = typeof fm.name === "string" && fm.name.trim().length > 0 ? fm.name.trim() : nameFromUri
    if (!NAME_RE.test(skillName)) {
      await fs.rm(staging, { recursive: true, force: true })
      throw new Error(`Invalid skill name: ${skillName}`)
    }
    const directory = path.join(SkillLock.skillsDir(input.configDir), skillName)
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rename(staging, directory)
    const sha256 = SkillLock.hashText(skillMd)
    await SkillLock.upsert(
      {
        name: skillName,
        source: "url",
        uri,
        sha256,
        installedAt: Date.now(),
        state: "quarantine",
      },
      input.configDir,
    )
    return { name: skillName, state: "quarantine", sha256, directory: AbsolutePath.make(directory) }
  }

  const text = typeof input.body === "string" ? input.body : new TextDecoder().decode(bytes)
  const markdown = ConfigMarkdown.parseOption(text)
  if (!markdown) throw new Error("Skill install did not return markdown")
  const fm = markdown.data as { name?: unknown }
  const skillName = typeof fm.name === "string" && fm.name.trim().length > 0 ? fm.name.trim() : nameFromUri
  if (!NAME_RE.test(skillName)) throw new Error(`Invalid skill name: ${skillName}`)
  const directory = path.join(SkillLock.skillsDir(input.configDir), skillName)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "SKILL.md"), text, "utf8")
  const sha256 = SkillLock.hashText(text)
  await SkillLock.upsert(
    {
      name: skillName,
      source: "url",
      uri,
      sha256,
      installedAt: Date.now(),
      state: "quarantine",
    },
    input.configDir,
  )
  return {
    name: skillName,
    state: "quarantine",
    sha256,
    directory: AbsolutePath.make(directory),
  }
}
