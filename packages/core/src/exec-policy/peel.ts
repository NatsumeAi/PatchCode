export * as ExecPolicyPeel from "./peel"

import path from "path"
import type { ClassifyResult } from "./parse"

export type ReduceResult =
  | { tag: "segments"; segments: string[][] }
  | { tag: "opaque"; source: string; reason: string }
  | { tag: "deny-wrapper"; argv0: string }

const DENY_WRAPPERS = new Set(["sudo", "doas", "su", "pkexec"])
const STRIP_WRAPPERS = new Set([
  "env",
  "nice",
  "nohup",
  "stdbuf",
  "ionice",
  "chrt",
  "time",
  "command",
  "builtin",
  "timeout",
])
const SCRIPT_SHELLS = new Set(["bash", "sh", "zsh", "dash"])
const OPAQUE_INTERPRETERS: Record<string, Set<string>> = {
  python: new Set(["-c", "-e"]),
  python3: new Set(["-c", "-e"]),
  python2: new Set(["-c", "-e"]),
  node: new Set(["-e", "--eval"]),
  perl: new Set(["-e", "-E"]),
  ruby: new Set(["-e"]),
}

const basename = (argv0: string) => path.basename(argv0.replace(/\\/g, "/"))

const isAssignment = (token: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)

const stripWrapper = (argv: string[]): string[] | undefined => {
  const name = basename(argv[0] ?? "")
  if (!STRIP_WRAPPERS.has(name) || argv.length < 2) return undefined
  const rest = argv.slice(1)
  if (name === "env") {
    let i = 0
    while (i < rest.length) {
      const token = rest[i] ?? ""
      if (token === "-i" || token === "-0" || token === "-u" || token === "--ignore-environment") {
        if (token === "-u" && rest[i + 1]) i += 2
        else i += 1
        continue
      }
      if (token.startsWith("-") && token !== "-") return undefined
      if (isAssignment(token)) {
        i += 1
        continue
      }
      break
    }
    return rest.slice(i).length > 0 ? rest.slice(i) : undefined
  }
  if (name === "timeout") {
    let i = 0
    while (i < rest.length) {
      const token = rest[i] ?? ""
      if (token === "-k" || token === "--kill-after" || token === "-s" || token === "--signal") {
        if (!rest[i + 1]) return undefined
        i += 2
        continue
      }
      if (token === "-v" || token === "--verbose" || token === "--preserve-status" || token === "--foreground") {
        i += 1
        continue
      }
      if (token.startsWith("-") && token !== "-") return undefined
      i += 1
      break
    }
    return rest.slice(i).length > 0 ? rest.slice(i) : undefined
  }
  if (name === "nice") {
    let i = 0
    if (rest[0] === "-n" || rest[0] === "--adjustment") {
      if (!rest[1]) return undefined
      i = 2
    } else if (rest[0]?.match(/^-\d+$/)) i = 1
    else if (rest[0]?.startsWith("-") && rest[0] !== "-") return undefined
    return rest.slice(i).length > 0 ? rest.slice(i) : undefined
  }
  let i = 0
  while (i < rest.length && rest[i]?.startsWith("-") && rest[i] !== "-") {
    const token = rest[i] ?? ""
    if (token.includes("=")) {
      i += 1
      continue
    }
    if (token.length === 2 && rest[i + 1] && !rest[i + 1]!.startsWith("-")) {
      return undefined
    }
    i += 1
  }
  return rest.slice(i).length > 0 ? rest.slice(i) : undefined
}

const cFlagIndex = (argv: string[]) => {
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? ""
    if (token === "-c" || token === "-lc" || token === "-c-" || token.startsWith("-c") && token.includes("c")) {
      if (token === "-lc" || token === "-c") return i
    }
  }
  return -1
}

export const reduce = async (
  classified: ClassifyResult,
  input: { classify: (command: string, shell?: string) => Promise<ClassifyResult>; depth?: number; source?: string },
): Promise<ReduceResult> => {
  const depth = input.depth ?? 0
  if (classified.tag === "opaque") {
    return { tag: "opaque", source: classified.source, reason: classified.reason }
  }
  const out: string[][] = []
  for (const segment of classified.segments) {
    const reduced = await reduceSegment(segment, input, depth)
    if (reduced.tag !== "segments") return reduced
    out.push(...reduced.segments)
  }
  return { tag: "segments", segments: out }
}

const reduceSegment = async (
  argv: string[],
  input: { classify: (command: string, shell?: string) => Promise<ClassifyResult>; source?: string },
  depth: number,
): Promise<ReduceResult> => {
  if (argv.length === 0) return { tag: "opaque", source: input.source ?? "", reason: "empty" }
  const name = basename(argv[0] ?? "")
  if (DENY_WRAPPERS.has(name)) return { tag: "deny-wrapper", argv0: name }
  if (name === "eval") return { tag: "opaque", source: argv.join(" "), reason: "eval" }

  const interpFlags = OPAQUE_INTERPRETERS[name]
  if (interpFlags && argv.some((token) => interpFlags.has(token))) {
    return { tag: "opaque", source: argv.join(" "), reason: `${name} script flag` }
  }

  if (SCRIPT_SHELLS.has(name)) {
    const flagAt = cFlagIndex(argv)
    if (flagAt >= 0) {
      const script = argv[flagAt + 1]
      if (script === undefined) return { tag: "opaque", source: argv.join(" "), reason: "bash -c missing script" }
      if (depth >= 2) return { tag: "opaque", source: argv.join(" "), reason: "bash -c depth" }
      const inner = await input.classify(script, name)
      return reduce(inner, { ...input, depth: depth + 1, source: script })
    }
    if (argv.length >= 2 && !argv[1]!.startsWith("-")) {
      return { tag: "opaque", source: argv.join(" "), reason: "shell file script" }
    }
  }

  const stripped = stripWrapper(argv)
  if (stripped) return reduceSegment(stripped, input, depth)

  return { tag: "segments", segments: [argv] }
}
