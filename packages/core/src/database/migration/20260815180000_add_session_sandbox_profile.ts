import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815180000_add_session_sandbox_profile",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`sandbox_profile\` text NOT NULL DEFAULT 'off';`)
    })
  },
} satisfies DatabaseMigration.Migration
