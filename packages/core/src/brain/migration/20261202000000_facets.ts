import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Learning about you (section 6.3): entries learn what they are about (a facet) and a term its word or phrase, and the
// personal state row keeps which facets Vector may learn and when the model learner runs. Written by hand like the
// brain's other migrations.
export default {
  id: "20261202000000_facets",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_entry` ADD `facet` text;")
      yield* tx.run("ALTER TABLE `brain_entry` ADD `term_key` text;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `learn_facets` text;")
      yield* tx.run("ALTER TABLE `brain_state` ADD `model_learner` text;")
    })
  },
} satisfies DatabaseMigration.Migration
