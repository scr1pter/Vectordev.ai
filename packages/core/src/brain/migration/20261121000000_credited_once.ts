import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// A request is credited once: its marker is written before anything it credits, and this index lets one in per
// repository, so two credits of one request that end together cannot both count it.
export default {
  id: "20261121000000_credited_once",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        "DELETE FROM `brain_event` WHERE `action` = 'credited' AND `id` NOT IN (SELECT min(`id`) FROM `brain_event` WHERE `action` = 'credited' GROUP BY `repository_id`, `entry_id`);",
      )
      yield* tx.run(
        "CREATE UNIQUE INDEX `brain_event_credited_idx` ON `brain_event` (`repository_id`, `entry_id`) WHERE `action` = 'credited';",
      )
    })
  },
} satisfies DatabaseMigration.Migration
