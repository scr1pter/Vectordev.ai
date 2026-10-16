import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015171500_classify_early_review_helpers",
  up(tx) {
    return Effect.gen(function* () {
      // Before the reviewer was called Vectorscope, the desktop titled its pull request reviewers
      // "Vector review · #12 · review" (1.99.8) or "Vecbot review · #12 · review" (builds of 18 September), and
      // `vector review` titled its sessions the same way with the seven-character commit, "Vector review · 1a2b3c4 ·
      // verify". Only those exact shapes are classified, with a pull request number or a commit between the
      // separators, so a session the user titled "Vector review · login · review" stays in the lists. Nothing is
      // deleted. Both prefixes are 16 characters long, so the middle starts at character 17.
      yield* tx.run(`
        WITH early(id, middle, specialist) AS (
          SELECT
            \`id\`,
            substr(\`title\`, 17, instr(substr(\`title\`, 17), ' · ') - 1),
            substr(\`title\`, 19 + instr(substr(\`title\`, 17), ' · '))
          FROM \`session\`
          WHERE \`internal\` IS NULL AND (\`title\` GLOB 'Vector review · * · *' OR \`title\` GLOB 'Vecbot review · * · *')
        )
        UPDATE \`session\` SET \`internal\` = 'vectorscope.' || (SELECT specialist FROM early WHERE early.id = \`session\`.\`id\`)
        WHERE \`id\` IN (
          SELECT id FROM early
          WHERE specialist IN ('review', 'security', 'verify') AND (
            (middle GLOB '#[0-9]*' AND substr(middle, 2) NOT GLOB '*[^0-9]*') OR
            middle GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          )
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
