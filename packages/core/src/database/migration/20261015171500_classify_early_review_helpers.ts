import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015171500_classify_early_review_helpers",
  up(tx) {
    return Effect.gen(function* () {
      // Desktop 1.99.8 titled its pull request reviewers "Vector review · #12 · review" and `vector review` titled its
      // sessions "Vector review · 1a2b3c4 · verify", before the reviewer was called Vectorscope. Only those exact
      // shapes are classified, so they leave session lists like later reviews did; nothing is deleted.
      yield* tx.run(`
        UPDATE \`session\` SET \`internal\` = CASE
          WHEN \`title\` GLOB 'Vector review · * · security' THEN 'vectorscope.security'
          WHEN \`title\` GLOB 'Vector review · * · verify' THEN 'vectorscope.verify'
          ELSE 'vectorscope.review'
        END
        WHERE \`internal\` IS NULL AND (
          \`title\` GLOB 'Vector review · * · review' OR
          \`title\` GLOB 'Vector review · * · security' OR
          \`title\` GLOB 'Vector review · * · verify'
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
