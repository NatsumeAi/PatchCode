export * as WorktreeGit from "./git"

import { Effect, Schema } from "effect"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { detectedFaster, probe, type BackendName } from "./probe"

export class DirtyParent extends Schema.TaggedErrorClass<DirtyParent>()("Worktree.DirtyParent", {
  id: Schema.String,
  paths: Schema.Array(Schema.String),
}) {}

export class Busy extends Schema.TaggedErrorClass<Busy>()("Worktree.Busy", {
  projectRoot: Schema.String,
  live: Schema.Number,
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("Worktree.NotFound", {
  id: Schema.String,
}) {}

export type Handle = {
  readonly dir: string
  readonly backend: BackendName
  readonly id: string
}

export const POOL_N = 2
export const LIVE_CAP = 4

type Lease = { id: string; dir: string; projectRoot: string }

const leases = new Map<string, Lease>()
const free = new Map<string, string[]>()
const poolSeq = new Map<string, number>()

const key = (projectRoot: string, id: string) => `${path.resolve(projectRoot)}::${id}`
const rootKey = (projectRoot: string) => path.resolve(projectRoot)

const liveCount = (projectRoot: string) => {
  const root = rootKey(projectRoot)
  let n = 0
  for (const lease of leases.values()) if (lease.projectRoot === root) n++
  return n
}

export const git = (cwd: string, args: string[]) =>
  Effect.tryPromise({
    try: () =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }) // sandbox:host
        let stdout = ""
        let stderr = ""
        child.stdout?.on("data", (d) => {
          stdout += String(d)
        })
        child.stderr?.on("data", (d) => {
          stderr += String(d)
        })
        child.on("error", reject)
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
      }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

const failGit = (label: string, result: { code: number; stderr: string }) =>
  Effect.fail(new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.code}`}`))

const resetClean = (dir: string, ref: string) =>
  Effect.gen(function* () {
    const reset = yield* git(dir, ["reset", "--hard", ref])
    if (reset.code !== 0) return yield* failGit("git reset --hard", reset)
    const clean = yield* git(dir, ["clean", "-fdx"])
    if (clean.code !== 0) return yield* failGit("git clean", clean)
  })

const worktreesDir = (projectRoot: string) => path.join(projectRoot, ".opencode", "worktrees")
const leasesFile = (projectRoot: string) => path.join(worktreesDir(projectRoot), "leases.json")

const persistLeases = (projectRoot: string) => {
  const root = rootKey(projectRoot)
  try {
    fs.mkdirSync(worktreesDir(projectRoot), { recursive: true })
    const payload = {
      leases: [...leases.values()].filter((lease) => lease.projectRoot === root),
      free: free.get(root) ?? [],
      poolSeq: poolSeq.get(root) ?? 0,
    }
    fs.writeFileSync(leasesFile(projectRoot), JSON.stringify(payload))
  } catch {
    // best-effort
  }
}

const hydrateLeases = (projectRoot: string) => {
  const root = rootKey(projectRoot)
  try {
    const raw = JSON.parse(fs.readFileSync(leasesFile(projectRoot), "utf8")) as {
      leases?: Lease[]
      free?: string[]
      poolSeq?: number
    }
    for (const lease of raw.leases ?? []) {
      if (!lease?.id || !lease.dir) continue
      leases.set(key(root, lease.id), { id: lease.id, dir: lease.dir, projectRoot: root })
    }
    if (Array.isArray(raw.free)) free.set(root, raw.free)
    if (typeof raw.poolSeq === "number") poolSeq.set(root, raw.poolSeq)
  } catch {
    // missing
  }
  const base = worktreesDir(projectRoot)
  if (!fs.existsSync(base)) return
  try {
    for (const name of fs.readdirSync(base)) {
      if (name === "leases.json" || name.startsWith("pool-")) continue
      const dir = path.join(base, name)
      try {
        if (!fs.statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      if (!leases.has(key(root, name))) leases.set(key(root, name), { id: name, dir, projectRoot: root })
    }
  } catch {
    // ignore
  }
}

const resolveGitRoot = (cwd: string) =>
  Effect.gen(function* () {
    const top = yield* git(cwd, ["rev-parse", "--show-toplevel"])
    if (top.code === 0 && top.stdout.trim()) return path.resolve(top.stdout.trim())
    return path.resolve(cwd)
  })

const nextDir = (projectRoot: string, id: string) => {
  const base = worktreesDir(projectRoot)
  fs.mkdirSync(base, { recursive: true })
  const root = rootKey(projectRoot)
  const pooled = free.get(root) ?? []
  const existing = pooled.pop()
  if (existing) {
    free.set(root, pooled)
    return { dir: existing, created: false }
  }
  const n = poolSeq.get(root) ?? 0
  if (n < POOL_N) {
    poolSeq.set(root, n + 1)
    return { dir: path.join(base, `pool-${n}`), created: true }
  }
  return { dir: path.join(base, id), created: true }
}

export const acquire = (input: {
  readonly projectRoot: string
  readonly id: string
  readonly ref?: string
}): Effect.Effect<Handle, Error | Busy> =>
  Effect.gen(function* () {
    const projectRoot = yield* resolveGitRoot(input.projectRoot)
    hydrateLeases(projectRoot)
    const id = input.id
    const existing = leases.get(key(projectRoot, id))
    if (existing) return { dir: existing.dir, backend: "git" as const, id }
    if (liveCount(projectRoot) >= LIVE_CAP) return yield* new Busy({ projectRoot, live: LIVE_CAP })

    probe()
    if (detectedFaster) {
      yield* Effect.logWarning(`worktree.backend_unavailable backend=${detectedFaster} using=git`)
    }

    const { dir, created } = nextDir(projectRoot, id)
    const ref = input.ref ?? "HEAD"
    if (created) {
      const add = yield* git(projectRoot, ["worktree", "add", "--detach", dir, ref])
      if (add.code !== 0) return yield* failGit("git worktree add", add)
    } else {
      yield* resetClean(dir, ref)
    }
    leases.set(key(projectRoot, id), { id, dir, projectRoot })
    persistLeases(projectRoot)
    return { dir, backend: "git", id }
  })

export const discard = (input: {
  readonly projectRoot: string
  readonly id: string
}): Effect.Effect<void, Error | NotFound> =>
  Effect.gen(function* () {
    const projectRoot = yield* resolveGitRoot(input.projectRoot)
    hydrateLeases(projectRoot)
    const lease = leases.get(key(projectRoot, input.id))
    if (!lease) return yield* new NotFound({ id: input.id })
    yield* resetClean(lease.dir, "HEAD").pipe(Effect.ignore)
    leases.delete(key(projectRoot, input.id))
    const pooled = free.get(projectRoot) ?? []
    if (pooled.length < POOL_N) {
      pooled.push(lease.dir)
      free.set(projectRoot, pooled)
      persistLeases(projectRoot)
      return
    }
    yield* git(projectRoot, ["worktree", "remove", "--force", lease.dir]).pipe(Effect.ignore)
    persistLeases(projectRoot)
  })

export const release = discard

const porcelainPaths = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(3).replace(/^"/, "").replace(/"$/, "")
      const renamed = rest.split(" -> ")
      return (renamed[1] ?? renamed[0] ?? rest).trim()
    })

export const previewDiff = (input: {
  readonly projectRoot: string
  readonly id: string
}): Effect.Effect<string, Error | NotFound> =>
  Effect.gen(function* () {
    const projectRoot = yield* resolveGitRoot(input.projectRoot)
    hydrateLeases(projectRoot)
    const lease = leases.get(key(projectRoot, input.id))
    if (!lease) return yield* new NotFound({ id: input.id })
    const diff = yield* git(lease.dir, ["diff", "--no-ext-diff", "HEAD"])
    const untracked = yield* git(lease.dir, ["ls-files", "--others", "--exclude-standard", "-z"])
    const extras = untracked.stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => {
        let body = ""
        try {
          body = fs.readFileSync(path.join(lease.dir, file), "utf8")
        } catch {
          body = ""
        }
        return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n${body
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
      })
    return [diff.stdout, ...extras].filter(Boolean).join("\n")
  })

export const changedPaths = (dir: string) =>
  Effect.gen(function* () {
    const status = yield* git(dir, ["status", "--porcelain", "-uall"])
    return porcelainPaths(status.stdout)
  })

const copyPath = (from: string, to: string) => {
  const st = fs.lstatSync(from)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(from)
    try {
      fs.rmSync(to, { force: true, recursive: true })
    } catch {
      // dest missing
    }
    fs.symlinkSync(target, to)
    return
  }
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true })
    for (const name of fs.readdirSync(from)) copyPath(path.join(from, name), path.join(to, name))
    return
  }
  fs.copyFileSync(from, to)
}

export const merge = (input: {
  readonly projectRoot: string
  readonly id: string
}): Effect.Effect<void, Error | NotFound | DirtyParent> =>
  Effect.gen(function* () {
    const projectRoot = yield* resolveGitRoot(input.projectRoot)
    hydrateLeases(projectRoot)
    const lease = leases.get(key(projectRoot, input.id))
    if (!lease) return yield* new NotFound({ id: input.id })
    const childPaths = yield* changedPaths(lease.dir)
    const parentStatus = yield* git(projectRoot, ["status", "--porcelain", "-uall"])
    const parentPaths = new Set(porcelainPaths(parentStatus.stdout))
    const overlap = childPaths.filter((p) => parentPaths.has(p))
    if (overlap.length > 0) return yield* new DirtyParent({ id: input.id, paths: overlap })

    for (const rel of childPaths) {
      const from = path.join(lease.dir, rel)
      const to = path.join(projectRoot, rel)
      if (!fs.existsSync(from)) {
        try {
          fs.rmSync(to, { force: true, recursive: true })
        } catch {
          // ignore
        }
        continue
      }
      copyPath(from, to)
    }
  })

export const gc = (projectRoot: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const root = yield* resolveGitRoot(projectRoot)
    const base = worktreesDir(root)
    if (!fs.existsSync(base)) return
    const live = new Set(
      [...leases.values()].filter((lease) => lease.projectRoot === root).map((lease) => lease.dir),
    )
    const pooled = new Set(free.get(root) ?? [])
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name)
      if (live.has(dir) || pooled.has(dir)) continue
      yield* git(root, ["worktree", "remove", "--force", dir]).pipe(Effect.ignore)
    }
  })

export const lookup = (projectRoot: string, id: string): Handle | undefined => {
  const root = path.resolve(projectRoot)
  hydrateLeases(root)
  const lease = leases.get(key(root, id))
  if (!lease) return undefined
  return { dir: lease.dir, backend: "git", id }
}

/** Test helper: drop in-memory leases without touching git. */
export const resetState = () => {
  leases.clear()
  free.clear()
  poolSeq.clear()
}
