# @vector build progress

The build contract is [vector-at-mention-spec.md](./vector-at-mention-spec.md). Read [vector-at-mention-deviations.md](./vector-at-mention-deviations.md) before continuing. Work only on branch `vector-at-mention` (cut from `main` at `78526052`), one work package at a time in the contract's order, and push each package. Never push or merge to `main`.

For each package, record its commit, the focused tests and typechecks run locally with their results, and the CI runs actually seen. Never record a CI result that was not seen.

## Completed and current work

### V00. CI lane and test wiring

- **Status:** done. The lane is green on the V00 commit with no product change, and the three web GitHub API tests ran in CI (contract V00 "Done").
- **Commit:** `4ed48e7a` (`test(github): V00 add the @vector CI lane and test wiring`), pushed to `origin/vector-at-mention`. Origin accepted the push with the global pre-push hook (`/home/user/.hooks/pre-push`, the Bun-version check and then the turbo typecheck one package at a time) in place; the hook's output was not kept, so no typecheck result is recorded for it.
- **Files:** `.github/workflows/vector-at-mention.yml` (new); `packages/cloud/src/workflow-compliance.test.ts` (a `@vector CI lane` block placed after the release supply-chain block, with no new imports and no change to shared lists, so Codium's A00 edits to the same file merge cleanly); the deviations file (V00 entry). `packages/engine/src/cli/vector-account.ts` is untouched.
- **The lane:** pushes to `vector-at-mention` (no path filter), pull requests on `api/**`, `bun.lock`, the root `package.json`, the contract's other paths and the lane's tests (deviation 4), and dispatch (which works only once the file is on `main`). `contents: read`, no job permissions or environments, no repository secret, checkouts without persisted credentials. Every push and dispatch gets its own concurrency group, so a newer push never cancels or drops an older push's run; pull requests cancel stale runs. Jobs: `api` (hosted API typecheck; web GitHub tests against Valkey pinned by `vector-free-models.yml`'s digest; root `api-module-loading` and `cli-token`; the lane policy), `packages` (engine `test/cli/github*.test.ts` and `test/tool/registry*.test.ts`; core `test/review/*.test.ts` and `test/child-environment.test.ts`), `node-bundle` (build and Node smoke).
- **Lane policy tests** (`describe("@vector CI lane")`): triggers, the exact push trigger, the shared-group guard, the pull-request paths (`api/**`, `bun.lock`, `package.json` and the contract's others), read-only permissions, no reference to the `secrets` context, `github.token`, an index into `github` or `toJSON(github)` in any key or value of the parsed workflow, ignoring case (deviation 6), credential-free checkouts, pinned actions; the Valkey digest; every check the contract names is still present; every test step starts with `GITHUB_ACTIONS=false`, names files, and each named pattern matches a file; the web step has `VECTOR_TEST_REDIS_URL` and the service publishes that port.
- **Local evidence (2026-10-30, Bun 1.3.14, each through `vector-serial`, one file at a time):**
  - `packages/cloud`: `GITHUB_ACTIONS=false bun test --timeout 30000 src/workflow-compliance.test.ts`: 17 pass, 0 fail (122 `expect()` calls).
  - The same file against six deliberate breakages of the lane, each restored afterwards: a not-yet-existing core test file, the web step without `VECTOR_TEST_REDIS_URL`, a push path filter, a push concurrency group shared by every run, a test step without `GITHUB_ACTIONS=false`, and a checkout that keeps credentials. Each failed exactly one lane test.
  - Review fixes (deviations 4 and 6): before the fix, the policy passed with `${{ secrets['VECTOR_X'] }}`, `${{ toJSON(secrets) }}` and `${{ github['token'] }}` in a step's `env`. After it, each of eight forms (`secrets['X']`, `toJSON(secrets)`, `secrets.X`, `SECRETS.X`, `github['token']`, `GitHub.Token`, `toJSON(github)`, and a YAML-escaped `\x73ecrets.X`), and removing `api/**`, `bun.lock` or `package.json` from the pull-request paths, failed exactly one lane test; a comment naming `secrets.X` and `github.token` passed. The six breakages above were run again on the final file with the same result.
  - `bun test` filter behaviour, in `packages/cloud`: an existing file plus a missing one ran the existing file and exited 0; the missing file alone exited 1.
  - `packages/cloud`: `bun typecheck`: passed.
  - `packages/web`, with fresh XDG roots: `test/github-oidc.test.ts` 26 pass, 0 fail; `test/github-app.test.ts` 28 pass, 0 fail; `test/github-app-api.test.ts` with `VECTOR_TEST_REDIS_URL` on a loopback `redis-server` (random port, `--save '' --appendonly no`, stopped afterwards) 10 pass, 0 fail, no skip.
  - `test/`, with fresh XDG roots: `api-module-loading.test.ts` 1 pass, 0 fail; `cli-token.test.ts` 8 pass, 0 fail.
  - Final gate, on the files as committed: `src/workflow-compliance.test.ts` 17 pass, 0 fail (122 `expect()` calls); `packages/cloud` `bun typecheck` passed; Prettier `--check` clean on the workflow, the test file and both docs (it first added one blank line between items 5 and 6 of the deviations file).
  - Not run locally, because V00 changes no code they cover and several spawn Bun or git (`github.auth`, `github.git`, `github.lifecycle`, `github.review`, `github.run-routing`, `github.evidence`, core `child-environment`): the engine GitHub tests, the core review and child-environment tests, the hosted API typecheck, and the Node-bundle build and smoke. The lane runs them all.
- **CI (seen):** lane run 41088621646 (`Vector at-mention`, push on `4ed48e7a`, 2026-10-30 16:18–16:19 UTC): success in all three jobs.
  - `hosted API` (job 124176281277): "Typecheck hosted API" passed. "Run GitHub API tests": 64 pass, 0 fail, 3814 `expect()` calls across 3 files; the log shows all 10 `github-app-api.test.ts` tests as `(pass)` and no skip. "Run hosted API tests" (`api-module-loading`, `cli-token`): 9 pass, 0 fail. "Check the lane policy": 17 pass, 0 fail, 122 `expect()` calls.
  - `engine and core` (job 124176279963): "Run engine GitHub tests": 210 pass, 0 fail, 1021 `expect()` calls across 14 files. "Run core GitHub tests": 346 pass, 0 fail, 1399 `expect()` calls across 20 files.
  - `desktop engine bundle (node)` (job 124176280434): the build and the Node smoke both succeeded.
  - The branch's other run, `Vector production checks` 41083203627 on `738cef5c` (a Vercel `deployment_status` event), was skipped; it is not the lane.
- **For later packages:**
  - Append test files to the matching job's step. The policy fails a step that names a file that does not exist yet, so add a file in the same commit that creates it (V01 adds `test/github-agents.test.ts` to the core step). App and desktop steps go in the `packages` job as `GITHUB_ACTIONS=false bun --no-env-file test <file>` (V24, V25).
  - The policy refuses the word `secrets`, `github.token`, an index into `github` and `toJSON(github)` in any key or value of the workflow, step names included; comments are not read (deviation 6).
  - V16: INV-S5 and V16 put the `sandbox-probe` job on the floating Ubuntu label, but the existing test "Vector's workflows pin their Ubuntu runner" forbids that label in every workflow in this repository. V16 settles that in its own commit and records it there; V00 decides nothing about the probe's runner.

### V01. Shared constants (`GithubAgents`)

- **Commits:** a short series on top of `4ed48e7a`: `docs(github): record the V00 commit and lane run` (the V00 entry above); `docs(github): name the V01 shared types in section 2.1` (the type names `MintStatus`, `Outcome` and `StopCode`, and the `MIN_AGENTS_CLI` row marked as V14's: a contract change, which the section 2 preamble puts in its own commit before the code); then `feat(github): V01 add shared @vector constants` (the code, the test, the lane wiring, the deviations and this entry). Hashes: `d36fcfce`, `1af0006d` and `3d9e2f6d`, pushed to `origin/vector-at-mention` (at `3d9e2f6d` when V02 started). The pre-push hook's output was not kept, so no typecheck result is recorded for it.
- **Files:** `packages/core/src/github-agents.ts` (new, import-free, ends with the `GithubAgents` namespace self-export); `packages/core/src/review/workflow.ts` (`WORKFLOW_FILE` is now a named re-export from `../github-agents`; `GITHUB_WORKFLOW_VERSION` stays `"2"` and the v2 builder is unchanged); `packages/core/test/github-agents.test.ts` (new); `.github/workflows/vector-at-mention.yml` (the core step runs the new test, and the pull-request paths name it); `packages/cloud/src/workflow-compliance.test.ts` (shared file: one entry added to the `@vector CI lane` block's list of checks the contract names, nothing else); the deviations file (V01 entry); the contract's section 2.1. `packages/engine/src/cli/vector-account.ts` is untouched. `MIN_AGENTS_CLI` is V14's.
- **Tests** (`test/github-agents.test.ts`, 23 tests): the module imports nothing and its only `from` clause is its own namespace export; `mentions()` with and without a slug, a 100-character slug, ten invalid slugs, and a fresh list per call; `slugFromInstallUrl` on GitHub's install URL and twenty hostile or malformed ones; `onActionsRunner`; `withheldOnActions` on the real tool ids, the contract's spellings, computer ids and close non-matches; `runId` at four 20-digit ids (86 characters) and `Number.MAX_SAFE_INTEGER`, and a `RangeError` for eighteen invalid ids in each of the four positions; `RUN_ID_PATTERN` (a lone `-` refused); `THREAD_PATTERN`; artifact names free of the characters `actions/upload-artifact` refuses; `SECRET_NAME_PATTERN`; the sandbox allowlist is exactly the contract's 35 names, with no credential, `ACTIONS_*` or file-command name; `WORKFLOW_FILE` and the v2 App workflow's job names; endpoint and audience shapes; the numbers and how they fit together; the 15 mint statuses, 6 outcomes and 16 stop codes.
- **Local evidence (2026-10-30, Bun 1.3.14, each through `vector-serial`, one file at a time, `GITHUB_ACTIONS=false`, fresh XDG roots and `VECTOR_TEST_HOME` for the core, root and engine files):**
  - `packages/core`: `bun test --timeout 30000 test/github-agents.test.ts`: 23 pass, 0 fail (132 `expect()` calls).
  - `test/`: `api-module-loading.test.ts`: 1 pass, 0 fail (no `api/` file imports the module yet).
  - `packages/cloud`: `src/workflow-compliance.test.ts`: 17 pass, 0 fail (122 `expect()` calls).
  - `packages/engine`: `test/cli/github.workflow.test.ts` (checked first: no subprocess): 24 pass, 0 fail (148 `expect()` calls), so the v2 workflow is unchanged by the re-export.
  - Breakage checks, each restored afterwards and each failing exactly one test: a type-only `import` and a type-only `export … from` in the module (the no-import test); `THREAD_PATTERN` and `SECRET_NAME_PATTERN` copied with Markdown's literal `\|` (the thread and secret-name tests); `RUN_ID_PATTERN` without the lone-dash refusal; the withheld set with the contract's spellings only; the new test dropped from the lane's core step ("the lane keeps every check the contract names"); a misspelled `test/github-agentz.test.ts` added next to it ("every test step runs named files that exist").
  - Typechecks: `packages/core` passed (again after the final test edit); `packages/cloud` passed; `packages/engine` and `packages/desktop`, which import `WORKFLOW_FILE` from `review/workflow`, passed.
  - Prettier `--check` is clean on the code, the workflow, the compliance test, the deviations file and this file. The contract file was not Prettier-clean before V01 either (its tables and emphasis use their own style), and this change keeps its style.
  - Final gate, on the files as committed: `packages/core` `test/github-agents.test.ts` 23 pass, 0 fail (132 `expect()` calls); `packages/cloud` `src/workflow-compliance.test.ts` 17 pass, 0 fail (122 `expect()` calls); `packages/core` and `packages/cloud` `bun typecheck` passed; Prettier `--check` clean on the code, the test, `review/workflow.ts`, the workflow, the compliance test, the deviations file and this file. `origin/vector-at-mention` was still at `4ed48e7a`.
  - Not run locally: the engine GitHub and registry tests beyond `github.workflow` (several spawn Bun or git), the core review and child-environment tests (no code they cover changed), the hosted API typecheck (no `api/` file uses the module yet), the web GitHub tests and the Node-bundle build and smoke. The lane runs them all.
- **CI (seen):** lane run 41094574639 (`Vector at-mention`, push on `3d9e2f6d`, 2026-10-30 16:57–16:59 UTC): success in all three jobs.
  - `hosted API` (job 124196885993): every step succeeded ("Typecheck hosted API", "Run GitHub API tests", "Run hosted API tests", "Check the lane policy"); their logs were not read.
  - `engine and core` (job 124196886286), read in the job log: "Run engine GitHub tests": 210 pass, 0 fail, 1021 `expect()` calls across 14 files. "Run core GitHub tests" (with the new `test/github-agents.test.ts`): 369 pass, 0 fail, 1531 `expect()` calls across 21 files.
  - `desktop engine bundle (node)` (job 124196886503): the build and the Node smoke both succeeded.
  - The branch's other run on `3d9e2f6d`, `Vector production checks` 41094829543 (a Vercel `deployment_status` event), was skipped; it is not the lane.
- **For later packages:**
  - V02: `mentions()` orders `/vector`, `/vs`, `/vectorscope`, `/vx`, but today's `DEFAULT_MENTIONS` and `TASK_MENTIONS` order `/vectorscope`, `/vs`, `/vector`, `/vx`, and core's `command.test.ts` and the engine's route tests pin that order. Making `DEFAULT_MENTIONS` equal `GithubAgents.mentions()` changes the list the v2 route script bakes in and the route job's `contains(...)` condition, while V14 asks for the v2 builder's output to stay byte-identical. V02 settles which, and records it.
  - V03: the registry filter calls `withheldOnActions` with `Tool.Def.id` (`browser`, `vector_cloud`, `research_browser`; deviation 2). `SECRET_NAME_PATTERN` is case-sensitive, so where `child-environment.ts` compares names case-insensitively (Windows) it must test the upper-cased name, or `my_token` passes.
  - V07, V12, V27: `RUN_ID_PATTERN.test` alone refuses a lone `-` (deviation 3).
  - V10, V12: `WORKFLOW_VERSION` is the string `"3"` and `MIN_CODIUM_WORKFLOW_VERSION` the number `3`. `workflowUpdate` and the 426 check compare numerically; as strings, `"10"` sorts below `"3"`.
  - V14 adds `MIN_AGENTS_CLI`; V24 sets `GITHUB_WORKFLOW_VERSION` to `WORKFLOW_VERSION`.
  - V16: `SANDBOX_ENV_ALLOW` includes `HOME` and `RUNNER_TEMP`, which the sandbox sets to the agent user's own directories instead of passing the runner's values.
  - `bundleArtifact` and `sessionArtifact` do not validate their arguments, because the generator may pass `${{ … }}` expressions; code that builds a name from untrusted input checks the thread with `THREAD_PATTERN` first.

### V02. Mention parsing: word boundaries and the App handle

- **Commit:** `feat(github): V02 parse mentions with word boundaries and the App handle`, on top of `3d9e2f6d`. This package's progress step also filled in the V01 entry's hashes and lane run above. Its hash, the pre-push result and the lane run go in the next package's progress step.
- **Files:**
  - `packages/core/src/review/command.ts`: `parseReviewCommand` applies section 2.2, and `DEFAULT_MENTIONS` is a literal copy of `GithubAgents.mentions()`. It is still import-free and self-contained.
  - `packages/engine/src/cli/cmd/github.route.ts`: `TASK_MENTIONS = GithubAgents.mentions()`.
  - `packages/core/test/review/mention-cases.ts`: new, the shared table, not itself a test file (deviation 6).
  - `packages/core/test/review/command.test.ts`, `packages/engine/test/cli/github.route.test.ts` and `packages/engine/test/cli/github.route-script.test.ts`.
  - `packages/engine/test/cli/github.workflow.test.ts`: the two golden route conditions (deviation 1).
  - The deviations file (V02 entry).

  No shared file is touched, and `packages/engine/src/cli/vector-account.ts` is untouched. `command.ts` and `github.route.ts` are ours as the GitHub integration's owner. The lane needs no change: its core step runs `test/review/*.test.ts`, its engine step runs `test/cli/github*.test.ts`, and its pull-request paths cover `packages/core/test/review/**`.

- **Behaviour:**
  - A mention counts only as a word of its own (section 2.2), ignoring case.
  - Inline code spans are ignored, along with HTML comments, fences and quoted lines; a mention glued to a span does not count. Spans pair from the start of every line of a paragraph, backslash escapes follow CommonMark, only a line of spaces and tabs is blank, and a quote's code pairs across the lines that continue it (deviation 2). List markers can precede a fence or a `>`, and such a fence also ends with its list item (deviation 2). HTML comments are masked rather than cut, a comment that starts a line is an HTML block, and one elsewhere is read with the code spans (deviation 7).
  - The first line that starts with a mention gives the verb, as before.
  - `@<slug>` works through the mentions list; without the slug, a literal `@vector` is no mention (O1).
  - Trailing invisible characters do not keep a mention from ending its line.
  - Every pass is linear in the body's length.
  - Intended refusals that writers may notice: `/vectorx review` and other glued suffixes, mentions glued to code, `**/vector fix**`, `/vector... fix`, a mention after an unmatched backtick, and a mention after a span that wraps onto its line when another span follows it (deviation 2's cost). Quotes count as boundaries, as 2.2 lists them, so `'/vs fix'` and `/vector's` are tasks. Since the second review, also: a mention after an unclosed `<!--` that starts a line (GitHub hides the rest), a mention on a `- >` or `1. >` line, and one where a `<!--` that may be literal text pairs its backticks with later ones (deviation 7).
- **Tests:**
  - The shared table has 138 rows: the 45 bodies of the earlier `command.test.ts` corpus (`/vectorx review` now `none`, deviation 5) and 93 new ones. The new rows cover:
    - every refusal and acceptance case of 2.2, plus boundary extras;
    - inline code, including glued spans, multi-line spans, an unmatched backtick, a paragraph break and an escaped backtick;
    - the review's cases (17 rows): a list item and a heading after a stray backtick, nested pairings, the wrapped-span cost, three escape cases, blank lines of spaces and tabs against lines of a no-break or zero-width space, three quotes that continue across lines, and four bodies pinned as tasks that GitHub shows only as code (the constructs deviation 2 does not model);
    - the second review's cases (22 rows): eight list-item rows (fences after `- `, `1. ` and `* `, a fence that ends with its item at a line that opens a new one, a tab-indented line, and quotes after list markers), twelve HTML-comment rows (an HTML block across a blank line, one holding backticks, an unclosed one, the review's four bodies where a span holds a `<!--`, a comment line inside a span, a comment that takes a backtick, a trailing one, one that a quote's lazy line closes, and both readings of a `<!--`), and two fence bodies pinned as tasks that deviation 2 does not model;
    - quotes and fences, HTML comments across lines, and trailing invisible characters;
    - 17 rows with a slug: the verbs after `@vector-fixture`, refused look-alikes, and O1 with slug `vector` (`@vector review` reviews) and without it (`@vector review` is `none`).
  - `command.test.ts` (8 tests):
    - the table with `GithubAgents.mentions(slug)`;
    - `DEFAULT_MENTIONS` equals `GithubAgents.mentions()`;
    - no handle counts without the slug;
    - custom mentions, now with boundaries (`(/v+x) fix` is a task, `/v+xy fix` is not);
    - the `new Function` copy over the whole table, with no `import`, no `${{` and only printable ASCII in its `toString()`;
    - the module imports nothing (`scanImports` is `[]`, and the comment-free code has no `import`, `require(` or `from "…"`);
    - the source is printable ASCII, with a Windows checkout's CRLF line endings read as LF;
    - 23 hostile bodies at GitHub's 65,536-character limit stay under 250 ms each, for both the module and the embedded copy. The second review added five: inline comments holding backticks, many `<!--` sharing one `-->`, HTML blocks, list fences that their items end, and 65,533 spaces before a list marker.
  - `github.route-script.test.ts` (2 new tests, 10 in all): every table row runs through the route script the generated v2 workflow embeds. The row is built with the default mentions, or with `mentions: GithubAgents.mentions(slug)` baked in. Each row agrees with core's parser and gets the expected outputs and API calls: a refused mention, like a dismissal, makes no API call. The route job's `contains()` filter lets through every body the script reads a mention in, ignoring case as Actions does, and names `@vector-fixture` when the slug is baked in. The script is built for each call, keyed by both the App opt-in and the mentions, so no cache can mix them.
  - `github.route.test.ts` (2 new tests, 11 in all):
    - boundary and inline-code refusals and acceptances through `routeGithubEvent`;
    - `mentionsFrom("@Vector-Fixture,/vector,/vs")` lowercases the handle and routes `review`, `review full`, `pause` and a task after it, but not `@vector-fixture-bot` or `@vector`;
    - `TASK_MENTIONS` and `mentionsFrom(undefined)` equal `GithubAgents.mentions()`.
- **Review fixes (2026-10-30, before the commit):**
  - The inline-code pass could count a mention that GitHub shows only inside a span. This happened after a stray backtick in an earlier list item or heading, after an escaped backtick, and across a line of a no-break or zero-width space. The pass now pairs from every line's start, follows CommonMark's escapes, and ends a paragraph only at a line of spaces and tabs. It also keeps a quote's code pairing across the lines that continue the quote. Deviation 2 is rewritten to match, and names what is still not modelled.
  - "The source is printable ASCII" read `command.ts` from disk and failed on the CRLF line endings of a Windows checkout. The `unit (windows)` job of `test.yml` runs core's suite. The test now reads CRLF as LF. The `toString()` check stays LF-only, because Bun prints the function with LF, which a CRLF copy confirmed.
- **Second review (2026-10-30, before the commit):** four findings in two pairs, both real.
  - HTML comments were cut from the body before anything else. On GitHub a code span that opens before a `<!--` holds it as code, so cutting the comment could delete the span's closing backtick, and a line holding only a comment became blank and ended a paragraph that GitHub continues. Either way a mention that GitHub shows only as code counted (``Type `<!--` then --> and ` /vector fix ` ``), which reproduced against micromark. Fixed as deviation 7: comments are masked, not cut; a comment that starts a line is an HTML block; and one elsewhere is read with the code spans, in both readings of its `<!--`.
  - A fence or a quote after a list marker (`- ```sh`, ` 1. ``` `, `- > x`) was not detected, so `review`, `pause` or a task inside it counted; this predates V02. Fixed in deviation 2: list markers are skipped before fence and quote detection, and such a fence also ends with its list item. The fence cases that stay inexact are listed there, and two are pinned as tasks.
  - Deviation 2's "never counts a mention that GitHub shows only inside an inline span" is now qualified by its not-modelled list.
- **Local evidence (2026-10-30, Bun 1.3.14, each through `vector-serial`, one file at a time, `GITHUB_ACTIONS=false`, fresh XDG roots and `VECTOR_TEST_HOME`; each engine and core file was checked first for subprocesses, and none starts one):**
  - `packages/core`, after the second review's fixes:
    - `test/review/command.test.ts`: 8 pass, 0 fail (341 `expect()` calls);
    - `test/review/state.test.ts`, whose dismissal reading uses the parser: 42 pass, 0 fail (129);
    - `test/github-agents.test.ts`, before the review fixes, which do not touch it: 23 pass, 0 fail (132).
  - `packages/engine`, after the second review's fixes:
    - `test/cli/github.route.test.ts`: 11 pass, 0 fail (69);
    - `test/cli/github.route-script.test.ts`: 10 pass, 0 fail (429);
    - `test/cli/github.workflow.test.ts`: 24 pass, 0 fail (148).
  - Breakage checks before the review fixes, against `command.test.ts` and `github.route-script.test.ts`, each on the parser as it then stood and restored afterwards (the file compared byte for byte):
    - `startsWith` instead of the leading boundary;
    - no boundary before a mention;
    - no boundary after one;
    - no code-span stripping;
    - a span replaced by a space instead of `#`;
    - dropped quote lines not ending a paragraph;
    - no trailing-invisible trim.

    Each of these failed the table test in both files: the core table and its embedded-copy run, plus the custom-mentions test for the two boundary breakages. `DEFAULT_MENTIONS` in the old order failed core's equality test and the route-script `contains()` test. A type-only `import` failed "the module imports nothing". The earlier lazy comment regex, and the earlier end-anchored verb trim, each failed only the hostile-body test. A literal zero-width space in a character class failed only "the source is printable ASCII". The review fixes replaced the quote rule of the sixth check (see below).

  - Breakage checks after the review fixes, each on a scratch copy of the final parser, run against the shared table with Node 22 (`--experimental-strip-types`), not through `bun test`. Each failed at least one table row:
    - pairing from the paragraph's start only (3 rows);
    - no backslash escapes (2);
    - escapes applied to closing runs too (1);
    - a line blank once trimmed by JavaScript (2);
    - dropped quote lines ending the paragraph, as before the fixes (3);
    - no paragraph end where a quote starts (1);
    - overlapping spans not merged (1);
    - a quote counted open only after a line that starts with `>` (1), or only on the line after one (2).
  - Breakage checks after the second review, the same way. Each failed at least one table row:
    - comments cut before anything else, as before (6 rows);
    - no list markers before fence and quote detection (8);
    - a list item's fence not ending with the item (1);
    - a tab counted as one column there (1);
    - only the comment reading of a `<!--` (1), or no comment reading at all (4);
    - comments kept instead of removed (3);
    - an unclosed HTML block not running to the end (1), or no HTML-block rule (1);
    - an HTML block allowed at any indentation (1);
    - quoted lines masking their comment markers (1).
  - Differential check, from a scratch script under Node 22, against micromark 4.0.2 with micromark-extension-gfm 3.0.0 (a CommonMark and GFM parser already in `node_modules`; nothing installed). Random bodies are built from backticks, backslashes, list, heading, quote and setext markers, and no-break and zero-width spaces, each with one `/vector fix`. Fences, four-space indents, tabs and the constructs deviation 2 does not model (`<`, `[`, `|`, `www`) are left out. Across 12 seeds of 120,000 bodies, about 835,000 of which the parser accepted, it accepted none that micromark renders only inside code. While the fixes were made, the check found two counterexamples: a quote continued after a lazy line, and a quote after a list marker. Both are now table rows. On a smaller token set (seed 7, 60,000 bodies), the parser before the fixes accepted 152 such bodies.
  - Second-round differential check, the same way against the same micromark, comparing the parser before and after the second review's fixes. The verdict is whether micromark shows the mention outside code and outside the HTML comments a browser would read. With the first round's token set, 4 seeds of 60,000 bodies (about 121,800 accepted) give no body accepted that micromark renders only inside code. Adding comment tokens (`<!--`, `-->`, `<!-->` and comment lines), 2 seeds of 30,000 give 7 and 11 such bodies before the fixes and 5 and 10 after. Every one after the fixes is a comment that an HTML block inside a list item or quote leaves open, which the page's HTML closes later (deviation 7's not-modelled case). Adding list-marker and indented fences, 2 seeds of 30,000 give 203 and 200 before and 48 and 52 after. Those after are fences opened on a line of their own inside a list item that the item's end closes (deviation 2). Almost all of the new refusals are mentions that micromark shows only in a quote or a comment.
  - Timing with Bun 1.3.14, from a scratch script: the 18 hostile bodies parse in at most about 41 ms each. After the second review, the 23 of the test and six more parse in at most about 47 ms. The earlier comment regex took about 490 ms on the unclosed-`<!--` body. The earlier end-anchored trims took about 7 to 8.5 s on 65,536 characters of trailing dots or zero-width spaces.
  - The generated v2 workflows (default, App opt-in, and slug `vector-fixture`) are pure ASCII. Their route scripts contain no `${{`; the builder throws if one does.
  - Typechecks: `packages/core` and `packages/engine` passed, again after the review fixes and after the second review's. No `api/` file changed, and none imports `command.ts` yet, so the hosted API typecheck was not run.
  - Prettier `--check` is clean on the code, the tests, the fixture, the deviations file and this file.
  - Final gate, on the files as committed (fresh XDG roots and `VECTOR_TEST_HOME`, `GITHUB_ACTIONS=false`):
    - `packages/core`: `test/review/command.test.ts` 8 pass, 0 fail (341 `expect()` calls); `test/review/state.test.ts` 42 pass, 0 fail (129);
    - `packages/engine`: `test/cli/github.route-script.test.ts` 10 pass, 0 fail (429); `test/cli/github.route.test.ts` 11 pass, 0 fail (69); `test/cli/github.workflow.test.ts` 24 pass, 0 fail (148);
    - `packages/core` and `packages/engine` `bun typecheck` passed, and Prettier `--check` is clean on all nine changed files;
    - `origin/vector-at-mention` was still at `3d9e2f6d`.
  - Not run locally, left to the lane: `github.run-routing.test.ts` (it spawns the CLI) and `github.review.test.ts` (it references subprocesses), which both route with `TASK_MENTIONS`; a search of their bodies found none whose result changes. Also left to the lane: the rest of the engine GitHub and registry tests, the other core review tests, the hosted API typecheck and tests, the web GitHub tests, and the Node-bundle build and smoke.

- **Not verified anywhere yet:** the route script as the minified CLI generates it (`packages/engine/script/build.ts` builds with `minify: true`, and `vector github install` uses it), and as the desktop main bundle generates it (`packages/desktop/src/main/github-pr.ts`, the setup pull request). The Node-bundle smoke (`script/smoke-node-bundle.ts`) only builds and loads the sidecar bundle; it never calls `buildRouteScript` or `parseReviewCommand`. Printers do rewrite the embedded text: Bun's own `toString()` here turned some string concatenations into template literals. No local or lane test runs the table through a script from either bundle. V30 or the owner's live steps cover it.
- **CI:** pending. The push starts the lane through its push trigger; nothing is dispatched.
- **For later packages:**
  - V09: import `parseReviewCommand` from `../../packages/core/src/review/command.js` with `GithubAgents.mentions(slug)`. "The module imports nothing" and "the source is printable ASCII" guard that file. It uses `matchAll`, `Map` and regex lookaheads, and no lookbehind, `RegExp.escape` or `URL.parse`.
  - V14:
    - The v3 route script embeds the same function, and the workflow's `handle` gives `GithubAgents.mentions(slug)` for the script, the `contains()` condition and `MENTIONS`.
    - The v2 builder's "byte-identical" baseline is its output after V02 (deviation 1).
    - Reuse the route-script table test for v3, with the App and slug variants built separately.
  - V14 and V20: `dismissReply` in `packages/core/src/review/state.ts` still reads dismissals with `DEFAULT_MENTIONS` only. Once a workflow bakes in `@<slug>`, a `@<slug> dismiss` reply routes to nothing ("a dismissal is read on the next review"), but the next review's `classifyPrior` never reads it as a dismissal. Pass the workflow's `MENTIONS` (`mentionsFrom(env.MENTIONS)`) through `classifyPrior` to `dismissReply`, and test it in `state.test.ts`.
  - V18: `github.handler.ts` (about lines 835–859) still finds the mention for the prompt with substring `includes` and an exact-body match, and `isFixCommand` (about line 1850) still uses `startsWith` and its own fence toggle. Both run only after routing accepted a valid mention, but they can disagree with it. For example, with `/vectorize this` on the first line and `/vector fix` on the second, the route is a task, yet `isFixCommand` reads the first line and says no. V18 should strip and read the mention with the same boundaries.
  - No package yet: the Markdown the parser still reads differently from GitHub. Fences: a backtick in the info string, four-space indents, an ordered marker other than `1.` that continues a paragraph, and a fence on a line of its own inside a list item, which the item's end closes. Indented code blocks: section 2.2 does not name them, so `    /vector review` after a blank line counts although GitHub shows it as code. And comments that GitHub's HTML leaves open (deviation 7). Exact handling needs a model of list items and quotes as containers. Deviations 2 and 7 record them.
  - V23 and V24: feed `GithubAgents.slugFromInstallUrl(installUrl)` into the builder's `mentions`. Workflows people already installed keep their old embedded parser until they are reinstalled. A newer CLI that re-routes in `vector github run` can only refuse more than the route job did, never accept more, because the route job gates first.

## Owner checks recorded

None yet (contract section 4).
