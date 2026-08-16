export * as SessionReminders from "./reminders"

import path from "path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { FSUtil } from "../fs-util"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

const reminders = new Map<string, string>()

export const get = (sessionID: string) => reminders.get(sessionID)
export const set = (sessionID: string, text: string) => {
  reminders.set(sessionID, text)
}
export const clear = (sessionID: string) => {
  reminders.delete(sessionID)
}

const planPath = (directory: string, slug: string, created: number) =>
  path.join(directory, ".opencode", "plans", `${created}-${slug}.md`)

/** Plan/build reminder text for the live drain. Truth is session.plan_mode, not agent id. */
export const text = Effect.fn("SessionReminders.text")(function* (sessionID: SessionSchema.ID) {
  const { db } = yield* Database.Service
  const fs = yield* Effect.serviceOption(FSUtil.Service)
  const row = yield* db
    .select({
      plan_mode: SessionTable.plan_mode,
      agent: SessionTable.agent,
      directory: SessionTable.directory,
      slug: SessionTable.slug,
      created: SessionTable.time_created,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return ""
  if (row.plan_mode === 1) {
    const plan = planPath(row.directory, row.slug, row.created)
    const exists = fs._tag === "Some" ? yield* fs.value.existsSafe(plan) : false
    return PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    )
  }
  if (row.agent === "plan") return PROMPT_PLAN
  const previous = reminders.get(String(sessionID)) ?? ""
  if (previous.includes("Plan mode is active") || previous.includes("Plan Mode")) return BUILD_SWITCH
  return ""
})
