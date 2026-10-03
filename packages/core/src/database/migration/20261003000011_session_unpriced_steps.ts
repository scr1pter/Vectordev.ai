import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003000011_session_unpriced_steps",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`unpriced_steps\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
