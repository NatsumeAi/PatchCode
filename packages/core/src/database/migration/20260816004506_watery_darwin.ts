import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816004506_watery_darwin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`plan_mode\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
