import { readEnv } from "../flag/compat"
export * as Database from "./database"

import { EffectDrizzleSqlite } from "@vectordevai/effect-drizzle-sqlite"
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

export class Service extends Context.Service<Service, Interface>()("@vector/v2/storage/Database") {}

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

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.VECTOR_AGENT_DB) {
    if (Flag.VECTOR_AGENT_DB === ":memory:" || isAbsolute(Flag.VECTOR_AGENT_DB)) return Flag.VECTOR_AGENT_DB
    return join(Global.Path.data, Flag.VECTOR_AGENT_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    readEnv("VECTOR_DISABLE_CHANNEL_DB") === "1" ||
    readEnv("VECTOR_DISABLE_CHANNEL_DB") === "true"
  )
    return join(Global.Path.data, "vector.db")
  return join(Global.Path.data, `vector-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

// Resolve the configured path when the application layer is built, not when this
// module is imported. Embedded hosts and test runners intentionally set the
// database flag before constructing a runtime, and import-time capture otherwise
// leaves every later host bound to a stale (and potentially deleted) directory.
export const node = makeGlobalNode({ service: Service, layer: Layer.suspend(() => layerFromPath(path())), deps: [] })
