export * as HooksSchema from "./schema"

export const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const

export type EventName = (typeof EVENTS)[number]

export const BLOCKING = new Set<EventName>(["PreToolUse", "SessionStart"])

export const EVENT_ALIASES: Record<string, EventName> = {
  PreToolUse: "PreToolUse",
  preToolUse: "PreToolUse",
  beforeShellExecution: "PreToolUse",
  PostToolUse: "PostToolUse",
  postToolUse: "PostToolUse",
  afterShellExecution: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  SessionStart: "SessionStart",
  sessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  sessionEnd: "SessionEnd",
  UserPromptSubmit: "UserPromptSubmit",
  userPromptSubmit: "UserPromptSubmit",
  PermissionDenied: "PermissionDenied",
  Stop: "Stop",
  SubagentStart: "SubagentStart",
  SubagentStop: "SubagentStop",
  PreCompact: "PreCompact",
  PostCompact: "PostCompact",
}

export const TOOL_ALIASES: Record<string, string[]> = {
  bash: ["bash", "Bash"],
  read: ["read", "Read"],
  edit: ["edit", "Edit"],
  write: ["write", "Write"],
  grep: ["grep", "Grep"],
  glob: ["glob", "Glob"],
  websearch: ["websearch", "WebSearch"],
  task: ["task", "Task"],
}

export type Origin = "global" | "project" | "plugin"

export type CommandHook = {
  readonly type: "command"
  readonly command: string
  readonly timeout: number
  readonly specDir: string
}

export type HttpHook = {
  readonly type: "http"
  readonly url: string
  readonly timeout: number
}

export type HookHandler = CommandHook | HttpHook

export type MatcherGroup = {
  readonly matcher: string
  readonly hooks: readonly HookHandler[]
}

export type LoadedSpec = {
  readonly id: string
  readonly origin: Origin
  readonly file: string
  readonly events: Readonly<Partial<Record<EventName, readonly MatcherGroup[]>>>
}

export type Envelope = {
  readonly hookEventName: EventName
  readonly sessionId: string
  readonly cwd: string
  readonly toolName?: string
  readonly toolInput?: unknown
  readonly toolInputTruncated?: boolean
  readonly timestamp: string
}

export type Decision = { readonly _tag: "Allow" } | { readonly _tag: "Deny"; readonly reason: string; readonly hookId: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const timeoutOf = (value: unknown) => {
  const n = typeof value === "number" ? value : 5
  if (!Number.isFinite(n) || n <= 0) return 5
  return Math.min(30, n)
}

const parseHandler = (raw: unknown, specDir: string): HookHandler | { error: string } => {
  if (!isRecord(raw) || typeof raw.type !== "string") return { error: "hook missing type" }
  if (isRecord(raw.env)) return { error: "env passthrough rejected" }
  if (raw.type === "command") {
    if (typeof raw.command !== "string" || raw.command.trim().length === 0) return { error: "command missing" }
    return { type: "command", command: raw.command, timeout: timeoutOf(raw.timeout), specDir }
  }
  if (raw.type === "http") {
    if (typeof raw.url !== "string" || raw.url.trim().length === 0) return { error: "url missing" }
    return { type: "http", url: raw.url, timeout: timeoutOf(raw.timeout) }
  }
  return { error: `unsupported hook type ${raw.type}` }
}

const parseGroup = (raw: unknown, specDir: string): MatcherGroup | { error: string } => {
  if (!isRecord(raw)) return { error: "matcher group must be object" }
  const matcher = typeof raw.matcher === "string" ? raw.matcher : ""
  if (!Array.isArray(raw.hooks)) return { error: "hooks array missing" }
  const hooks: HookHandler[] = []
  for (const item of raw.hooks) {
    const parsed = parseHandler(item, specDir)
    if ("error" in parsed) return parsed
    hooks.push(parsed)
  }
  return { matcher, hooks }
}

export const matchesTool = (matcher: string, toolName: string) => {
  if (!matcher.trim()) return true
  let re: RegExp
  try {
    re = new RegExp(matcher)
  } catch {
    return false
  }
  const aliases = TOOL_ALIASES[toolName] ?? [toolName]
  return aliases.some((alias) => re.test(alias))
}

export type LoadResult =
  | { readonly ok: true; readonly spec: LoadedSpec; readonly unknownEvents?: readonly string[] }
  | { readonly ok: false; readonly error: string }

export const loadFile = (text: string, input: { id: string; origin: Origin; file: string }): LoadResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: "invalid json" }
  }
  if (!isRecord(parsed)) return { ok: false, error: "root must be object" }
  const specDir = input.file.includes("/") ? input.file.slice(0, input.file.lastIndexOf("/")) : "."
  if (parsed.version !== undefined) {
    const allowed = new Set(["version", "hooks"])
    for (const key of Object.keys(parsed)) {
      if (!allowed.has(key)) return { ok: false, error: `unknown top-level key ${key}` }
    }
    if (parsed.version !== 1) return { ok: false, error: "version must be 1" }
  }
  const hooksRaw = isRecord(parsed.hooks) ? parsed.hooks : parsed
  const events: Partial<Record<EventName, MatcherGroup[]>> = {}
  const unknownEvents: string[] = []
  for (const [rawName, groups] of Object.entries(hooksRaw)) {
    if (rawName === "version") continue
    const mapped = EVENT_ALIASES[rawName]
    if (!mapped) {
      unknownEvents.push(rawName)
      continue
    }
    if (!Array.isArray(groups)) return { ok: false, error: `${rawName} must be an array` }
    const parsedGroups: MatcherGroup[] = []
    for (const group of groups) {
      const item = parseGroup(group, specDir)
      if ("error" in item) return { ok: false, error: item.error }
      parsedGroups.push(item)
    }
    events[mapped] = [...(events[mapped] ?? []), ...parsedGroups]
  }
  return {
    ok: true,
    spec: { id: input.id, origin: input.origin, file: input.file, events },
    unknownEvents,
  }
}
