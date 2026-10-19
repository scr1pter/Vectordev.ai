import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// The code index: each repository's files, what they declare and import, and the routes, environment variables and
// constants they give, created empty and filled the first time a repository with documents is linked to its code.
export default {
  id: "20261120000000_code",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_state` ADD `code_revision` integer DEFAULT 0 NOT NULL;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `code_head` text;")
      yield* tx.run(`
        CREATE TABLE \`brain_code_file\` (
          \`repository_id\` text NOT NULL,
          \`path\` text NOT NULL,
          \`content_hash\` text NOT NULL,
          \`bytes\` integer NOT NULL,
          \`mtime\` integer NOT NULL,
          \`language\` text NOT NULL,
          \`imports\` text NOT NULL,
          \`dependencies\` text NOT NULL,
          \`co_change\` text NOT NULL,
          \`synced_at\` integer NOT NULL,
          CONSTRAINT \`brain_code_file_pk\` PRIMARY KEY(\`repository_id\`, \`path\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`brain_code_symbol\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`repository_id\` text NOT NULL,
          \`path\` text NOT NULL,
          \`name\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`line\` integer NOT NULL,
          \`exported\` integer NOT NULL,
          \`signature_hash\` text NOT NULL
        );
      `)
      yield* tx.run("CREATE INDEX `brain_code_symbol_name_idx` ON `brain_code_symbol` (`repository_id`, `name`);")
      yield* tx.run("CREATE INDEX `brain_code_symbol_path_idx` ON `brain_code_symbol` (`repository_id`, `path`);")
      yield* tx.run(`
        CREATE TABLE \`brain_code_literal\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`repository_id\` text NOT NULL,
          \`path\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`value\` text NOT NULL,
          \`method\` text,
          \`line\` integer NOT NULL
        );
      `)
      yield* tx.run("CREATE INDEX `brain_code_literal_value_idx` ON `brain_code_literal` (`repository_id`, `value`);")
      yield* tx.run("CREATE INDEX `brain_code_literal_path_idx` ON `brain_code_literal` (`repository_id`, `path`);")
    })
  },
} satisfies DatabaseMigration.Migration
