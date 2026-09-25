import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925201455_public_session_pending_updates",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_public_share\` ADD \`dirty\` integer DEFAULT true NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
