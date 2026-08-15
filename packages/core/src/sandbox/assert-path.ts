export * as SandboxAssertPath from "./assert-path"

import path from "node:path"
import { globMatchAny, type ResolvedProfile, underAny } from "./profile"

export type PathOp = "read" | "write" | "rename"

export type PathDecision = { readonly _tag: "Allow" } | { readonly _tag: "Deny"; readonly reason: string }

export const Allow: PathDecision = { _tag: "Allow" }

export const Deny = (reason: string): PathDecision => ({ _tag: "Deny", reason })

const normalize = (value: string) => path.resolve(value)

export function assertPath(profile: ResolvedProfile, op: PathOp, target: string): PathDecision {
  if (profile.name === "off") return Allow
  const resolved = normalize(target)
  const denied = globMatchAny(profile.denyGlobs, resolved)
  if (denied) {
    const excepted = profile.denyExceptions.length > 0 && globMatchAny(profile.denyExceptions, resolved)
    if (!excepted) return Deny("denied")
  }
  if (op === "write" || op === "rename") {
    if (!underAny(profile.writeRoots, resolved)) return Deny("write_outside")
  }
  if (op === "read" && !profile.defaultRead) {
    if (!underAny(profile.readRoots, resolved)) return Deny("read_outside")
  }
  return Allow
}
