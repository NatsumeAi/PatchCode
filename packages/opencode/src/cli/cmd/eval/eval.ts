import { Effect, Schema } from "effect"
import { effectCmd } from "../../effect-cmd"
import { runEval } from "./runner"

export const BASELINE_COMMIT_LOCK = "f7204902192624481e526b1852cdedaadb914e24"

export class EvalArgError extends Schema.TaggedErrorClass<EvalArgError>()("EvalArgError", {
  missing: Schema.String,
}) {}

export const EvalArgs = Schema.Struct({
  dataset: Schema.Literal("swe-bench-verified"),
  baselineCommit: Schema.String,
  forkCommit: Schema.String,
  batchSize: Schema.Number,
  concurrency: Schema.Number,
  model: Schema.String,
  baselineBin: Schema.String,
  forkBin: Schema.String,
  instancesRange: Schema.Struct({ start: Schema.Number, end: Schema.Number }),
  smoke: Schema.Boolean,
  repoCache: Schema.String,
  out: Schema.String,
  resume: Schema.String,
  dryRun: Schema.Boolean,
})
export type EvalArgs = typeof EvalArgs.Type

function parseRange(raw: string): { start: number; end: number } {
  const m = raw.match(/^(\d+)-(\d+)$/)
  if (!m) throw new EvalArgError({ missing: `instancesRange must be <start>-<end>, got "${raw}"` })
  return { start: Number(m[1]), end: Number(m[2]) }
}

export const parseEvalArgs = (raw: Record<string, unknown>): EvalArgs => {
  if (!raw.model) throw new EvalArgError({ missing: "model" })
  const forkCommit = typeof raw.forkCommit === "string" ? raw.forkCommit : ""
  const smoke = raw.smoke === true
  const range = smoke ? { start: 0, end: 4 } : parseRange(typeof raw.instancesRange === "string" ? raw.instancesRange : "0-499")
  const batchSize = smoke ? 5 : typeof raw.batchSize === "number" ? raw.batchSize : 5
  const concurrency = typeof raw.concurrency === "number" ? raw.concurrency : 1
  if (batchSize <= 0) throw new EvalArgError({ missing: `batchSize must be positive, got ${batchSize}` })
  if (concurrency <= 0) throw new EvalArgError({ missing: `concurrency must be positive, got ${concurrency}` })
  return EvalArgs.make({
    dataset: "swe-bench-verified" as const,
    baselineCommit: BASELINE_COMMIT_LOCK,
    forkCommit,
    batchSize,
    concurrency,
    model: typeof raw.model === "string" ? raw.model : "",
    baselineBin: typeof raw.baselineBin === "string" ? raw.baselineBin : "",
    forkBin: typeof raw.forkBin === "string" ? raw.forkBin : "",
    instancesRange: range,
    smoke,
    repoCache: typeof raw.repoCache === "string" ? raw.repoCache : "/tmp/opencode-eval-cache",
    out: typeof raw.out === "string" ? raw.out : "results.json",
    resume: typeof raw.resume === "string" ? raw.resume : "",
    dryRun: raw.dryRun === true,
  })
}

export const EvalCommand = effectCmd({
  command: "eval",
  describe: "Run SWE-bench Verified evaluation comparing baseline-commit vs fork-commit",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("dataset", { type: "string", default: "swe-bench-verified" })
      .option("baselineCommit", { type: "string", default: BASELINE_COMMIT_LOCK })
      .option("forkCommit", { type: "string" })
      .option("batchSize", { type: "number", default: 5 })
      .option("concurrency", { type: "number", default: 1 })
      .option("model", { type: "string", demandOption: true })
      .option("baselineBin", { type: "string", default: "" })
      .option("forkBin", { type: "string", default: "" })
      .option("instancesRange", { type: "string", default: "0-499" })
      .option("smoke", { type: "boolean", default: false })
      .option("repoCache", { type: "string", default: "/tmp/opencode-eval-cache" })
      .option("out", { type: "string", default: "results.json" })
      .option("resume", { type: "string", default: "" })
      .option("dryRun", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.eval")(function* (args) {
    const parsed = parseEvalArgs({
      ...args,
      dataset: "swe-bench-verified",
    })
    yield* runEval(parsed)
  }),
})
