import { Effect } from "effect"
import type { EvalArgs } from "./eval"
import { fail } from "../../effect-cmd"
import path from "node:path"
import { existsSync } from "node:fs"

/**
 * Delegates to the Plan 1 baseline driver (a Python package living in
 * `docs/superpowers/plans/baseline-driver`). The driver's `lib.main.main()`
 * takes `instance_indices` and writes per-instance JSON + a summary under
 * `DATA_BASE/<run_timestamp>/`. This runner shells out to `python -m lib.main`
 * with the parsed instance range; the fork repo path is a driver-internal
 * detail (worktree isolation) and is NOT passed here.
 */
const DRIVER_RELATIVE_PATH = path.join("docs", "superpowers", "plans", "baseline-driver")

export type EvalDriverInvocation = {
  readonly cmd: string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

function findDriverDirectory(startDirectory: string): string {
  let current = path.resolve(startDirectory)
  while (true) {
    const candidate = path.join(current, DRIVER_RELATIVE_PATH)
    if (existsSync(path.join(candidate, "lib", "main.py"))) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(startDirectory, DRIVER_RELATIVE_PATH)
}

export function buildEvalDriverInvocation(args: EvalArgs, startDirectory: string): EvalDriverInvocation {
  const indices = Array.from(
    { length: args.instancesRange.end - args.instancesRange.start + 1 },
    (_, i) => args.instancesRange.start + i,
  )
  return {
    cmd: [
      "python3",
      "-m",
      "lib.main",
      "--instance-indices",
      indices.join(","),
      "--baseline-commit",
      args.baselineCommit,
      ...(args.forkCommit ? ["--fork-commit", args.forkCommit] : []),
      "--batch-size",
      String(args.batchSize),
      "--concurrency",
      String(args.concurrency),
      "--repo-cache",
      args.repoCache,
      ...(args.baselineBin ? ["--baseline-bin", args.baselineBin] : []),
      ...(args.forkBin ? ["--fork-bin", args.forkBin] : []),
      "--out",
      args.out,
      ...(args.resume ? ["--resume", args.resume] : []),
      ...(args.dryRun ? ["--dry-run"] : []),
    ],
    cwd: findDriverDirectory(startDirectory),
    env: {
      ...process.env,
      OPENCODE_EVAL_MODEL: args.model,
      SWEBENCH_BASELINE_CACHE_ROOT: args.repoCache,
    },
  }
}

export const runEval = (args: EvalArgs) =>
  Effect.gen(function* () {
    const invocation = buildEvalDriverInvocation(args, process.cwd())
    const proc = Bun.spawnSync(invocation)
    if (proc.exitCode !== 0) {
      return yield* fail(
        `eval driver failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}`,
      )
    }
    const stdout = proc.stdout.toString()
    console.log(stdout)
    return `eval completed for ${args.instancesRange.end - args.instancesRange.start + 1} instances -> ${args.out}`
  })
