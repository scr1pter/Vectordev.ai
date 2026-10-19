import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// What the agent learns after reading a private document is private too: withheld where the document is.
export default {
  id: "20261102000000_private_memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_entry` ADD `private` integer DEFAULT false NOT NULL;")
    })
  },
} satisfies DatabaseMigration.Migration
