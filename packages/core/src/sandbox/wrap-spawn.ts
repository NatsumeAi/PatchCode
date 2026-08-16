export * as SandboxWrapSpawn from "./wrap-spawn"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { glob as scanGlob } from "glob"
import { buildDarwinWrap } from "./darwin-seatbelt"
import type { SpawnClass } from "./linux-bwrap"
import { buildLinuxWrap } from "./linux-bwrap"
import { GLOB_OVERFLOW, globMatchAny } from "./profile"
import {
  ensureBackend,
  lookupBwrap,
  pathContext,
  resolvePinned,
} from "./resolve"
import { Denied, GlobOverflow, Unavailable, Unsupported } from "./windows"

export type { SpawnClass }

export interface WrapSpawnInput {
  readonly class: SpawnClass
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly sessionID?: string
  readonly profileName?: string
  readonly whenUnpinned?: "off" | "location"
  readonly location?: string
  readonly bwrapPath?: string
  readonly platform?: string
  readonly home?: string
}

export interface WrapSpawnResult {
  readonly command: string
  readonly args: string[]
}

export type WrapSpawnError = Unavailable | Unsupported | Denied | GlobOverflow

const exists = (file: string) => {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

const isDir = (file: string) => {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

const HOME_DENY_NAMES = [".ssh", ".gnupg", ".aws", ".netrc", ".env"]
const HOME_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".local",
  ".npm",
  ".nvm",
  "Library",
  ".cargo",
  ".rustup",
  "go",
  "snap",
])
const HOME_SECRET_RE = /\.(pem|key)$|(?:^|\/)\.env\.[^/]+$/
const HOME_SECRET_DEPTH = 3
const SKIPPED_SECRET_DEPTH = 5
const SKIPPED_TREE_NAMES = new Set(["node_modules", ".git", ".cache"])

const walkHomeSecrets = (root: string, add: (resolved: string) => void, depth = 0) => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth >= HOME_SECRET_DEPTH) continue
      if (HOME_SKIP_DIRS.has(entry.name)) continue
      walkHomeSecrets(full, add, depth + 1)
      continue
    }
    if (HOME_SECRET_RE.test(entry.name) || HOME_SECRET_RE.test(full.replaceAll("\\", "/"))) add(path.resolve(full))
  }
}

const walkCustomHome = (
  root: string,
  add: (resolved: string) => void,
  globs: readonly string[],
  depth = 0,
) => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue
    const full = path.join(root, entry.name)
    if (globMatchAny(globs, full)) add(path.resolve(full))
    if (entry.isDirectory()) {
      if (depth >= 6) continue
      if (entry.name === "node_modules" || entry.name === ".git") continue
      walkCustomHome(full, add, globs, depth + 1)
    }
  }
}

const walkSecretsInTree = (root: string, add: (resolved: string) => void, depth = 0) => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth >= SKIPPED_SECRET_DEPTH) continue
      walkSecretsInTree(full, add, depth + 1)
      continue
    }
    if (HOME_SECRET_RE.test(entry.name) || HOME_DENY_NAMES.includes(entry.name)) add(path.resolve(full))
  }
}

const walkSkippedSecretTrees = (root: string, add: (resolved: string) => void, depth = 0) => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    if (SKIPPED_TREE_NAMES.has(entry.name)) {
      walkSecretsInTree(full, add)
      continue
    }
    if (depth >= 4) continue
    if (HOME_SKIP_DIRS.has(entry.name) && entry.name !== ".cache") continue
    walkSkippedSecretTrees(full, add, depth + 1)
  }
}

export async function expandDenyGlobs(input: {
  readonly globs: readonly string[]
  readonly roots: readonly string[]
  readonly home?: string
  readonly cap?: number
  readonly exceptions?: readonly string[]
}): Promise<{ files: string[]; dirs: string[] }> {
  const cap = input.cap ?? GLOB_OVERFLOW
  const exceptions = input.exceptions ?? []
  const files: string[] = []
  const dirs: string[] = []
  const seen = new Set<string>()
  const add = (resolved: string) => {
    if (seen.has(resolved)) return
    if (exceptions.length > 0 && globMatchAny(exceptions, resolved)) return
    seen.add(resolved)
    if (seen.size > cap) throw new GlobOverflow({ profile: "deny", hits: seen.size })
    if (isDir(resolved)) dirs.push(resolved)
    else files.push(resolved)
  }

  for (const root of input.roots) {
    if (!exists(root) || !isDir(root)) continue
    const resolvedRoot = path.resolve(root)
    const isExtraHome =
      input.home !== undefined &&
      resolvedRoot === path.resolve(input.home) &&
      resolvedRoot !== path.resolve(input.roots[0] ?? "")
    if (isExtraHome) {
      for (const name of HOME_DENY_NAMES) {
        const candidate = path.join(root, name)
        if (exists(candidate)) add(path.resolve(candidate))
      }
      walkHomeSecrets(root, add)
      walkCustomHome(root, add, input.globs)
      continue
    }
    for (const pattern of input.globs) {
      const hits = (await scanGlob(pattern, {
        cwd: root,
        absolute: true,
        dot: true,
        nodir: false,
        ignore: ["**/node_modules/**", "**/.git/**", "**/.cache/**"],
      })) as string[]
      for (const hit of hits) add(path.resolve(hit))
    }
    walkSkippedSecretTrees(root, add)
  }
  return { files, dirs }
}

export async function wrapSpawn(input: WrapSpawnInput): Promise<WrapSpawnResult> {
  const platform = input.platform ?? process.platform
  const location = path.resolve(input.location ?? input.cwd)
  const resolved = await resolvePinned({
    sessionID: input.sessionID,
    profileName: input.profileName,
    location,
    whenUnpinned: input.whenUnpinned ?? (platform === "win32" ? "off" : "location"),
    platform,
  })
  if (resolved.profile.name === "off") {
    return { command: input.command, args: [...input.args] }
  }
  ensureBackend(resolved.profile.name, platform, input.bwrapPath)
  if (platform === "win32") {
    throw new Unsupported({ platform: "win32", profile: resolved.profile.name })
  }

  const ctx = pathContext(location, input.home ?? os.homedir())
  const expandRoots = [location, ctx.home].filter((root, index, all) => all.indexOf(root) === index)
  const denied = await expandDenyGlobs({
    globs: resolved.profile.denyGlobs,
    exceptions: resolved.profile.denyExceptions,
    roots: expandRoots,
    home: ctx.home,
  })

  if (platform === "darwin") {
    return buildDarwinWrap({
      profile: resolved.profile,
      class: input.class,
      cwd: path.resolve(input.cwd),
      command: input.command,
      args: input.args,
    })
  }

  const bwrapPath = input.bwrapPath ?? lookupBwrap()
  if (!bwrapPath || !exists(bwrapPath)) {
    throw new Unavailable({ profile: resolved.profile.name, backend: "bwrap", reason: "unavailable" })
  }
  const binary = bwrapPath
  return buildLinuxWrap({
    profile: resolved.profile,
    class: input.class,
    cwd: path.resolve(input.cwd),
    command: input.command,
    args: input.args,
    bwrapPath: binary,
    deniedFiles: denied.files,
    deniedDirs: denied.dirs,
  })
}
