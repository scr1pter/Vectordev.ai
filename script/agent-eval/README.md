# Agent eval harness

The repository has hundreds of test files that verify Vector's _code_. This
directory is the only thing that measures Vector's _agent_ — whether the thing
we ship gets better or worse between releases.

It works by building small throwaway repositories on disk, pointing a coding
agent at one of them with a prompt, and then checking objectively whether the
repository ended up in the state the task demanded. Because Vector hosts four
runtimes, the same task set runs against all of them.

```
bun script/agent-eval/run.ts --list
bun script/agent-eval/run.ts --runtime vector --tasks all
bun script/agent-eval/run.ts --runtime codex --tasks bugfix-overdue-invoices
bun script/agent-eval/run.ts --compare vector,claude-code,codex --tasks all
bun script/agent-eval/run.ts --compare vector,claude-code,codex,cursor --tasks all --repeat 5
```

| Flag              | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `--runtime <id>`  | `vector`, `claude-code`, `codex`, or `cursor` (default `vector`)   |
| `--compare <ids>` | Comma-separated runtimes, run in sequence and printed side by side |
| `--tasks <spec>`  | `all` (default) or a comma-separated list of task ids              |
| `--model <id>`    | Passed through to the runtime's own `--model` flag                 |
| `--out <path>`    | Where to write the JSON report (default: a file in `$TMPDIR`)      |
| `--timeout <sec>` | Per-task agent timeout, overriding the task's own                  |
| `--repeat <n>`    | Repeat every task 1–20 times to expose run-to-run variance         |
| `--keep`          | Keep the fixture directories so you can inspect what the agent did |
| `--list`          | Print the task set and exit                                        |

Fixtures are created under `$TMPDIR` and deleted unless you pass `--keep`. A
JSON report with every per-task record is always written; the path is printed at
the end.

## Requirements

`bun` and `git`, plus whichever runtime CLI you are measuring. The fixtures have
zero dependencies and never touch the network, so there is no install step and a
failing check is attributable to the agent rather than to a flaky registry.

For `--runtime vector` the runner looks for a `vector` or `opencode` binary on
`PATH`, then falls back to running the engine straight from source
(`packages/opencode/src/index.ts`), which is the normal case during development.
Set `VECTOR_EVAL_ENGINE` to point at a specific build.

## The task set

Eight tasks. Each one builds its own fixture repository, and each declares its
objective check and the exact files it expects to be edited before any agent
sees it, so the pass bar cannot drift to fit a result.

| Id                               | Category     | What it measures                                                                                                                                |
| -------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `bugfix-overdue-invoices`        | bug-fix      | A failing test exposes an off-by-one boundary bug. Can the agent read a red suite and fix the source?                                           |
| `feature-retry-schedule`         | feature      | A provided test specifies a `retrySchedule` export that does not exist yet. Can the agent implement to a spec it has to read?                   |
| `refactor-rename-symbol`         | refactor     | Rename an exported symbol across four files with no behaviour change and no compatibility alias left behind.                                    |
| `discipline-single-file-fix`     | bug-fix      | A one-line fix in a repository seeded with a typo'd README, a stale doc, and a `TODO`-laden module. The prompt says to change exactly one file. |
| `test-writing-parse-duration`    | test-writing | Write tests for an untested function. Scored by whether the tests actually catch four seeded defects, not by whether they are green.            |
| `bugfix-idempotent-webhooks`     | bug-fix      | Make a billing projection safe under duplicate and out-of-order webhook delivery without dropping valid credit grants.                          |
| `security-path-containment`      | bug-fix      | Close a sibling-prefix traversal bug while preserving valid root and nested paths.                                                              |
| `bugfix-concurrent-reservations` | bug-fix      | Prevent two concurrent model requests from reserving more than one shared allowance.                                                            |

Every task nominates **protected files** — usually the tests that define
success. Changing one invalidates the run outright, because deleting the test is
otherwise the cheapest way to make a suite pass.

## How a task is scored

The objective check is a command that must exit 0, in the spirit of desktop's
`detectWorkspaceChecks` / `validateWorkspace`, except that the task declares its
check instead of the harness guessing one. For these fixtures it is always
`bun test`. Some tasks add content assertions (for example: after the rename,
the old symbol must not appear anywhere in `src/`).

A task **passes** when all three hold:

1. the check exits 0,
2. no protected file was modified,
3. every content assertion holds.

Diff surface comes from git: the harness commits the pristine fixture, and after
the run stages everything and diffs against that baseline. That survives an
agent that decides to commit its own work, and it counts created and deleted
files too. Agent scratch state (`.claude/`, `.codex/`, `node_modules/`,
lockfiles) is excluded; build output is deliberately _not_ excluded, because
producing it in a fixture this small is itself a discipline signal.

```
disciplinePenalty = min(45, 12 * outOfScopeFiles + 0.25 * outOfScopeLines)
mutationScore     = seeded == 0 ? 1 : caught / seeded
score             = passed ? max(0, 100 * mutationScore - disciplinePenalty) : 0
```

The penalty is capped at 45 so that a sprawling pass still ranks above a clean
failure — solving the task is worth more than being tidy about it.

Mutation scoring only applies to `test-writing-parse-duration`. Once the agent's
tests are green, the harness breaks the implementation four different ways, one
at a time, and re-runs the suite. Each mutation the suite fails to notice costs
a quarter of the score. Without this, `expect(true).toBe(true)` would score 100.

Scoring lives in `score.ts` and is pure — no disk, no processes — so a recorded
run can be re-scored with different weights without spending another model call.
`score.test.ts` covers it.

## Unavailable is not zero

The rule this harness must never break: **a runtime that cannot be measured is
reported as `unavailable` and excluded from every aggregate.** It is never
scored 0, and `passRate` / `meanScore` come back undefined rather than 0 when
nothing was measured. "We could not find out" and "it failed everything" are
very different claims and must never render as the same number.

A runtime is unavailable when its CLI is missing, or when it exits non-zero
having made **no edits at all** and its output matches a login/provider/model
failure. That gate is deliberately one-directional: a run that produced edits is
always scored, so the heuristic can never turn a real attempt into a non-result.
The report quotes the matched text so you can check the call yourself.

This is not theoretical. The first live run of this harness against Vector's own
engine on a developer machine died on ``The model `whisper-large-v3-turbo` does
not support chat completions`` — a provider/model-resolution problem that an
auth-only check scored as a flat 0 for the agent.

Harness failures — git missing, a fixture that would not build — are reported
separately as `error` and are likewise excluded from the aggregates.

## What this does NOT measure

Be honest about the ceiling here. This harness does **not** measure:

- **Anything at real-codebase scale.** The fixtures are a handful of files with
  no dependencies. Nothing here says how an agent behaves in a large monorepo
  with a slow test suite and a real type graph.
- **Interactive behaviour.** Every run is one headless prompt. Clarifying
  questions, steering mid-task, permission prompts, plan mode, and recovery from
  a bad first attempt are all invisible.
- **Code quality.** A passing check is a passing check. The scoring cannot tell
  elegant from ugly, and diff surface is a proxy for discipline, not for taste.
- **Tool-use breadth.** No task exercises the web, MCP servers, images,
  subagents, LSP, or long-context retrieval.
- **Vector's product surface.** This measures the agent, not the desktop app,
  the cloud backend, or the editor.
- **Broad statistical significance.** `--repeat` exposes run-to-run variance,
  but a handful of local runs is still not a publishable population and does
  not control for provider or model changes.

Eight tasks that run honestly are worth more than fifty that are hand-waved, but
this set is still a smoke test for agent quality, not a benchmark of real-repository work.

## Reading results responsibly

**Results move with model choice and provider state, so only same-session
comparisons mean anything.** A number from last week and a number from today
were produced against different model versions, different provider routing,
possibly different default model resolution, and different server load. Do not
put two such numbers next to each other and call the difference a regression.

Practically:

- To compare runtimes, use `--compare` in a single invocation.
- Use `--repeat 5` or more before treating a pass-rate difference as a signal;
  repeated attempts get fresh repositories and remain separate in the JSON.
- To compare two Vector builds, run both back to back in one sitting, and pin
  `--model` so the model is not a free variable.
- Re-run before believing any single result.
- No results are checked into this repository, and none should be. There are no
  published numbers for this harness and nothing here should be quoted as a
  benchmark score.

## Adding a task

Append to `TASKS` in `tasks.ts`. A task is worth adding only if its success
condition is objective — a command that exits 0, plus optional content
assertions. If you find yourself wanting to score "did it explain itself well",
that belongs somewhere else. Give the task a protected file so a green check
cannot be faked, and keep the fixture dependency-free.
