import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816005001_wealthy_clea",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_compaction_checkpoint\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`tape_json\` text NOT NULL,
          \`message_ids_json\` text NOT NULL,
          CONSTRAINT \`fk_session_compaction_checkpoint_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_compaction_checkpoint_session_idx\` ON \`session_compaction_checkpoint\` (\`session_id\`,\`created_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
