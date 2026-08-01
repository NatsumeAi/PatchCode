import { Effect, Schema } from "effect"

const WorkerTag = Schema.Literals(["Active", "Waiting", "Dead"])
const VerifierTag = Schema.Literals(["Reused", "Fresh", "Disposed"])

export const LoopStatusInput = Schema.Struct({
  worker: Schema.Struct({ _tag: WorkerTag, turn: Schema.Number, stepCap: Schema.Number, depth: Schema.Number }),
  verifier: Schema.Struct({ _tag: VerifierTag, rejectCount: Schema.Number, lastAuditAt: Schema.Number }),
  budget: Schema.Struct({ consumed: Schema.Number, cap: Schema.Number }),
  timer: Schema.Struct({
    loopTimerMs: Schema.Number,
    stopReminderMs: Schema.Number,
    stopReminderActive: Schema.Boolean,
    waitIdleBackupMs: Schema.Number,
    waitIdleBackupActive: Schema.Boolean,
  }),
  lastEvents: Schema.Array(
    Schema.Struct({
      _tag: Schema.String,
      durationMs: Schema.optional(Schema.Number),
      tool: Schema.optional(Schema.String),
    }),
  ),
  terminal: Schema.Struct({
    state: Schema.String,
    reason: Schema.String.pipe(Schema.NullOr),
  }),
})
export type LoopStatusInput = typeof LoopStatusInput.Type

const fmtMs = (ms: number): string => {
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${String(s).padStart(2, "0")}m`
}

export const renderLoopStatus = (input: LoopStatusInput) =>
  Effect.sync(() => {
    const w = input.worker
    const v = input.verifier
    const b = input.budget
    const t = input.timer
    const pct = Math.round((b.consumed / b.cap) * 100)
    const ago = Math.floor((Date.now() - v.lastAuditAt) / 60_000)
    const ev = input.lastEvents
      .map((e) =>
        e._tag === "onToolCall"
          ? `${e._tag}(${e.tool ?? ""})`
          : e._tag === "onStream"
            ? `${e._tag}(${fmtMs(e.durationMs ?? 0)})`
            : e._tag,
      )
      .join(" -> ")
    return [
      `Worker     : ${w._tag.toLowerCase()}  (turn ${w.turn}/${w.stepCap}, depth ${w.depth})`,
      `Verifier   : ${v._tag.toLowerCase()}  (reject count: ${v.rejectCount}, last audit: ${ago}m ago)`,
      `Budget     : consumed ${b.consumed} / cap ${b.cap}  (${pct}%)`,
      `Timer      : loopTimer ${fmtMs(t.loopTimerMs)}, stopReminder ${fmtMs(t.stopReminderMs)} ${t.stopReminderActive ? "active" : "idle"}, waitIdleBackup ${t.waitIdleBackupActive ? "active" : "idle"}`,
      `Terminal   : ${input.terminal.state}${input.terminal.reason ? ` (reason: ${input.terminal.reason})` : ""}`,
      `Last events: ${ev}`,
    ].join("\n")
  })
