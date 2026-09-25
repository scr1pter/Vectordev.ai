import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"
import type { PublicSession } from "@vectordevai/schema/public-session"

// Restrict deletion: the only management secret must survive failed remote deletion.
export const PublicSessionShareTable = sqliteTable("session_public_share", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "restrict" }),
  id: text().notNull().unique(),
  secret: text().notNull(),
  owner: text().notNull(),
  engine: text().$type<"v1" | "v2">().notNull(),
  expires_at: integer().notNull(),
  updated_at: integer().notNull(),
  revision: integer().notNull(),
  content_hash: text().notNull(),
  initial_archive: text({ mode: "json" }).$type<PublicSession.Archive>(),
  updates: integer({ mode: "boolean" }).notNull(),
  dirty: integer({ mode: "boolean" }).notNull().default(true),
  state: text().$type<"creating" | "active" | "deleting">().notNull(),
})

export const PublicSessionConsentTable = sqliteTable("public_session_consent", {
  owner: text().primaryKey(),
  version: integer().notNull(),
  updates: integer({ mode: "boolean" }).notNull(),
  created_at: integer().notNull(),
})
