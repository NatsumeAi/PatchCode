import { Effect } from "effect"
import { TimerDaemon } from "@opencode-ai/core/session/loop-control/timer-daemon"

const parseArgs = (raw: string): "show" | "pause" | "resume" | "reset" => {
  const tok = raw.trim().split(/\s+/)
  if (tok[0] === "pause") return "pause"
  if (tok[0] === "resume") return "resume"
  if (tok[0] === "reset") return "reset"
  return "show"
}

export const loopTimerCommand = (raw: string) =>
  Effect.gen(function* () {
    const action = parseArgs(raw)
    if (action === "pause") {
      yield* TimerDaemon.pause
      return "timer paused"
    }
    if (action === "resume") {
      yield* TimerDaemon.resume
      return "timer resumed"
    }
    if (action === "reset") {
      yield* TimerDaemon.resume
      return "timer reset"
    }
    const paused = yield* TimerDaemon.isPaused
    return `loopTimer 24h00m, stopReminder 5m00m, waitIdleBackup 60s${paused ? " [paused]" : ""}`
  })
