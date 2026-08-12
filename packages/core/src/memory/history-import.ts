import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"
import { assertSandboxPath, importMemory } from "./transfer"
import { scanForThreats } from "./scan"

/** Cap on imported messages so one import cannot balloon a session log unboundedly. */
const MAX_IMPORTED_MESSAGES = 2000
const CONTENT_HASH_CHARS = 10

/**
 * Roles that are prompt machinery rather than conversation — skipped and
 * counted as `skipped` on import. Session logs capture user/assistant
 * dialogue; system prompts and tool I/O are transient and often
 * injection-shaped (the threat scan would flag them anyway).
 */
const NON_CONVERSATION_ROLES = new Set(["system", "tool", "function", "developer"])

export type HistoryImportFormat = "jsonl" | "messages-json" | "auto"

export interface HistoryImportOptions {
  readonly format: HistoryImportFormat
  readonly allowedRoots: ReadonlyArray<string>
}

export interface HistoryImportResult {
  readonly imported: number
  readonly skipped: number
  readonly error?: string
}

interface ImportMessage {
  readonly role: string
  readonly text: string
  readonly ts: string | undefined // ISO 8601, when the source carried a timestamp
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Epoch-ms numbers and parseable date strings → ISO; malformed input → absent. */
function parseTimestamp(ts: unknown): string | undefined {
  if (typeof ts !== "string" && typeof ts !== "number") return undefined
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function parseMessage(value: unknown, textKey: "text" | "content"): ImportMessage | undefined {
  if (!isRecord(value)) return undefined
  const role = value.role
  const text = value[textKey]
  if (typeof role !== "string" || typeof text !== "string") return undefined
  return { role, text, ts: parseTimestamp(value.ts) }
}

/** Line-delimited `{role,text,ts?}` objects; any invalid non-empty line fails the whole parse. */
function parseJsonl(text: string): ImportMessage[] | undefined {
  const messages: ImportMessage[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return undefined
    }
    const message = parseMessage(value, "text")
    if (message === undefined) return undefined
    messages.push(message)
  }
  return messages
}

/** Claude/Cursor-style `{messages:[{role,content}]}`; `text` accepted as a lenient alias for `content`. */
function parseMessagesJson(text: string): ImportMessage[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !Array.isArray(value.messages)) return undefined
  const messages: ImportMessage[] = []
  for (const entry of value.messages) {
    const message = parseMessage(entry, "content") ?? parseMessage(entry, "text")
    if (message === undefined) return undefined
    messages.push(message)
  }
  return messages
}

/** `auto` sniff: messages-json wins when the whole file is one `{messages:[...]}` object. */
function sniffFormat(text: string): HistoryImportFormat | undefined {
  if (parseMessagesJson(text) !== undefined) return "messages-json"
  if (parseJsonl(text) !== undefined) return "jsonl"
  return undefined
}

const fail = (error: string, skipped = 0): HistoryImportResult => ({ imported: 0, skipped, error })

/**
 * Imports an external session history export into the memory `sessions/`
 * directory as one `import-<date>-<hash>.md` session log. Fail closed: every
 * rejection path (sandbox escape, unreadable source, parse failure, nothing
 * importable) returns an `error` result and writes nothing.
 *
 * Formats: `jsonl` (line-delimited `{role,text,ts?}`), `messages-json`
 * (`{messages:[{role,content}]}`), or `auto` (sniffed; a directory source is
 * routed through `importMemory` as an already memory-shaped pack).
 *
 * Non-conversation roles (`system`, `tool`, `function`, `developer`) are
 * skipped and counted. Every rendered message is threat-scanned; threatened
 * messages are dropped and counted. The file is named from the first message
 * timestamp (or today) and a sha256 content hash, so re-importing identical
 * history overwrites the same file (idempotent).
 */
export const importExternalHistory = Effect.fn("Memory.importExternalHistory")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  sourcePath: string,
  opts: HistoryImportOptions,
): Effect.fn.Return<HistoryImportResult> {
  const safeSource = yield* assertSandboxPath(sourcePath, opts.allowedRoots).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (safeSource === undefined) return fail("source path outside allowed roots")

  if (opts.format === "auto") {
    const info = yield* fs.stat(safeSource).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (info !== undefined && info.type === "Directory") {
      const manifestText = yield* readTextSafe(fs, path.join(safeSource, "manifest.json")).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (manifestText === undefined) return fail("directory is not a memory pack (missing manifest.json)")
      // `importMemory` treats an unparseable manifest as a silent 0/0, so validate
      // it here to keep the fail-closed contract (parse failure → error result).
      let manifest: unknown
      try {
        manifest = JSON.parse(manifestText)
      } catch {
        return fail("invalid manifest.json in memory directory")
      }
      if (!isRecord(manifest) || !Array.isArray(manifest.scopes)) {
        return fail("invalid manifest.json in memory directory")
      }
      // Pre-scan: a pack holding files should import at least one, so a 0/0
      // result means every copy degraded (unreadable source, threat, failed
      // atomic write) — surface that instead of a success-shaped empty result.
      // A pack with only manifest.json is a genuine nothing-to-import and stays 0/0.
      const packHasEntries = yield* fs
        .readDirectoryEntries(safeSource)
        .pipe(
          Effect.map((entries) =>
            entries.some((entry) => entry.type === "file" && entry.name !== "manifest.json"),
          ),
          Effect.catch(() => Effect.succeed(false)),
        )
      // importMemory's only typed error is SandboxError, which cannot fire here
      // because safeSource was already validated against the same allowedRoots;
      // the catch below keeps this function's error channel closed to `never`.
      const result = yield* importMemory(fs, roots, safeSource, { allowedRoots: opts.allowedRoots }).pipe(
        Effect.catch(() => Effect.succeed({ imported: 0, skipped: 0 })),
      )
      if (result.imported === 0 && result.skipped === 0 && packHasEntries) {
        return fail("memory directory import produced no result")
      }
      return { imported: result.imported, skipped: result.skipped }
    }
  }

  const text = yield* readTextSafe(fs, safeSource).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (text === undefined) return fail("cannot read source file")

  const format = opts.format === "auto" ? sniffFormat(text) : opts.format
  const messages =
    format === "jsonl" ? parseJsonl(text) : format === "messages-json" ? parseMessagesJson(text) : undefined
  if (messages === undefined) return fail(`unrecognized or unparseable history format (${opts.format})`)

  let imported = 0
  let skipped = 0
  const sections: string[] = []
  for (const message of messages) {
    if (NON_CONVERSATION_ROLES.has(message.role)) {
      skipped++
      continue
    }
    if (imported >= MAX_IMPORTED_MESSAGES) {
      skipped++
      continue
    }
    // Scan role + text together: the role renders into a markdown heading, so it can smuggle too.
    if (scanForThreats(`${message.role}\n${message.text}`).length > 0) {
      skipped++
      continue
    }
    // Sanitize role for a single-line heading (no # / newlines that restructure markdown).
    const safeRole =
      message.role
        .replace(/[\r\n#]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64) || "message"
    const heading = message.ts === undefined ? `### ${safeRole}` : `### ${safeRole} (${message.ts})`
    sections.push(`${heading}\n\n${message.text}`)
    imported++
  }
  if (imported === 0) return fail("no importable messages", skipped)

  const content = `${sections.join("\n\n---\n\n")}\n`
  const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, CONTENT_HASH_CHARS)
  const date =
    messages.find((message) => message.ts !== undefined)?.ts?.slice(0, 10) ??
    new Date().toISOString().slice(0, 10)
  const target = path.join(roots.workspaceDir ?? roots.globalDir, "sessions", `import-${date}-${hash}.md`)
  const ok = yield* writeTextAtomic(fs, target, content).pipe(Effect.catch(() => Effect.succeed(false)))
  if (!ok) return fail("failed to write imported session log")
  return { imported, skipped }
})
