import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const MemoryChunkTable = sqliteTable("chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: text("hash").notNull().unique(),
  path: text("path").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  text: text("text").notNull(),
  source: text("source").notNull(),
  accessCount: integer("access_count").notNull().default(0),
  mtimeMs: integer("mtime_ms").notNull().default(0),
})
