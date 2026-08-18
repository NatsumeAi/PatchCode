export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/storage/Database") {}

/**
 * W7: ensure FTS5 + triggers exist even when empty-DB bootstrap marks migrations
 * complete without executing their SQL (schema.up path). Idempotent.
 */
function ensureSessionMessageFts(db: DatabaseShape) {
  return Effect.gen(function* () {
    yield* db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_message_fts USING fts5(
        text,
        session_id UNINDEXED,
        message_id UNINDEXED
      )
    `)
    yield* db.run(`
      CREATE TRIGGER IF NOT EXISTS session_message_fts_ai AFTER INSERT ON session_message BEGIN
        INSERT INTO session_message_fts(text, session_id, message_id)
        VALUES (cast(new.data as text), new.session_id, new.id);
      END
    `)
    yield* db.run(`
      CREATE TRIGGER IF NOT EXISTS session_message_fts_ad AFTER DELETE ON session_message BEGIN
        DELETE FROM session_message_fts WHERE message_id = old.id;
      END
    `)
    yield* db.run(`
      CREATE TRIGGER IF NOT EXISTS session_message_fts_au AFTER UPDATE OF data ON session_message BEGIN
        DELETE FROM session_message_fts WHERE message_id = old.id;
        INSERT INTO session_message_fts(text, session_id, message_id)
        VALUES (cast(new.data as text), new.session_id, new.id);
      END
    `)
  }).pipe(Effect.catch(() => Effect.void))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)
    yield* ensureSessionMessageFts(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
