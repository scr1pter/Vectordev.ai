import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925200604_public_session_sharing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`public_session_consent\` (
          \`owner\` text PRIMARY KEY,
          \`version\` integer NOT NULL,
          \`updates\` integer NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_public_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL UNIQUE,
          \`secret\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`engine\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`content_hash\` text NOT NULL,
          \`updates\` integer NOT NULL,
          \`state\` text NOT NULL,
          CONSTRAINT \`fk_session_public_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`share_info\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
