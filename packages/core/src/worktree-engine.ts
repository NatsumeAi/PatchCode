export * as WorktreeEngine from "./worktree-engine"

import { Context, Effect, Layer } from "effect"
import { ReviewGate } from "./session/review-gate"
import { makeGlobalNode } from "./effect/app-node"
import {
  acquire as acquireGit,
  Busy,
  changedPaths,
  discard as discardGit,
  DirtyParent,
  gc as gcGit,
  LIVE_CAP,
  lookup,
  merge as mergeGit,
  NotFound,
  POOL_N,
  previewDiff as previewDiffGit,
  release as releaseGit,
  resetState,
  type Handle,
} from "./worktree-engine/git"
import { probe, type BackendName } from "./worktree-engine/probe"

export { Busy, DirtyParent, LIVE_CAP, NotFound, POOL_N, probe, resetState }
export type { BackendName, Handle }

export const acquire = acquireGit
export const discard = discardGit
export const release = releaseGit
export const previewDiff = previewDiffGit
export const merge = (input: {
  readonly projectRoot: string
  readonly id: string
  readonly sessionID?: string
}) =>
  Effect.gen(function* () {
    if (input.sessionID) yield* ReviewGate.assertMerge(input.sessionID)
    return yield* mergeGit({ projectRoot: input.projectRoot, id: input.id })
  })
export const gc = gcGit
export { lookup, changedPaths }

export interface Interface {
  readonly probe: () => BackendName
  readonly acquire: typeof acquireGit
  readonly previewDiff: typeof previewDiffGit
  readonly merge: typeof merge
  readonly discard: typeof discardGit
  readonly gc: typeof gcGit
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeEngine") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    probe,
    acquire: acquireGit,
    previewDiff: previewDiffGit,
    merge,
    discard: discardGit,
    gc: gcGit,
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [],
})
