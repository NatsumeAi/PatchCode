export * as WorktreePool from "./worktree-pool"

import { Effect } from "effect"
import { WorktreeEngine } from "../worktree-engine"

/**
 * Thin wrapper around WorktreeEngine.acquire/discard.
 * Isolation callers should prefer WorktreeEngine.acquire directly.
 */
export const acquire = (projectRoot: string, childID: string): Effect.Effect<string, Error> =>
  WorktreeEngine.acquire({ projectRoot, id: childID }).pipe(Effect.map((handle) => handle.dir))

export const release = (projectRoot: string, childID: string): Effect.Effect<void> =>
  WorktreeEngine.discard({ projectRoot, id: childID }).pipe(Effect.ignore)
