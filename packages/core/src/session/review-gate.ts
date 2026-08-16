export * as ReviewGate from "./review-gate"

import fs from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Global } from "../global"

export class Failed extends Schema.TaggedErrorClass<Failed>()("ReviewGate.Failed", {
  sessionID: Schema.String,
  verdict: Schema.String,
}) {
  override get message() {
    return `Review gate blocked merge for session ${this.sessionID} (last verdict: ${this.verdict})`
  }
}

type State = {
  enabled: boolean
  verdict?: "pass" | "fail"
}

const sessions = new Map<string, State>()

const persistFile = () => path.join(Global.Path.data, "review-gate.json")

const load = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(persistFile(), "utf8")) as Record<string, State>
    if (!raw || typeof raw !== "object") return
    for (const [id, state] of Object.entries(raw)) {
      if (!state || typeof state !== "object") continue
      sessions.set(id, { enabled: Boolean(state.enabled), verdict: state.verdict })
    }
  } catch {
    // missing or invalid
  }
}

const save = () => {
  try {
    fs.mkdirSync(path.dirname(persistFile()), { recursive: true })
    fs.writeFileSync(persistFile(), JSON.stringify(Object.fromEntries(sessions)))
  } catch {
    // best-effort
  }
}

load()

export const setEnabled = (sessionID: string, enabled: boolean) =>
  Effect.sync(() => {
    const current = sessions.get(sessionID) ?? { enabled: false }
    sessions.set(sessionID, { ...current, enabled })
    save()
  })

export const record = (sessionID: string, verdict: "pass" | "fail") =>
  Effect.sync(() => {
    const current = sessions.get(sessionID) ?? { enabled: false }
    sessions.set(sessionID, { ...current, verdict })
    save()
  })

export const last = (sessionID: string) => Effect.sync(() => sessions.get(sessionID))

export const assertMerge = (sessionID: string) =>
  Effect.gen(function* () {
    if (sessions.size === 0) load()
    const state = sessions.get(sessionID)
    if (!state?.enabled) return
    if (state.verdict === "fail") return yield* new Failed({ sessionID, verdict: "fail" })
  })

export const reset = (sessionID?: string) =>
  Effect.sync(() => {
    if (sessionID) sessions.delete(sessionID)
    else sessions.clear()
    save()
  })
