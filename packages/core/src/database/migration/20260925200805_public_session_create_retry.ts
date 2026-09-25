import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925200805_public_session_create_retry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_public_share\` ADD \`initial_archive\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
