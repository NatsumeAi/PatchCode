import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

/**
 * Crash-durable ledger for background jobs (W3).
 * Live registry remains in-memory; this table is the source of truth across restarts.
 */
export const BackgroundJobTable = sqliteTable(
  "background_job",
  {
    id: text().primaryKey(),
    type: text().notNull(),
    status: text().notNull(), // running | completed | error | cancelled
    title: text(),
    session_id: text(),
    started_at: integer().notNull(),
    heartbeat_at: integer().notNull(),
    completed_at: integer(),
    error: text(),
    output: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("background_job_status_heartbeat_idx").on(table.status, table.heartbeat_at),
    index("background_job_session_idx").on(table.session_id),
  ],
)
