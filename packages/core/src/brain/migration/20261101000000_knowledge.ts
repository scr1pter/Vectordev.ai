import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Documents and what Vector reads from them, created empty. Written by hand like the first migration: brain.db is not
// vector.db, and `brain_posting` is WITHOUT ROWID, which drizzle cannot declare.
export default {
  id: "20261101000000_knowledge",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`brain_document\` (
          \`id\` text PRIMARY KEY,
          \`repository_id\` text NOT NULL,
          \`lineage\` text NOT NULL,
          \`version\` integer DEFAULT 1 NOT NULL,
          \`previous_id\` text,
          \`ordinal\` integer NOT NULL,
          \`name\` text NOT NULL,
          \`title\` text NOT NULL,
          \`format\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`visibility\` text NOT NULL,
          \`content_hash\` text NOT NULL,
          \`bytes\` integer NOT NULL,
          \`pages\` integer,
          \`unread\` text NOT NULL,
          \`source_path\` text,
          \`stored\` integer DEFAULT false NOT NULL,
          \`status\` text NOT NULL,
          \`hold_reason\` text,
          \`stats\` text NOT NULL,
          \`warnings\` text NOT NULL,
          \`error\` text,
          \`extractor\` integer NOT NULL,
          \`embed_model\` text,
          \`origin_session_id\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`indexed_at\` integer
        );
      `)
      yield* tx.run("CREATE INDEX `brain_document_repository_idx` ON `brain_document` (`repository_id`, `status`);")
      yield* tx.run("CREATE INDEX `brain_document_hash_idx` ON `brain_document` (`repository_id`, `content_hash`);")
      yield* tx.run("CREATE INDEX `brain_document_lineage_idx` ON `brain_document` (`repository_id`, `lineage`);")
      yield* tx.run(
        "CREATE UNIQUE INDEX `brain_document_ordinal_idx` ON `brain_document` (`repository_id`, `ordinal`);",
      )
      yield* tx.run(`
        CREATE TABLE \`brain_section\` (
          \`id\` text PRIMARY KEY,
          \`document_id\` text NOT NULL,
          \`parent_id\` text,
          \`ordinal\` integer NOT NULL,
          \`level\` integer NOT NULL,
          \`heading\` text NOT NULL,
          \`path\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`page_start\` integer,
          \`page_end\` integer,
          \`tokens\` integer NOT NULL,
          CONSTRAINT \`fk_brain_section_document_id_brain_document_id_fk\` FOREIGN KEY (\`document_id\`) REFERENCES \`brain_document\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE INDEX `brain_section_document_idx` ON `brain_section` (`document_id`, `ordinal`);")
      yield* tx.run(`
        CREATE TABLE \`brain_item\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`repository_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`ref\` text NOT NULL,
          \`document_id\` text NOT NULL,
          \`visibility\` text NOT NULL,
          \`status\` text NOT NULL,
          \`hold_reason\` text,
          \`length\` integer NOT NULL,
          \`confidence\` real NOT NULL,
          \`uses\` integer DEFAULT 0 NOT NULL,
          \`helpful\` real DEFAULT 0 NOT NULL,
          \`harmful\` real DEFAULT 0 NOT NULL,
          \`ignored\` integer DEFAULT 0 NOT NULL,
          \`last_used_at\` integer,
          \`last_helpful_at\` integer,
          CONSTRAINT \`fk_brain_item_document_id_brain_document_id_fk\` FOREIGN KEY (\`document_id\`) REFERENCES \`brain_document\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE UNIQUE INDEX `brain_item_ref_unique` ON `brain_item` (`ref`);")
      yield* tx.run(
        "CREATE INDEX `brain_item_repository_idx` ON `brain_item` (`repository_id`, `status`, `visibility`);",
      )
      yield* tx.run(`
        CREATE TABLE \`brain_passage\` (
          \`id\` text PRIMARY KEY,
          \`item\` integer NOT NULL,
          \`document_id\` text NOT NULL,
          \`section_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`page\` integer,
          \`header\` text NOT NULL,
          \`body\` text NOT NULL,
          \`tokens\` integer NOT NULL,
          \`span_start\` integer NOT NULL,
          \`span_end\` integer NOT NULL,
          \`norm_hash\` text NOT NULL,
          CONSTRAINT \`fk_brain_passage_item_brain_item_id_fk\` FOREIGN KEY (\`item\`) REFERENCES \`brain_item\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_brain_passage_document_id_brain_document_id_fk\` FOREIGN KEY (\`document_id\`) REFERENCES \`brain_document\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE UNIQUE INDEX `brain_passage_item_unique` ON `brain_passage` (`item`);")
      yield* tx.run("CREATE INDEX `brain_passage_document_idx` ON `brain_passage` (`document_id`, `ordinal`);")
      yield* tx.run(`
        CREATE TABLE \`brain_record\` (
          \`id\` text PRIMARY KEY,
          \`item\` integer NOT NULL,
          \`document_id\` text NOT NULL,
          \`passage_id\` text NOT NULL,
          \`section_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`key\` text NOT NULL,
          \`subject\` text NOT NULL,
          \`card\` text NOT NULL,
          \`quote\` text NOT NULL,
          \`quote_hash\` text NOT NULL,
          \`fields\` text NOT NULL,
          \`polarity\` text NOT NULL,
          \`rule\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`user_edited\` integer DEFAULT false NOT NULL,
          \`pinned\` integer DEFAULT false NOT NULL,
          \`changed_version\` integer,
          \`page\` integer,
          \`span_start\` integer NOT NULL,
          \`span_end\` integer NOT NULL,
          \`norm_hash\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_brain_record_item_brain_item_id_fk\` FOREIGN KEY (\`item\`) REFERENCES \`brain_item\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_brain_record_document_id_brain_document_id_fk\` FOREIGN KEY (\`document_id\`) REFERENCES \`brain_document\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE UNIQUE INDEX `brain_record_item_unique` ON `brain_record` (`item`);")
      yield* tx.run("CREATE INDEX `brain_record_document_idx` ON `brain_record` (`document_id`);")
      yield* tx.run("CREATE INDEX `brain_record_subject_idx` ON `brain_record` (`subject`);")
      yield* tx.run("CREATE INDEX `brain_record_hash_idx` ON `brain_record` (`norm_hash`);")
      yield* tx.run(`
        CREATE TABLE \`brain_term\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`repository_id\` text NOT NULL,
          \`term\` text NOT NULL,
          \`df\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run("CREATE UNIQUE INDEX `brain_term_repository_idx` ON `brain_term` (`repository_id`, `term`);")
      yield* tx.run(`
        CREATE TABLE \`brain_posting\` (
          \`term\` integer NOT NULL,
          \`item\` integer NOT NULL,
          \`count\` integer NOT NULL,
          CONSTRAINT \`brain_posting_pk\` PRIMARY KEY(\`term\`, \`item\`),
          CONSTRAINT \`fk_brain_posting_item_brain_item_id_fk\` FOREIGN KEY (\`item\`) REFERENCES \`brain_item\`(\`id\`) ON DELETE CASCADE
        ) WITHOUT ROWID;
      `)
      yield* tx.run("CREATE INDEX `brain_posting_item_idx` ON `brain_posting` (`item`);")
      yield* tx.run(`
        CREATE TABLE \`brain_anchor\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`repository_id\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`path\` text NOT NULL,
          \`symbol\` text,
          \`line\` integer,
          \`method\` text NOT NULL,
          \`weight\` real NOT NULL,
          \`value\` text,
          \`file_hash\` text NOT NULL,
          \`line_hash\` text,
          \`status\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`checked_at\` integer NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run("CREATE INDEX `brain_anchor_path_idx` ON `brain_anchor` (`repository_id`, `path`);")
      yield* tx.run("CREATE INDEX `brain_anchor_owner_idx` ON `brain_anchor` (`owner`);")
      yield* tx.run(`
        CREATE TABLE \`brain_pending\` (
          \`repository_id\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`identifier\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`brain_pending_pk\` PRIMARY KEY(\`repository_id\`, \`owner\`, \`identifier\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`brain_edge\` (
          \`repository_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`target\` text NOT NULL,
          \`type\` text NOT NULL,
          \`weight\` real NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`brain_edge_pk\` PRIMARY KEY(\`source\`, \`type\`, \`target\`)
        );
      `)
      yield* tx.run("CREATE INDEX `brain_edge_target_idx` ON `brain_edge` (`repository_id`, `target`);")
      yield* tx.run(`
        CREATE TABLE \`brain_vector\` (
          \`item\` integer PRIMARY KEY,
          \`repository_id\` text NOT NULL,
          \`model\` text NOT NULL,
          \`q8\` blob NOT NULL,
          \`bits\` blob NOT NULL,
          \`scale\` real NOT NULL,
          \`norm_hash\` text NOT NULL,
          \`embedded_at\` integer NOT NULL,
          CONSTRAINT \`fk_brain_vector_item_brain_item_id_fk\` FOREIGN KEY (\`item\`) REFERENCES \`brain_item\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE INDEX `brain_vector_repository_idx` ON `brain_vector` (`repository_id`, `model`);")
      yield* tx.run(`
        CREATE TABLE \`brain_job\` (
          \`id\` text PRIMARY KEY,
          \`repository_id\` text NOT NULL,
          \`document_id\` text,
          \`kind\` text NOT NULL,
          \`state\` text NOT NULL,
          \`lease_owner\` text,
          \`lease_until\` integer,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`next_at\` integer NOT NULL,
          \`done\` integer DEFAULT 0 NOT NULL,
          \`total\` integer DEFAULT 0 NOT NULL,
          \`error\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_brain_job_document_id_brain_document_id_fk\` FOREIGN KEY (\`document_id\`) REFERENCES \`brain_document\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE INDEX `brain_job_state_idx` ON `brain_job` (`state`, `next_at`);")
      yield* tx.run(`
        CREATE TABLE \`brain_review\` (
          \`id\` text PRIMARY KEY,
          \`repository_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`a\` text NOT NULL,
          \`b\` text,
          \`subject\` text NOT NULL,
          \`detail\` text NOT NULL,
          \`status\` text NOT NULL,
          \`winner\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run("CREATE INDEX `brain_review_repository_idx` ON `brain_review` (`repository_id`, `status`);")
      yield* tx.run("ALTER TABLE `brain_state` ADD `knowledge_revision` integer DEFAULT 0 NOT NULL;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `items` integer DEFAULT 0 NOT NULL;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `item_length_sum` integer DEFAULT 0 NOT NULL;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `repository_docs` integer DEFAULT true NOT NULL;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `keep_originals` integer DEFAULT false NOT NULL;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `scanned_at` integer;")
      yield* tx.run("ALTER TABLE `brain_use` ADD `request_id` text;")
      yield* tx.run("ALTER TABLE `brain_use` ADD `cited` integer DEFAULT false NOT NULL;")
      yield* tx.run("ALTER TABLE `brain_use` ADD `outcome` text;")
    })
  },
} satisfies DatabaseMigration.Migration
