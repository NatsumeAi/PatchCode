import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814051600_add_epoch_prompt_tape",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`tape_json\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
