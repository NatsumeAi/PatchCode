export * as ExecPolicyDecide from "./decide"

import path from "path"
import { Net } from "../net/deny-host"
import type { ReduceResult } from "./peel"
import { longestPrefix, type EffectName, type Policy } from "./load"

export interface DecideOptions {
  readonly sandboxProfile?: string
  readonly dontAsk?: boolean
  readonly resolve?: (argv0: string) => Promise<string>
}

export interface Decision {
  readonly effect: EffectName
  readonly reason?: string
  readonly prefixes: string[][]
}

const basename = (argv0: string) => path.basename(argv0.replace(/\\/g, "/"))

const SYSTEM_BIN = [
  /^\/bin\//,
  /^\/usr\/bin\//,
  /^\/usr\/sbin\//,
  /^\/sbin\//,
  /^\/usr\/local\/bin\//,
  /^\/opt\//,
  /^\/nix\/store\//,
]

/** Allow-rule match uses basename only for bare names and system absolute paths. */
export const argv0ForMatch = (argv0: string) => {
  const normalized = argv0.replace(/\\/g, "/")
  if (!normalized.includes("/") && !normalized.startsWith(".")) return basename(argv0)
  if (SYSTEM_BIN.some((re) => re.test(normalized))) return basename(argv0)
  return argv0
}

const rank = (effect: EffectName) => (effect === "deny" ? 2 : effect === "ask" ? 1 : 0)

const combine = (left: Decision, right: Decision): Decision =>
  rank(right.effect) > rank(left.effect)
    ? { ...right, prefixes: [...left.prefixes, ...right.prefixes] }
    : { ...left, prefixes: [...left.prefixes, ...right.prefixes] }

const isRmForceRoot = (argv: string[]) => {
  if (basename(argv[0] ?? "") !== "rm") return false
  const flags = argv.filter((token) => token.startsWith("-") && token !== "-")
  const longRecursive = flags.some((flag) => flag === "--recursive" || flag.startsWith("--recursive="))
  const longForce = flags.some((flag) => flag === "--force" || flag.startsWith("--force="))
  const letters = flags
    .filter((flag) => flag.startsWith("-") && !flag.startsWith("--"))
    .join("")
    .toLowerCase()
  const force = (letters.includes("r") || longRecursive) && (letters.includes("f") || longForce)
  const targets = argv.slice(1).filter((token) => !token.startsWith("-") || token === "-" || token === "--")
  return force && targets.some((target) => target === "/" || target === "/*")
}

const isGitResetHard = (argv: string[]) =>
  basename(argv[0] ?? "") === "git" && argv[1] === "reset" && argv.some((token) => token === "--hard")

const isRootChmodChown = (argv: string[]) => {
  const name = basename(argv[0] ?? "")
  if (name !== "chmod" && name !== "chown") return false
  return argv.some((token) => token === "/" || token === "/*")
}

const isFindExec = (argv: string[]) => basename(argv[0] ?? "") === "find" && argv.some((token) => token === "-delete" || token === "-exec")

const NETWORK_BINS = new Set(["curl", "wget", "nc", "ncat", "socat"])

const looksLikeNetTarget = (token: string) => {
  if (!token || token.startsWith("-")) return false
  if (token.startsWith("/") || token.startsWith(".")) return false
  return token.includes("://") || token.includes(".") || token.includes(":") || token.startsWith("[")
}

const isMetadataNet = (argv: string[]) => {
  if (!NETWORK_BINS.has(basename(argv[0] ?? ""))) return false
  return argv.some(
    (token) =>
      looksLikeNetTarget(token) &&
      (token.includes("169.254") || token.includes("metadata.google.internal") || Net.denyHost(token)),
  )
}

const opaqueEffect = (options: DecideOptions, reason: string, prefixes: string[][]): Decision => {
  const sandbox = options.sandboxProfile ?? "workspace"
  if (options.dontAsk || sandbox !== "off") {
    return { effect: "deny", reason, prefixes }
  }
  return { effect: "ask", reason, prefixes }
}

const pinAllows = async (argv0: string, policy: Policy, resolve?: DecideOptions["resolve"]) => {
  const name = basename(argv0)
  const pin = policy.hosts.find((host) => host.name === name)
  if (!pin) return true
  if (resolve) return pin.paths.includes(await resolve(argv0))
  if (argv0.includes("/") || argv0.includes("\\")) return pin.paths.includes(argv0)
  return true
}

const matchArgv = (argv: string[]) => argv.map((token, i) => (i === 0 ? argv0ForMatch(token) : token))

const specialDeny = (argv: string[]) =>
  isRmForceRoot(argv) || isGitResetHard(argv) || isRootChmodChown(argv) || isFindExec(argv) || isMetadataNet(argv)

const segmentDecision = async (argv: string[], policy: Policy, options: DecideOptions): Promise<Decision> => {
  const prefixes = [argv]
  if (specialDeny(argv)) {
    return { effect: "deny", reason: "builtin-special", prefixes }
  }
  const argv0 = argv[0] ?? ""
  if (!(await pinAllows(argv0, policy, options.resolve))) {
    return opaqueEffect(options, "host-pin", prefixes)
  }
  const resolved = options.resolve ? await options.resolve(argv0) : argv0
  const matchTokens = argv.map((token, i) => (i === 0 ? argv0ForMatch(resolved) : token))
  const rule = longestPrefix(matchTokens, policy.rules)
  if (!rule) return { effect: options.dontAsk ? "deny" : "ask", prefixes }
  return { effect: rule.effect, reason: rule.reason, prefixes }
}

export const decide = (
  policy: Policy,
  reduced: ReduceResult,
  options: DecideOptions = {},
): Decision => {
  if (reduced.tag === "deny-wrapper") {
    return { effect: "deny", reason: `wrapper:${reduced.argv0}`, prefixes: [[reduced.argv0]] }
  }
  if (reduced.tag === "opaque") {
    return opaqueEffect(options, reduced.reason ?? "opaque", [[reduced.source]])
  }
  let acc: Decision = { effect: "allow", prefixes: [] }
  for (const segment of reduced.segments) {
    acc = combine(acc, decideSegmentSync(segment, policy, options))
  }
  return acc
}

const decideSegmentSync = (argv: string[], policy: Policy, options: DecideOptions): Decision => {
  const prefixes = [argv]
  if (specialDeny(argv)) {
    return { effect: "deny", reason: "builtin-special", prefixes }
  }
  const argv0 = argv[0] ?? ""
  const name = basename(argv0)
  const pin = policy.hosts.find((host) => host.name === name)
  if (pin && (argv0.includes("/") || argv0.includes("\\"))) {
    if (!pin.paths.includes(argv0)) {
      return opaqueEffect(options, "host-pin", prefixes)
    }
  }
  const rule = longestPrefix(matchArgv(argv), policy.rules)
  if (!rule) return { effect: options.dontAsk ? "deny" : "ask", prefixes }
  return { effect: rule.effect, reason: rule.reason, prefixes }
}

export const decideAsync = async (
  policy: Policy,
  reduced: ReduceResult,
  options: DecideOptions = {},
): Promise<Decision> => {
  if (reduced.tag !== "segments") return decide(policy, reduced, options)
  let acc: Decision = { effect: "allow", prefixes: [] }
  for (const segment of reduced.segments) {
    acc = combine(acc, await segmentDecision(segment, policy, options))
  }
  return acc
}
