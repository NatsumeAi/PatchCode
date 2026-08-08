import { Effect, Option } from "effect"
import { EventBus } from "./event-bus"
import { GoalStore } from "./goal-store"
import { IterationBudget } from "./iteration-budget"
import { TerminalController } from "./terminal-controller"
import { TimerDaemon } from "./timer-daemon"
import { WorkerState } from "./worker-state"
import { CircuitBreaker } from "./circuit-breaker"
import { SessionRuntime } from "../runtime"

export type LoopCommandRequirements =
  | EventBus.Interface
  | GoalStore.Interface
  | IterationBudget.Interface
  | TerminalController.Interface
  | TimerDaemon.Interface
  | WorkerState.Interface
  | CircuitBreaker.Interface

type StatusInput = {
  worker: { _tag: "Active" | "Waiting" | "Dead" }
  verifier: { available: boolean }
  budget: { consumed: number; cap: number }
  timer: {
    stopReminderActive: boolean
  }
  terminal: { state: string; reason: string | null }
  breaker: string
  edges: number
  goal: string
  lastEvents: Array<{ _tag: string; durationMs?: number; tool?: string }>
}

const emptyStatus: StatusInput = {
  worker: { _tag: "Active" as const },
  verifier: { available: false },
  budget: { consumed: 0, cap: 90 },
  timer: { stopReminderActive: false },
  terminal: { state: "running", reason: null },
  breaker: "Closed",
  edges: 0,
  goal: "",
  lastEvents: [],
}

const renderStatus = (input: StatusInput) => {
  const percentage = Math.round((input.budget.consumed / input.budget.cap) * 100)
  const events = input.lastEvents
    .map((event) =>
      event._tag === "onToolCall"
        ? `${event._tag}(${event.tool ?? ""})`
        : event._tag === "onStream"
          ? `${event._tag}(${event.durationMs ?? 0}ms)`
          : event._tag,
    )
    .join(" -> ")
  return [
    `Goal       : ${input.goal ? input.goal.slice(0, 120) : "(empty)"}`,
    `Worker     : ${input.worker._tag.toLowerCase()}`,
    `Verifier   : ${input.verifier.available ? "available" : "unavailable"}`,
    `Budget     : consumed ${input.budget.consumed} / cap ${input.budget.cap}  (${percentage}%)`,
    `Breaker    : ${input.breaker}`,
    `SpawnEdges : ${input.edges} open`,
    `Timer      : stopReminder ${input.timer.stopReminderActive ? "active" : "idle"}; durations unavailable`,
    `Terminal   : ${input.terminal.state}${input.terminal.reason ? ` (reason: ${input.terminal.reason})` : ""}`,
    `Last events: ${events}`,
  ].join("\n")
}

const status = Effect.gen(function* () {
  let input = emptyStatus
  const worker = yield* Effect.serviceOption(WorkerState.Service)
  if (Option.isSome(worker)) input = { ...input, worker: { _tag: (yield* worker.value.current)._tag } }
  const budget = yield* Effect.serviceOption(IterationBudget.Service)
  if (Option.isSome(budget)) {
    const remaining = yield* budget.value.remaining
    const cap = yield* budget.value.currentCap
    input = { ...input, budget: { consumed: cap - remaining, cap } }
  }
  const timer = yield* Effect.serviceOption(TimerDaemon.Service)
  if (Option.isSome(timer)) input = { ...input, timer: { stopReminderActive: !(yield* timer.value.isPaused) } }
  const terminal = yield* Effect.serviceOption(TerminalController.Service)
  if (Option.isSome(terminal)) {
    const snap = yield* terminal.value.snapshot
    input = { ...input, terminal: { state: snap.state, reason: snap.reason } }
  }
  const breaker = yield* Effect.serviceOption(CircuitBreaker.Service)
  if (Option.isSome(breaker)) input = { ...input, breaker: yield* breaker.value.state }
  const goal = yield* Effect.serviceOption(GoalStore.Service)
  if (Option.isSome(goal)) input = { ...input, goal: yield* goal.value.get }
  const bus = yield* Effect.serviceOption(EventBus.Service)
  if (Option.isSome(bus)) input = { ...input, lastEvents: (yield* bus.value.snapshotBuffer(3)).map((event) => ({ _tag: event._tag })) }
  return renderStatus(input)
})

export const loopCommand = (raw: string): Effect.Effect<string, Error, LoopCommandRequirements> =>
  Effect.gen(function* () {
    const [name] = raw.trim().split(/\s+/)
    if (name === "status") return yield* status
    const [, ...rest] = raw.trim().split(/\s+/)
    if (name === "budget") {
      const budget = yield* Effect.serviceOption(IterationBudget.Service)
      if (Option.isNone(budget)) return "loop-control budget unavailable"
      if (rest[0] === "set" && rest[1] === "--cap") {
        const cap = Number(rest[2])
        yield* budget.value.setCap(cap)
        return `cap ${cap}`
      }
      if (rest[0] === "refund" && rest[1] === "--turns") {
        const turns = Number(rest[2])
        yield* budget.value.refund(turns)
        return `refunded ${turns}, remaining ${yield* budget.value.remaining}`
      }
      if (rest[0] === "reset") {
        yield* budget.value.reset()
        return "reset"
      }
      const remaining = yield* budget.value.remaining
      const cap = yield* budget.value.currentCap
      return `remaining ${remaining}\ncap ${cap}`
    }
    if (name === "timer") {
      const timer = yield* Effect.serviceOption(TimerDaemon.Service)
      if (Option.isNone(timer)) return "loop-control timer unavailable"
      if (rest[0] === "pause") {
        yield* timer.value.pause
        return "timer paused"
      }
      if (rest[0] === "resume" || rest[0] === "reset") {
        yield* timer.value.resume
        return rest[0] === "reset" ? "timer reset" : "timer resumed"
      }
      return `loopTimer 24h00m, stopReminder 5m00m, waitIdleBackup 60s${(yield* timer.value.isPaused) ? " [paused]" : ""}`
    }
    if (name === "verifier") {
      const bus = yield* Effect.serviceOption(EventBus.Service)
      if (Option.isNone(bus)) return "verifier: Fresh (no audits yet)"
      const events = yield* bus.value.snapshotBuffer(50)
      const rejects = events.filter((event) => event._tag === "VerifierRejectInjected")
      const completions = events.filter((event) => event._tag === "SubagentCompleted")
      if (rejects.length === 0 && completions.length === 0) return "verifier: Fresh (no audits yet)"
      return [
        `verifier: ${rejects.length > 0 ? "Reused" : "Fresh"} (reject count: ${rejects.length})`,
        ...(rejects.length ? [`last reject: ${rejects.at(-1)?.reason ?? ""}`] : []),
        `subagent completions: ${completions.length}`,
      ].join("\n")
    }
    if (name === "failover") {
      const bus = yield* Effect.serviceOption(EventBus.Service)
      if (Option.isNone(bus)) return "failover: loop-control bus unavailable"
      const events = yield* bus.value.snapshotBuffer(50)
      const hard = events.filter((event) => event._tag === "HardAbort")
      const lost = events.filter((event) => event._tag === "SubagentHeartbeatLost")
      if (hard.length === 0 && lost.length === 0) return "failover: no retries recorded"
      return [
        ...(hard.length ? [`hard aborts: ${hard.length} (last: ${hard.at(-1)?.reason ?? ""})`] : []),
        ...(lost.length ? [`subagent heartbeat losses: ${lost.length}`] : []),
        "failover reason classes: rate_limit / server_unavailable / timeout / context_overflow / unknown",
      ].join("\n")
    }
    if (name === "abort") {
      const bus = yield* Effect.serviceOption(EventBus.Service)
      const terminal = yield* Effect.serviceOption(TerminalController.Service)
      if (Option.isSome(terminal)) yield* terminal.value.request("user_abort")
      if (Option.isNone(bus)) return "abort requested; loop-control bus unavailable"
      yield* bus.value.publish({ _tag: "AbortRequested", source: "user-cli", at: yield* Effect.clockWith((clock) => clock.currentTimeMillis) })
      return "abort requested; harness loop will break on next turn boundary"
    }
    if (name === "breaker" || name === "circuit") {
      const breaker = yield* Effect.serviceOption(CircuitBreaker.Service)
      if (Option.isNone(breaker)) return "circuit breaker unavailable"
      if (rest[0] === "reset") {
        yield* breaker.value.reset
        return "circuit breaker reset (Closed)"
      }
      return `circuit breaker: ${yield* breaker.value.state}`
    }
    if (name === "goal") {
      const goal = yield* Effect.serviceOption(GoalStore.Service)
      if (Option.isNone(goal)) return "no goal set"
      if (rest[0] === "--set") {
        const value = rest.slice(1).join(" ").replace(/^"|"$/g, "")
        yield* goal.value.set(value)
        return `goal: ${value}`
      }
      const value = yield* goal.value.get
      return value ? `goal: ${value}` : "no goal set"
    }
    if (name === "history") {
      const bus = yield* Effect.serviceOption(EventBus.Service)
      if (Option.isNone(bus)) return "no loop events recorded"
      const events = yield* bus.value.snapshotBuffer(20)
      if (events.length === 0) return "no loop events recorded"
      return events.map((event) => (event._tag === "HeartbeatTick" ? `${event._tag}(${event.time})` : event._tag)).join("\n")
    }
    return yield* Effect.fail(new Error(`unknown loop command: ${name ?? ""}`))
  })

/**
 * Session-bound variant used by the `/loop` command dispatch: when a
 * `SessionRuntime` is present in the environment, commands observe and
 * control the same per-session loop-control services the V2 runner uses;
 * otherwise it falls back to the ambient (legacy global) services.
 *
 * `SessionRuntime` is read via `serviceOption` so this effect never adds a
 * runtime requirement to the caller's environment.
 */
export const loopCommandForSession = (
  raw: string,
  sessionID: string,
): Effect.Effect<string, Error, LoopCommandRequirements> =>
  Effect.gen(function* () {
    const maybe = yield* Effect.serviceOption(SessionRuntime.Service)
    if (Option.isNone(maybe)) return yield* loopCommand(raw)
    const instance = yield* maybe.value.getOrCreate(sessionID)
    const edges = instance.spawnEdges.size
    return yield* loopCommand(raw).pipe(
      Effect.provideService(EventBus.Service, instance.eventBus),
      Effect.provideService(GoalStore.Service, instance.goalStore),
      Effect.provideService(IterationBudget.Service, instance.budget),
      Effect.provideService(TimerDaemon.Service, instance.timerDaemon),
      Effect.provideService(WorkerState.Service, instance.workerState),
      Effect.provideService(TerminalController.Service, instance.terminal),
      Effect.provideService(CircuitBreaker.Service, instance.circuitBreaker),
      Effect.map((text) => {
        // Inject open-edge count into status when present (instance-owned map).
        if (raw.trim().split(/\s+/)[0] === "status") {
          return text.replace(/SpawnEdges : \d+ open/, `SpawnEdges : ${edges} open`)
        }
        return text
      }),
    )
  })

export * as LoopCommand from "./command"
