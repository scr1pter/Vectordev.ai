import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// What the user took out of memory keeps its words' terms and their way round, so a close rewording of it is not
// learned again either.
export default {
  id: "20261103000000_tombstone_terms",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_tombstone` ADD `terms` text;")
      yield* tx.run("ALTER TABLE `brain_tombstone` ADD `polarity` text;")
    })
  },
} satisfies DatabaseMigration.Migration
