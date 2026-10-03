import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003055810_session_subagent_spend",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_cost\` real DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_unpriced_steps\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
