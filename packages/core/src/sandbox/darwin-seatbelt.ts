export * as DarwinSeatbelt from "./darwin-seatbelt"

import type { SpawnClass } from "./linux-bwrap"
import type { ResolvedProfile } from "./profile"

export interface DarwinWrapInput {
  readonly profile: ResolvedProfile
  readonly class: SpawnClass
  readonly cwd: string
  readonly command: string
  readonly args: readonly string[]
}

export interface DarwinWrapResult {
  readonly command: string
  readonly args: string[]
  readonly seatbelt: string
}

const escapeSbpl = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

const globToRegex = (glob: string) => {
  const source = glob.replaceAll("\\", "/")
  let i = 0
  let re = ""
  while (i < source.length) {
    const char = source[i]!
    if (char === "*" && source[i + 1] === "*") {
      re += ".*"
      i += source[i + 2] === "/" ? 3 : 2
    } else if (char === "*") {
      re += "[^/]*"
      i += 1
    } else if (char === "?") {
      re += "[^/]"
      i += 1
    } else if (char === ".") {
      re += "\\."
      i += 1
    } else {
      re += char.replace(/[|\\{}()[\]^$+]/g, "\\$&")
      i += 1
    }
  }
  return re
}

export function buildSeatbelt(input: Omit<DarwinWrapInput, "command" | "args" | "cwd"> & { cwd?: string }): string {
  const { profile, class: spawnClass } = input
  const lines = ["(version 1)"]
  if (profile.defaultRead) {
    lines.push("(allow default)")
    lines.push("(deny file-write*)")
    for (const root of profile.writeRoots) {
      lines.push(`(allow file-write* (subpath "${escapeSbpl(root)}"))`)
    }
  } else {
    lines.push("(deny default)")
    lines.push("(allow process-exec)")
    lines.push("(allow process-fork)")
    lines.push("(allow sysctl-read)")
    lines.push("(allow mach-lookup)")
    lines.push("(allow signal)")
    for (const root of profile.readRoots) {
      lines.push(`(allow file-read* (subpath "${escapeSbpl(root)}"))`)
    }
    for (const root of profile.writeRoots) {
      lines.push(`(allow file-read* (subpath "${escapeSbpl(root)}"))`)
      lines.push(`(allow file-write* (subpath "${escapeSbpl(root)}"))`)
    }
  }
  for (const glob of profile.denyGlobs) {
    lines.push(`(deny file-read* file-write* (regex "${globToRegex(glob)}"))`)
  }
  if (spawnClass === "workspace-child" && profile.restrictNetwork) {
    lines.push("(deny network*)")
  }
  return `${lines.join("\n")}\n`
}

export function buildDarwinWrap(input: DarwinWrapInput): DarwinWrapResult {
  const seatbelt = buildSeatbelt(input)
  return {
    command: "sandbox-exec",
    args: ["-p", seatbelt, "--", input.command, ...input.args],
    seatbelt,
  }
}
