export * as SandboxResolve from "./resolve"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "../global"
import { Trust } from "../trust"
import { which } from "../util/which"
import {
  builtInProfile,
  isBuiltin,
  mergeCustom,
  parseSandboxToml,
  type CustomProfileSpec,
  type PathContext,
  type ResolvedProfile,
} from "./profile"
import { Unavailable, Unsupported, windowsRefuse } from "./windows"
import { loadSeccompBpf } from "./linux-seccomp"

const pins = new Map<string, string>()

export function pinSession(sessionID: string, profile: string) {
  pins.set(sessionID, profile)
}

export function pinnedProfile(sessionID: string | undefined): string | undefined {
  if (!sessionID) return undefined
  return pins.get(sessionID)
}

export function pathContext(location: string, home = process.env.OPENCODE_TEST_HOME ?? os.homedir()): PathContext {
  return {
    location: path.resolve(location),
    home,
    tmp: os.tmpdir(),
    opencodeTmp: Global.Path.tmp,
    data: Global.Path.data,
    cache: Global.Path.cache,
    config: Global.Path.config,
    state: Global.Path.state,
  }
}

export type RequestedProfile = {
  readonly input?: string
  readonly env?: string
  readonly config?: string
  readonly parent?: string
  readonly location: string
  readonly platform?: string
  readonly trusted?: boolean
}

export function isSandboxExplicit(metadata: Record<string, unknown> | null | undefined) {
  return metadata?.sandboxExplicit === true
}

export async function defaultUnixProfile(location: string, trusted?: boolean) {
  const isTrusted = trusted ?? (await Trust.isTrusted(location))
  return isTrusted ? "workspace" : "strict"
}

export async function upgradeLegacyOffProfile(directory: string, platform = process.platform): Promise<string> {
  const name = await defaultUnixProfile(directory)
  ensureBackend(name, platform)
  return name
}

export async function resolveNewProfileName(input: RequestedProfile): Promise<string> {
  const platform = input.platform ?? process.platform
  if (input.parent) return input.parent
  if (input.input) return input.input
  const env = input.env ?? process.env.OPENCODE_SANDBOX
  if (env) return env
  if (input.config) return input.config
  if (platform === "win32") return "off"
  return defaultUnixProfile(input.location, input.trusted)
}

export function readSandboxToml(file: string): Record<string, CustomProfileSpec> {
  try {
    const text = fs.readFileSync(file, "utf8")
    return parseSandboxToml(text)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}

export async function loadCustomProfiles(location: string): Promise<{
  readonly global: Record<string, CustomProfileSpec>
  readonly project: Record<string, CustomProfileSpec>
  readonly projectTrusted: boolean
}> {
  const global = readSandboxToml(path.join(Global.Path.config, "sandbox.toml"))
  const project = readSandboxToml(path.join(location, ".opencode", "sandbox.toml"))
  const projectTrusted = await Trust.isTrusted(location)
  return { global, project, projectTrusted }
}

export async function resolveProfile(
  name: string,
  location: string,
  ctx: PathContext = pathContext(location),
): Promise<ResolvedProfile> {
  if (isBuiltin(name)) return builtInProfile(name, ctx)
  const loaded = await loadCustomProfiles(location)
  const spec = loaded.global[name] ?? loaded.project[name]
  if (!spec) {
    throw new Unavailable({ profile: name, backend: process.platform, reason: "unknown_profile" })
  }
  if (loaded.project[name] && !loaded.global[name] && !loaded.projectTrusted) {
    throw new Unavailable({ profile: name, backend: process.platform, reason: "untrusted_project_profile" })
  }
  const merged = mergeCustom(spec, ctx)
  return { ...merged, name }
}

export function lookupBwrap(explicit?: string): string | undefined {
  if (explicit) return explicit
  return which("bwrap") ?? (fs.existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : undefined)
}

export function lookupSandboxExec(): string | undefined {
  return which("sandbox-exec") ?? (fs.existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : undefined)
}

export function ensureBackend(profile: string, platform = process.platform, bwrapPath?: string) {
  if (profile === "off") return
  if (platform === "win32") throw windowsRefuse(profile)
  if (platform === "linux") {
    const resolved = bwrapPath ?? lookupBwrap()
    if (!resolved || !fs.existsSync(resolved)) {
      throw new Unavailable({ profile, backend: "bwrap", reason: "unavailable" })
    }
    if (!loadSeccompBpf()) {
      throw new Unavailable({ profile, backend: "seccomp", reason: "unavailable" })
    }
    return
  }
  if (platform === "darwin") {
    if (!lookupSandboxExec()) throw new Unavailable({ profile, backend: "sandbox-exec", reason: "unavailable" })
    return
  }
  throw new Unsupported({ platform, profile })
}

export type ResolveResult = {
  readonly name: string
  readonly profile: ResolvedProfile
  readonly location: string
}

export async function resolvePinned(input: {
  readonly sessionID?: string
  readonly profileName?: string
  readonly location: string
  readonly whenUnpinned?: "off" | "location"
  readonly platform?: string
}): Promise<ResolveResult> {
  const platform = input.platform ?? process.platform
  const whenUnpinned = input.whenUnpinned ?? (platform === "win32" ? "off" : "location")
  const name =
    input.profileName ??
    (input.sessionID ? pinnedProfile(input.sessionID) : undefined) ??
    (whenUnpinned === "location" ? await resolveNewProfileName({ location: input.location }) : "off")
  const profile = await resolveProfile(name, input.location)
  return { name, profile, location: input.location }
}
