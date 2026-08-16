import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815234338_bright_violations",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`hooks_session_start\` text DEFAULT 'pending' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
