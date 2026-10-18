import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { BrainSchema } from "./schema"

// brain.db, a SQLite file of its own beside vector.db: erasing all memory deletes one folder, session repair, export
// and sharing never touch it, and secure_delete costs the session database nothing. `repository_id` is "" for the
// personal scope, so every lookup is a plain equality.

export const BrainEntryTable = sqliteTable(
  "brain_entry",
  {
    id: text().primaryKey(),
    scope: text().$type<BrainSchema.Scope>().notNull(),
    repository_id: text().notNull(),
    kind: text().$type<BrainSchema.Kind>().notNull(),
    origin: text().$type<BrainSchema.Origin>().notNull(),
    status: text().$type<BrainSchema.Status>().notNull(),
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    body: text().notNull(),
    paths: text({ mode: "json" }).$type<string[]>().notNull(),
    terms: text().notNull(),
    norm_hash: text().notNull(),
    confidence: real().notNull(),
    uses: integer().notNull().default(0),
    helpful: integer().notNull().default(0),
    harmful: integer().notNull().default(0),
    last_used_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    superseded_by: text(),
    stale: integer({ mode: "boolean" }).notNull().default(false),
    hold_reason: text().$type<BrainSchema.Hold>(),
    related: text({ mode: "json" }).$type<string[]>().notNull(),
    // Already in the cached prefix (an unscoped rule, MEMORY.md within its budget), so never recalled again.
    tier0: integer({ mode: "boolean" }).notNull().default(false),
    // Mirrors of a file: the file, the item's line, and its position so the digest keeps the file's order.
    source_file: text(),
    source_line: integer(),
    origin_session_id: text(),
    signature: text(),
  },
  (table) => [
    index("brain_entry_repository_status_idx").on(table.repository_id, table.status),
    index("brain_entry_source_idx").on(table.source_file),
    index("brain_entry_hash_idx").on(table.repository_id, table.norm_hash),
  ],
)

export const BrainEvidenceTable = sqliteTable(
  "brain_evidence",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    entry_id: text()
      .notNull()
      .references(() => BrainEntryTable.id, { onDelete: "cascade" }),
    type: text().$type<BrainSchema.Evidence["type"]>().notNull(),
    path: text(),
    quote: text(),
    // The cited file's content hash when the evidence was checked; a different hash later makes the entry stale.
    file_hash: text(),
    command: text(),
    session_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [index("brain_evidence_entry_idx").on(table.entry_id)],
)

// What happened to an entry, newest last: the "recently learned" list, and the prior text an undo restores.
export const BrainEventTable = sqliteTable(
  "brain_event",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    entry_id: text().notNull(),
    repository_id: text().notNull(),
    at: integer().notNull(),
    action: text().notNull(),
    actor: text().$type<"user" | "agent" | "vector">().notNull(),
    detail: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [index("brain_event_repository_idx").on(table.repository_id, table.at)],
)

// A forgotten entry leaves only the hash of its normalised text, so Vector does not learn it again. No text is kept.
export const BrainTombstoneTable = sqliteTable(
  "brain_tombstone",
  {
    repository_id: text().notNull(),
    norm_hash: text().notNull(),
    until: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.repository_id, table.norm_hash] })],
)

// The files the brain mirrors and the content it last read from each, so an unchanged file is never parsed again.
export const BrainSourceTable = sqliteTable("brain_source", {
  path: text().primaryKey(),
  repository_id: text().notNull(),
  content_hash: text().notNull(),
  size: integer().notNull(),
  mtime: integer().notNull(),
  held: integer({ mode: "boolean" }).notNull().default(false),
  // Rules and MEMORY.md as the agent reads them in the cached prefix, rendered once when the file changes.
  digest: text(),
  synced_at: integer().notNull(),
})

// One row per repository and one for the personal scope (""). `revision` changes on every write, so an engine process
// can tell from one row whether what it cached is still current.
export const BrainStateTable = sqliteTable("brain_state", {
  repository_id: text().primaryKey(),
  revision: integer().notNull().default(0),
  learning: integer({ mode: "boolean" }).notNull().default(true),
  consolidated_at: integer(),
})

// Which entries reached which session, and through which tier. Pruned after 30 days.
export const BrainUseTable = sqliteTable(
  "brain_use",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text().notNull(),
    entry_id: text().notNull(),
    tier: text().$type<"digest" | "recall" | "attach" | "search">().notNull(),
    tokens: integer().notNull(),
    at: integer().notNull(),
  },
  (table) => [index("brain_use_session_idx").on(table.session_id)],
)
