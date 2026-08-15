export * as SandboxProfile from "./profile"

import path from "node:path"

export const DEFAULT_DENY_GLOBS = [
  "**/.ssh",
  "**/.gnupg",
  "**/.aws",
  "**/.netrc",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
] as const

export const DEFAULT_DENY_EXCEPTIONS = ["**/.env.example"] as const

export const BUILTIN_NAMES = ["off", "workspace", "read-only", "strict"] as const
export type BuiltinName = (typeof BUILTIN_NAMES)[number]

export const GLOB_OVERFLOW = 8192

export interface PathContext {
  readonly location: string
  readonly home: string
  readonly tmp: string
  readonly opencodeTmp: string
  readonly data?: string
  readonly cache?: string
  readonly config?: string
  readonly state?: string
}

export interface ResolvedProfile {
  readonly name: string
  /** When true, reads are unrestricted except deny globs (workspace / read-only). */
  readonly defaultRead: boolean
  readonly readRoots: string[]
  readonly writeRoots: string[]
  readonly denyGlobs: string[]
  readonly denyExceptions: string[]
  readonly restrictNetwork: boolean
}

export interface CustomProfileSpec {
  readonly extends?: string
  readonly restrict_network?: boolean
  readonly deny?: string[]
  readonly read_write?: string[]
}

const slash = (value: string) => value.replaceAll("\\", "/")

const unique = (values: Array<string | undefined>) => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value) continue
    const resolved = path.resolve(value)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}

const escapeRegex = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")

/** Gitignore-style glob: `* ? ** [abc]`. No braces. */
export function globToRegExp(pattern: string): RegExp {
  const source = slash(pattern)
  let i = 0
  let re = "^"
  while (i < source.length) {
    const char = source[i]!
    if (char === "*") {
      if (source[i + 1] === "*") {
        if (source[i + 2] === "/") {
          re += "(?:.*/)?"
          i += 3
        } else {
          re += ".*"
          i += 2
        }
      } else {
        re += "[^/]*"
        i += 1
      }
    } else if (char === "?") {
      re += "[^/]"
      i += 1
    } else if (char === "[") {
      const end = source.indexOf("]", i + 1)
      if (end === -1) {
        re += "\\["
        i += 1
      } else {
        re += source.slice(i, end + 1)
        i = end + 1
      }
    } else {
      re += escapeRegex(char)
      i += 1
    }
  }
  re += "$"
  return new RegExp(re)
}

export function globMatch(pattern: string, filepath: string): boolean {
  const normalized = slash(path.resolve(filepath))
  const rel = normalized.startsWith("/") ? normalized.slice(1) : normalized
  const candidates = [normalized, rel, slash(filepath)]
  const re = globToRegExp(pattern)
  return candidates.some((candidate) => re.test(candidate))
}

export function globMatchAny(patterns: readonly string[], filepath: string): boolean {
  const normalized = path.resolve(filepath)
  const chain = [normalized]
  let current = normalized
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) break
    chain.push(parent)
    current = parent
  }
  for (const candidate of chain) {
    for (const pattern of patterns) {
      if (globMatch(pattern, candidate)) return true
    }
  }
  return false
}

export function underRoot(root: string, candidate: string): boolean {
  const parent = path.resolve(root)
  const child = path.resolve(candidate)
  if (parent === child) return true
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep
  return child.startsWith(prefix)
}

export function underAny(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => underRoot(root, candidate))
}

const STRICT_READ = ["/bin", "/sbin", "/usr", "/etc", "/lib", "/lib64", "/dev", "/proc", "/nix/store"]

export function builtInProfile(name: string, ctx: PathContext): ResolvedProfile {
  const denyGlobs = [...DEFAULT_DENY_GLOBS]
  const denyExceptions = [...DEFAULT_DENY_EXCEPTIONS]
  const opencodePaths = unique([ctx.data, ctx.cache, ctx.config, ctx.state, ctx.opencodeTmp])
  const tmpRoots = unique([ctx.tmp, ctx.opencodeTmp, "/tmp", "/var/tmp"])

  if (name === "off") {
    return {
      name,
      defaultRead: true,
      readRoots: [],
      writeRoots: [],
      denyGlobs: [],
      denyExceptions: [],
      restrictNetwork: false,
    }
  }

  if (name === "workspace") {
    return {
      name,
      defaultRead: true,
      readRoots: ["/"],
      writeRoots: unique([ctx.location, ...opencodePaths, ...tmpRoots]),
      denyGlobs,
      denyExceptions,
      restrictNetwork: false,
    }
  }

  if (name === "read-only") {
    return {
      name,
      defaultRead: true,
      readRoots: ["/"],
      writeRoots: unique([...opencodePaths, ...tmpRoots]),
      denyGlobs,
      denyExceptions,
      restrictNetwork: true,
    }
  }

  if (name === "strict") {
    return {
      name,
      defaultRead: false,
      readRoots: unique([ctx.location, ...STRICT_READ]),
      writeRoots: unique([ctx.location, ctx.opencodeTmp]),
      denyGlobs,
      denyExceptions,
      restrictNetwork: true,
    }
  }

  return builtInProfile("strict", ctx)
}

export function mergeCustom(
  spec: CustomProfileSpec,
  ctx: PathContext,
  builtins: (name: string, ctx: PathContext) => ResolvedProfile = builtInProfile,
): ResolvedProfile {
  const baseName = spec.extends && BUILTIN_NAMES.includes(spec.extends as BuiltinName) ? spec.extends : "workspace"
  const base = builtins(baseName, ctx)
  const deny = [...base.denyGlobs, ...(spec.deny ?? [])]
  const writeRoots = unique([...base.writeRoots, ...(spec.read_write ?? [])])
  return {
    ...base,
    name: spec.extends ? `${spec.extends}+custom` : base.name,
    writeRoots,
    denyGlobs: deny,
    restrictNetwork: spec.restrict_network ?? base.restrictNetwork,
  }
}

const PROFILE_HEADER = /^\[profiles\.([A-Za-z0-9_-]+)\]\s*$/

/** Minimal TOML subset for `sandbox.toml` profile tables. */
export function parseSandboxToml(text: string): Record<string, CustomProfileSpec> {
  const profiles: Record<string, CustomProfileSpec> = {}
  let current: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim()
    if (!line) continue
    const header = line.match(PROFILE_HEADER)
    if (header) {
      current = header[1]
      profiles[current] = profiles[current] ?? {}
      continue
    }
    if (!current) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    const spec = profiles[current]!
    if (key === "extends") spec.extends = unquote(value)
    else if (key === "restrict_network") spec.restrict_network = value === "true"
    else if (key === "deny" || key === "read_write") {
      spec[key] = parseStringArray(value)
    }
  }
  return profiles
}

function unquote(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseStringArray(value: string): string[] {
  const inner = value.trim()
  if (!inner.startsWith("[") || !inner.endsWith("]")) return []
  return inner
    .slice(1, -1)
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean)
}

export function isBuiltin(name: string): name is BuiltinName {
  return (BUILTIN_NAMES as readonly string[]).includes(name)
}
