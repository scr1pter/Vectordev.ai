import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Proven knowledge decays: each repository remembers when its document credit last halved toward zero, so a pass
// decays it by exactly the time since.
export default {
  id: "20261104000000_credit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_state` ADD `credited_at` integer;")
    })
  },
} satisfies DatabaseMigration.Migration
