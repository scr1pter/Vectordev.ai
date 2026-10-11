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
