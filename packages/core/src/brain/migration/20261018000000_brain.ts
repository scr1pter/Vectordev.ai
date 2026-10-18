import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

export default {
  id: "20261018000000_brain",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`brain_entry\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`repository_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`status\` text NOT NULL,
          \`pinned\` integer DEFAULT false NOT NULL,
          \`body\` text NOT NULL,
          \`paths\` text NOT NULL,
          \`terms\` text NOT NULL,
          \`norm_hash\` text NOT NULL,
          \`confidence\` real NOT NULL,
          \`uses\` integer DEFAULT 0 NOT NULL,
          \`helpful\` integer DEFAULT 0 NOT NULL,
          \`harmful\` integer DEFAULT 0 NOT NULL,
          \`last_used_at\` integer,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`superseded_by\` text,
          \`stale\` integer DEFAULT false NOT NULL,
          \`hold_reason\` text,
          \`related\` text NOT NULL,
          \`tier0\` integer DEFAULT false NOT NULL,
          \`source_file\` text,
          \`source_line\` integer,
          \`origin_session_id\` text,
          \`signature\` text
        );
      `)
      yield* tx.run(
        "CREATE INDEX `brain_entry_repository_status_idx` ON `brain_entry` (`repository_id`, `status`);",
      )
      yield* tx.run("CREATE INDEX `brain_entry_source_idx` ON `brain_entry` (`source_file`);")
      yield* tx.run("CREATE INDEX `brain_entry_hash_idx` ON `brain_entry` (`repository_id`, `norm_hash`);")
      yield* tx.run(`
        CREATE TABLE \`brain_evidence\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`entry_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`path\` text,
          \`quote\` text,
          \`file_hash\` text,
          \`command\` text,
          \`session_id\` text,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_brain_evidence_entry_id_brain_entry_id_fk\` FOREIGN KEY (\`entry_id\`) REFERENCES \`brain_entry\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE INDEX `brain_evidence_entry_idx` ON `brain_evidence` (`entry_id`);")
      yield* tx.run(`
        CREATE TABLE \`brain_event\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`entry_id\` text NOT NULL,
          \`repository_id\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`action\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`detail\` text
        );
      `)
      yield* tx.run("CREATE INDEX `brain_event_repository_idx` ON `brain_event` (`repository_id`, `at`);")
      yield* tx.run(`
        CREATE TABLE \`brain_tombstone\` (
          \`repository_id\` text NOT NULL,
          \`norm_hash\` text NOT NULL,
          \`until\` integer NOT NULL,
          CONSTRAINT \`brain_tombstone_pk\` PRIMARY KEY(\`repository_id\`, \`norm_hash\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`brain_source\` (
          \`path\` text PRIMARY KEY,
          \`repository_id\` text NOT NULL,
          \`content_hash\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`mtime\` integer NOT NULL,
          \`held\` integer DEFAULT false NOT NULL,
          \`digest\` text,
          \`synced_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`brain_state\` (
          \`repository_id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`learning\` integer DEFAULT true NOT NULL,
          \`consolidated_at\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`brain_use\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`session_id\` text NOT NULL,
          \`entry_id\` text NOT NULL,
          \`tier\` text NOT NULL,
          \`tokens\` integer NOT NULL,
          \`at\` integer NOT NULL
        );
      `)
      yield* tx.run("CREATE INDEX `brain_use_session_idx` ON `brain_use` (`session_id`);")
    })
  },
} satisfies DatabaseMigration.Migration
