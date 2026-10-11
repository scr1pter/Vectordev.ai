import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011044552_session_internal_helpers",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`internal\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_tokens_input\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_tokens_output\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_tokens_reasoning\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_tokens_cache_read\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`subagent_tokens_cache_write\` integer DEFAULT 0 NOT NULL;`)
      // Existing descendants count too. Each ancestor/descendant pair appears once; own counters exclude children.
      yield* tx.run(`
        WITH RECURSIVE ancestry(ancestor, descendant) AS (
          SELECT parent_id, id FROM session WHERE parent_id IS NOT NULL
          UNION
          SELECT session.parent_id, ancestry.descendant
          FROM session JOIN ancestry ON session.id = ancestry.ancestor
          WHERE session.parent_id IS NOT NULL
        )
        UPDATE session SET
          subagent_tokens_input = coalesce((SELECT sum(child.tokens_input) FROM ancestry JOIN session child ON child.id = ancestry.descendant WHERE ancestry.ancestor = session.id AND child.id != session.id), 0),
          subagent_tokens_output = coalesce((SELECT sum(child.tokens_output) FROM ancestry JOIN session child ON child.id = ancestry.descendant WHERE ancestry.ancestor = session.id AND child.id != session.id), 0),
          subagent_tokens_reasoning = coalesce((SELECT sum(child.tokens_reasoning) FROM ancestry JOIN session child ON child.id = ancestry.descendant WHERE ancestry.ancestor = session.id AND child.id != session.id), 0),
          subagent_tokens_cache_read = coalesce((SELECT sum(child.tokens_cache_read) FROM ancestry JOIN session child ON child.id = ancestry.descendant WHERE ancestry.ancestor = session.id AND child.id != session.id), 0),
          subagent_tokens_cache_write = coalesce((SELECT sum(child.tokens_cache_write) FROM ancestry JOIN session child ON child.id = ancestry.descendant WHERE ancestry.ancestor = session.id AND child.id != session.id), 0);
      `)
      // Helper sessions created before the column existed are known by the titles Vector gave them. Classifying them
      // takes them out of session lists without deleting them or their spend.
      yield* tx.run(`
        UPDATE \`session\` SET \`internal\` = CASE
          WHEN \`title\` = 'Vector Tool · Autocomplete' THEN 'codespace.autocomplete'
          WHEN \`title\` = 'Vector Tool · Browser Agent Planner' THEN 'browser-agent.planner'
          WHEN \`title\` GLOB 'Vector Tool · *' THEN 'codespace.edit'
          WHEN \`title\` GLOB 'Vectorscope review · * · verify' THEN 'vectorscope.verify'
          WHEN \`title\` GLOB 'Vectorscope review · * · security' THEN 'vectorscope.security'
          ELSE 'vectorscope.review'
        END
        WHERE \`internal\` IS NULL AND (\`title\` GLOB 'Vector Tool · *' OR \`title\` GLOB 'Vectorscope review · *');
      `)
      // The desktop's swarm planner gave its sessions no title of their own; they are known by the prompt it sent.
      yield* tx.run(`
        UPDATE \`session\` SET \`internal\` = 'swarm.planner'
        WHERE \`internal\` IS NULL AND \`id\` IN (
          SELECT \`session_id\` FROM \`session_input\`
          WHERE json_extract(\`prompt\`, '$.text') GLOB 'You are Vector''s read-only swarm coordinator.*'
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
