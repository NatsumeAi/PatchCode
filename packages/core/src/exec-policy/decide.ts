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

const rank = (effect: EffectName) => (effect === "deny" ? 2 : effect === "ask" ? 1 : 0)

const combine = (left: Decision, right: Decision): Decision =>
  rank(right.effect) > rank(left.effect)
    ? { ...right, prefixes: [...left.prefixes, ...right.prefixes] }
    : { ...left, prefixes: [...left.prefixes, ...right.prefixes] }

const isRmForceRoot = (argv: string[]) => {
  if (basename(argv[0] ?? "") !== "rm") return false
  const flags = argv.filter((token) => token.startsWith("-") && token !== "-")
  const force = flags.some((flag) => flag.includes("r") && flag.includes("f")) || (flags.includes("-r") && flags.includes("-f"))
  const targets = argv.slice(1).filter((token) => !token.startsWith("-") || token === "-" || token === "--")
  return force && targets.some((target) => target === "/" || target === "/*")
}

const isRootChmodChown = (argv: string[]) => {
  const name = basename(argv[0] ?? "")
  if (name !== "chmod" && name !== "chown") return false
  return argv.some((token) => token === "/" || token === "/*")
}

const isFindExec = (argv: string[]) => basename(argv[0] ?? "") === "find" && argv.some((token) => token === "-delete" || token === "-exec")

const NETWORK_BINS = new Set(["curl", "wget", "nc", "ncat", "socat"])

const isMetadataNet = (argv: string[]) => {
  if (!NETWORK_BINS.has(basename(argv[0] ?? ""))) return false
  return argv.some((token) => token.includes("169.254") || token.includes("metadata.google.internal") || Net.denyHost(token))
}

const pinAllows = async (argv0: string, policy: Policy, resolve?: DecideOptions["resolve"]) => {
  const name = basename(argv0)
  const pin = policy.hosts.find((host) => host.name === name)
  if (!pin) return true
  const resolved = resolve ? await resolve(argv0) : argv0
  return pin.paths.includes(resolved)
}

const segmentDecision = async (argv: string[], policy: Policy, options: DecideOptions): Promise<Decision> => {
  const prefixes = [argv]
  if (isRmForceRoot(argv) || isRootChmodChown(argv) || isFindExec(argv) || isMetadataNet(argv)) {
    return { effect: "deny", reason: "builtin-special", prefixes }
  }
  const argv0 = argv[0] ?? ""
  if (!(await pinAllows(argv0, policy, options.resolve))) {
    return { effect: options.dontAsk ? "deny" : "ask", reason: "host-pin", prefixes }
  }
  const rule = longestPrefix(
    argv.map((token, i) => (i === 0 ? basename(token) : token)),
    policy.rules,
  )
  if (!rule) return { effect: options.dontAsk ? "deny" : "ask", prefixes }
  return { effect: rule.effect, reason: rule.reason, prefixes }
}

export const decide = (
  policy: Policy,
  reduced: ReduceResult,
  options: DecideOptions = {},
): Decision => {
  const sandbox = options.sandboxProfile ?? "workspace"
  if (reduced.tag === "deny-wrapper") {
    return { effect: "deny", reason: `wrapper:${reduced.argv0}`, prefixes: [[reduced.argv0]] }
  }
  if (reduced.tag === "opaque") {
    if (options.dontAsk || sandbox !== "off") {
      return { effect: "deny", reason: reduced.reason ?? "opaque", prefixes: [[reduced.source]] }
    }
    return { effect: "ask", reason: reduced.reason ?? "opaque", prefixes: [[reduced.source]] }
  }
  let acc: Decision = { effect: "allow", prefixes: [] }
  for (const segment of reduced.segments) {
    acc = combine(acc, decideSegmentSync(segment, policy, options))
  }
  return acc
}

const decideSegmentSync = (argv: string[], policy: Policy, options: DecideOptions): Decision => {
  const prefixes = [argv]
  if (isRmForceRoot(argv) || isRootChmodChown(argv) || isFindExec(argv) || isMetadataNet(argv)) {
    return { effect: "deny", reason: "builtin-special", prefixes }
  }
  const argv0 = argv[0] ?? ""
  const name = basename(argv0)
  const pin = policy.hosts.find((host) => host.name === name)
  if (pin) {
    const resolved = argv0.startsWith("/") || /^[a-zA-Z]:/.test(argv0) ? argv0 : name
    if (!pin.paths.includes(resolved)) {
      return { effect: options.dontAsk ? "deny" : "ask", reason: "host-pin", prefixes }
    }
  }
  const rule = longestPrefix(
    argv.map((token, i) => (i === 0 ? basename(token) : token)),
    policy.rules,
  )
  if (!rule) return { effect: options.dontAsk ? "deny" : "ask", prefixes }
  return { effect: rule.effect, reason: rule.reason, prefixes }
}

export const decideAsync = async (
  policy: Policy,
  reduced: ReduceResult,
  options: DecideOptions = {},
): Promise<Decision> => {
  if (!options.resolve) return decide(policy, reduced, options)
  if (reduced.tag !== "segments") return decide(policy, reduced, options)
  let acc: Decision = { effect: "allow", prefixes: [] }
  for (const segment of reduced.segments) {
    acc = combine(acc, await segmentDecision(segment, policy, options))
  }
  return acc
}
