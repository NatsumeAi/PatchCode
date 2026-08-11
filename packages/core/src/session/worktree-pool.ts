export * as WorktreePool from "./worktree-pool"

import { Effect } from "effect"
import path from "node:path"
import { spawn } from "node:child_process"

const run = (cmd: string, args: string[], cwd: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<{ code: number; stderr: string }>((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
        let stderr = ""
        child.stderr?.on("data", (d) => {
          stderr += String(d)
        })
        child.on("error", reject)
        child.on("close", (code) => resolve({ code: code ?? 1, stderr }))
      }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

/**
 * Acquire a git worktree under project/.opencode/worktrees/<childID>.
 * Fails with Error if not a git repo or worktree add fails.
 */
export const acquire = (projectRoot: string, childID: string): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const dir = path.join(projectRoot, ".opencode", "worktrees", childID)
    const add = yield* run("git", ["worktree", "add", "--detach", dir, "HEAD"], projectRoot)
    if (add.code !== 0) {
      return yield* Effect.fail(
        new Error(`git worktree add failed: ${add.stderr.trim() || `exit ${add.code}`}`),
      )
    }
    return dir
  })

export const release = (projectRoot: string, childID: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = path.join(projectRoot, ".opencode", "worktrees", childID)
    yield* run("git", ["worktree", "remove", "--force", dir], projectRoot).pipe(Effect.ignore)
  })
