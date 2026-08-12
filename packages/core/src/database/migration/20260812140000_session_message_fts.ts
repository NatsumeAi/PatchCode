import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * W7: FTS5 index over session message JSON for content search.
 * Maintained by triggers so projector insert/update/delete stay consistent.
 * Also backfills existing rows. Included in schema.gen via hand patch for empty DBs.
 */
export default {
  id: "20260812140000_session_message_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`session_message_fts\` USING fts5(
          text,
          session_id UNINDEXED,
          message_id UNINDEXED
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`session_message_fts_ai\` AFTER INSERT ON \`session_message\` BEGIN
          INSERT INTO \`session_message_fts\`(text, session_id, message_id)
          VALUES (cast(new.data as text), new.session_id, new.id);
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`session_message_fts_ad\` AFTER DELETE ON \`session_message\` BEGIN
          DELETE FROM \`session_message_fts\` WHERE message_id = old.id;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`session_message_fts_au\` AFTER UPDATE OF data ON \`session_message\` BEGIN
          DELETE FROM \`session_message_fts\` WHERE message_id = old.id;
          INSERT INTO \`session_message_fts\`(text, session_id, message_id)
          VALUES (cast(new.data as text), new.session_id, new.id);
        END
      `)
      // Backfill (ignore if empty).
      yield* tx.run(`
        INSERT INTO \`session_message_fts\`(text, session_id, message_id)
        SELECT cast(data as text), session_id, id FROM \`session_message\`
        WHERE id NOT IN (SELECT message_id FROM \`session_message_fts\`)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
