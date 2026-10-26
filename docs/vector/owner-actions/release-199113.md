# Desktop 1.99.113: release notes and owner steps (draft)

Desktop 1.99.113 brings learned skills, workflow insights (learned workflow defaults) and the prompt guard. This file is a draft written before the release: no version is bumped yet, and the notes below go into `packages/web/src/data/vector-releases.ts` and `packages/web/public/changelog.json` only in the release preparation commit. The build contract is `.vector-build/self-evolving-spec.md` on the `self-evolving` branch.

The site deploys from main, so every docs paragraph about these features starts with `release113.since` ("Coming in desktop 1.99.113:" until `publishedDesktopVersion` reaches 1.99.113, then "From desktop 1.99.113:"). `packages/web/test/release-113-docs.test.ts` holds the pages to it.

## Release notes (draft)

**Title:** Learned skills, workflow insights and the prompt guard

**Summary:**

When a run turns a failing check green, Vector drafts the steps that worked as a skill for that repository. A draft waits for your review in Settings → Memory → Skills; a learned skill is guidance the agent may load, never a rule, and it names only a short allowed list of commands. Settings → Memory → Workflow insights shows which effort, subagent split and subagent model got each size of work passing here, and at what cost, and a cheaper setting that passes as often becomes the learned default when you leave effort on Default. Learned defaults never raise spend, never override your own picks and leave spend caps unchanged. Owner-only `vector memory` commands refuse to run from an agent's shell or Vector's own terminal, and an edit to a file that feeds a system prompt asks every time. Learned skills and workflow insights stay in brain.db on this computer; usage check-ins are unchanged.

## What blocks the publish

The 1.99.113 publish waits for these work packages and their focused tests. Each runs its own test files from its package directory, one file at a time.

1. **WP1, core brain data and learning logic.** `packages/core/test/brain/database.test.ts`, `migration-learned.test.ts`, `skill-commands.test.ts`, `skill.test.ts`, `skill-older-builds.test.ts`, `brain.test.ts`, `workflow.test.ts` and `export.test.ts`; `packages/core/test/spend-guard.test.ts`, `share/archive-learned.test.ts` and `task-size.test.ts`.
2. **WP2, the engine runtime.** `packages/engine/test/session/skill-learn.test.ts`, `workflow-learn.test.ts`, `skill-credit.test.ts`, `local-carried.test.ts`, `system.test.ts` and `llm-request.test.ts`; `test/skill/learned.test.ts`; `test/tool/skill.test.ts` and `memory-skill.test.ts`.
3. **WP3, the surfaces.** `packages/engine/test/server/memory-skills.test.ts` and `memory-workflow.test.ts`; `test/cli/memory-agent.test.ts`, `memory-skill.test.ts` and `usage-report-learning.test.ts`; `packages/desktop/src/main/usage-checkin.test.ts`; the app's `memory-skills-model.test.ts`, `memory-workflow-model.test.ts`, `memory-model.test.ts`, `settings-registry.test.ts`, `learned.test.ts`, `workflow.test.ts` and `economics-repository.test.ts`; and `packages/web/test/release-113-docs.test.ts`, `brain-docs.test.ts` and `release-111-docs.test.ts`.
4. **WP5, owner trust and the prompt guard.** `packages/schema/test/permission-policy.test.ts`, `packages/tui/test/util/permission.test.ts`, `packages/engine/test/session/prompt-guard.test.ts`, `test/cli/trust.test.ts` and `test/skill/fmt.test.ts`.

Offline prompt evolution (WP4) is a script harness that never ships, so it does not block the publish.

Then the release needs the usual checks on the release commit: the package typechecks, both SDK generators, CI on Linux and Windows, and the Verify workflow.

## Before you release the desktop

1. **Decide what the build leaves open:**
   - A `vector serve` with no password treats every local program, the agent's shell included, as the owner, so it could approve a skill over HTTP. The docs tell you to set `VECTOR_SERVER_PASSWORD` when serving.
   - A check a skill names runs the repository's own code (`npm test` runs whatever `package.json` says), as any check the agent runs does.
   - Erasing one session from an older Vector build does not reach learned skills; erasing a repository or everything from an older build is finished the next time 1.99.113 opens that memory.
   - The prompt guard asks before Vector's own edits and common shell writes change a prompt file, and holds changed prompt files outside the repository until you approve them. It does not catch interpreters, the V2 bash tool or MCP filesystem servers: it is an ask and a hold, and the docs and app copy say no more than that.
   - The owner-only commands (`vector memory skills approve`, `vector trust prompts approve` and the rest) refuse under the agent marker, and the shell asks every time before a command that removes it (`unset`, `env -u`, `env -i`, `exec -c`). A program that clears its children's environment some way the shell scan does not see (a script, an interpreter) can still run them as the owner, as an interpreter can still write brain.db or the prompt baseline. Only the opt-in shell sandbox (`VECTOR_SHELL_SANDBOX`) is a boundary.
   - `vector memory skills` and `vector memory skills show` stay open to the agent, as the contract keeps read-only commands open, so an agent that runs them reads a skill's steps through its shell.
2. **Legal review.** The privacy policy does not yet describe learned skills, workflow insights or the optional skill drafter, which, set to Always, sends one run's commands, file names and a short redacted error excerpt to the user's model provider. Legal text changes only with your sign-off.
3. **Start the release** as for 1.99.111: the preparation commit sets `packages/desktop/package.json` to 1.99.113, adds the entry above to `release199` and runs `bun scripts/build-changelog.ts` from `packages/web`.

## After the release

4. **Try it.** In a signed-in 1.99.113:
   - make a check fail, fix it in a Standard request, and check that Settings → Memory → Skills shows a draft with why it was drafted, and that Approve puts it in use;
   - run `vector memory skills approve <id>` from Vector's own terminal and check it refuses;
   - share an approved skill and check `.vector/skills/<name>/SKILL.md` holds no error excerpt, and that Vector asks you to trust the repository again once its sessions finish;
   - open Workflow insights and check each size lists its runs, with unknown cost said as unknown.
5. **Mark 1.99.113 published** (a repository change; ask Claude). Set `publishedDesktopVersion` to `1.99.113`; the docs then say "From desktop 1.99.113:", and `release-113-docs.test.ts` follows.
6. **CLI.** `vector memory skills`, `vector memory workflow` and the owner gates come to the terminal with the next CLI release.
