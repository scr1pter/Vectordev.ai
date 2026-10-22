import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Deep research in the brain: documents learn where a page was read from and which run read it, and three tables hold
// runs, their sources and their notes. Written by hand like the brain's other migrations. The trigger clears a run's
// report when its document goes, however it goes (Forget, Erase, a rejected review), so no copy of the report's text
// outlives it.
export default {
  id: "20261201000000_research",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_document` ADD `source_url` text;")
      yield* tx.run("ALTER TABLE `brain_document` ADD `fetched_at` integer;")
      yield* tx.run("ALTER TABLE `brain_document` ADD `run_id` text;")
      yield* tx.run("CREATE INDEX `brain_document_run_idx` ON `brain_document` (`run_id`);")
      yield* tx.run(`
        CREATE TABLE \`research_run\` (
          \`id\` text PRIMARY KEY,
          \`repository_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`question\` text NOT NULL,
          \`plan\` text,
          \`depth\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`status\` text NOT NULL,
          \`report_document_id\` text,
          \`report\` text,
          \`queries\` text NOT NULL,
          \`limits\` text,
          \`pages\` integer DEFAULT 0 NOT NULL,
          \`searches\` integer DEFAULT 0 NOT NULL,
          \`cost_usd\` real DEFAULT 0 NOT NULL,
          \`steps\` integer DEFAULT 0 NOT NULL,
          \`kept\` integer DEFAULT false NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_research_run_report_document_id_brain_document_id_fk\` FOREIGN KEY (\`report_document_id\`) REFERENCES \`brain_document\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run("CREATE INDEX `research_run_repository_idx` ON `research_run` (`repository_id`, `created_at`);")
      yield* tx.run("CREATE INDEX `research_run_session_idx` ON `research_run` (`session_id`);")
      yield* tx.run(`
        CREATE TABLE \`research_source\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`url\` text NOT NULL,
          \`canonical_url\` text NOT NULL,
          \`title\` text NOT NULL,
          \`site\` text NOT NULL,
          \`author\` text,
          \`published_at\` text,
          \`kind\` text NOT NULL,
          \`status\` text NOT NULL,
          \`reason\` text,
          \`duplicate_of\` text,
          \`signals\` text,
          \`private\` integer DEFAULT false NOT NULL,
          \`pages\` integer,
          \`document_id\` text,
          \`fetched_at\` integer,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_research_source_run_id_research_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`research_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_research_source_document_id_brain_document_id_fk\` FOREIGN KEY (\`document_id\`) REFERENCES \`brain_document\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run("CREATE UNIQUE INDEX `research_source_ordinal_idx` ON `research_source` (`run_id`, `ordinal`);")
      yield* tx.run(`
        CREATE TABLE \`research_note\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`subquestion\` text NOT NULL,
          \`claim\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`passage_id\` text,
          \`quote\` text NOT NULL,
          \`page\` integer,
          \`stance\` text NOT NULL,
          \`support\` integer NOT NULL,
          \`verdict\` text,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_research_note_run_id_research_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`research_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_research_note_source_id_research_source_id_fk\` FOREIGN KEY (\`source_id\`) REFERENCES \`research_source\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run("CREATE UNIQUE INDEX `research_note_ordinal_idx` ON `research_note` (`run_id`, `ordinal`);")
      yield* tx.run("CREATE INDEX `research_note_source_idx` ON `research_note` (`source_id`);")
      // The foreign key may have set report_document_id to null before this runs, or not yet: either way it was this
      // document, so both cases clear the report.
      yield* tx.run(`
        CREATE TRIGGER \`research_report_forgotten\` AFTER DELETE ON \`brain_document\`
        WHEN OLD.\`run_id\` IS NOT NULL AND OLD.\`origin\` = 'research'
        BEGIN
          UPDATE \`research_run\` SET \`report\` = NULL, \`report_document_id\` = NULL
          WHERE \`id\` = OLD.\`run_id\` AND (\`report_document_id\` IS NULL OR \`report_document_id\` = OLD.\`id\`);
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
