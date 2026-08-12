import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812132842_add_background_job",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`background_job\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`status\` text NOT NULL,
          \`title\` text,
          \`session_id\` text,
          \`started_at\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`completed_at\` integer,
          \`error\` text,
          \`output\` text,
          \`metadata\` text
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`background_job_status_heartbeat_idx\` ON \`background_job\` (\`status\`,\`heartbeat_at\`);`,
      )
      yield* tx.run(`CREATE INDEX \`background_job_session_idx\` ON \`background_job\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
