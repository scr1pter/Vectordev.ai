# Vectorscope eval

Vectorscope is Vector's AI pull-request reviewer. This directory measures how
good its review is with a given model: how many planted bugs it catches
(**recall**) and how many false alarms it raises (**precision**). Run it when
you change the review prompt or pick a default model, and compare models in one
sitting.

```
bun script/vectorscope-eval/run.ts --dry-run
bun script/vectorscope-eval/run.ts --list
bun script/vectorscope-eval/run.ts --model anthropic/claude-sonnet-4.5
bun script/vectorscope-eval/run.ts --model openai/gpt-5 --fixture order-search-sql,webhook-editor-access --repeat 3
bun script/vectorscope-eval/run.ts --model my-model --base-url http://localhost:8080/v1/chat/completions --api-key-env LOCAL_KEY
```

| Flag                   | Meaning                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `--model <id>`         | Model id sent to the endpoint (required unless `--dry-run` or `--list`)                |
| `--fixture <names>`    | Comma-separated fixture names (default: all)                                           |
| `--repeat <n>`         | Run each fixture 1–20 times to expose run-to-run variance (default 1)                  |
| `--base-url <url>`     | OpenAI-compatible chat completions URL (default OpenRouter's)                          |
| `--api-key-env <name>` | Environment variable holding the API key (default `OPENROUTER_API_KEY`)                |
| `--slack <lines>`      | How far a finding may be from a planted bug and still match (default 3)                |
| `--count-nits`         | Score `nit` findings too; by default they are ignored                                  |
| `--max-tokens <n>`     | `max_tokens` for each request (default: the provider's)                                |
| `--timeout <sec>`      | Per-request timeout (default 300)                                                      |
| `--out <path>`         | Also write a JSON report with every decoded report and score; must be outside the repo |
| `--dry-run`            | Validate the fixtures and print prompt sizes. Sends nothing and needs no key           |
| `--list`               | Print the fixtures and their planted bugs                                              |

The API key is read from the environment and only ever sent as the
`Authorization` header. It is never printed; provider errors that quote it are
redacted.

## What a run does

For each fixture, `run.ts` builds the same `PromptInput` the app builds for an
untrusted pull request (`mode: "full"`, `trust: "untrusted"`, placeholder base
and head SHAs, the PR title and body, `renderPatch(parseUnifiedDiff(diff))`, the
full post-change text of every changed file with `exact: true`, `maxComments:
25`) and renders it with `buildReviewPrompt` from `packages/core/src/review`.
It sends that prompt to an OpenAI-compatible chat completions endpoint, asking
for `response_format: json_schema` with `REVIEW_REPORT_JSON_SCHEMA`. If the
provider rejects the format with a 4xx that names it, the request is repeated
once without it; any other error is not retried. The answer is decoded with the
app's own `decodeReport` and scored with `scoreReview`
(`packages/core/src/review/eval.ts`).

The review prompt is written for an agent with read-only tools and a
`StructuredOutput` tool. This harness has neither, so a short system message
tells the model that no tools are available, that the changed files are inlined
in full, and to answer with the report JSON itself (the schema is included, so a
provider that ignores `response_format` sees the same instructions).

## The fixture set

Ten small pull requests in `fixtures/<name>/`: `pr.json` (title and body),
`diff.patch` (a `git diff`), `head/<path>` (the full post-change text of every
changed file) and `expected.json` (the planted bugs, as `EvalExpectation[]`).
Each changes one to three files and 30 to 150 lines.

| Fixture                   | Language   | Planted bug                                                                                       |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `audit-log-pagination`    | TypeScript | Off-by-one: a 1-based page number is used as a 0-based offset in a slice                          |
| `invoice-ledger-sync`     | TypeScript | Missing `await`: a ledger post's rejection escapes the try/catch and the invoice is marked synced |
| `order-search-sql`        | Python     | SQL injection: the search text is concatenated into a query that parameterizes everything else    |
| `digest-frequency`        | JavaScript | Undefined dereference: `member.preferences` is optional until the member saves settings           |
| `webhook-editor-access`   | TypeScript | Inverted comparison in the role-rank check: viewers pass admin checks                             |
| `plugin-bundle-manifest`  | TypeScript | Resource leak: the file handle is closed only on the success path                                 |
| `parallel-chunk-upload`   | TypeScript | Race: concurrent workers read-modify-write a shared byte count across an `await`                  |
| `password-reset-redis`    | TypeScript | Wrong unit: a millisecond TTL is passed to Redis `EX`, which takes seconds                        |
| `http-retry-refactor`     | TypeScript | None: three copies of a retry loop become one, with identical behaviour                           |
| `monthly-report-refactor` | Python     | None: dicts become a dataclass and helpers are extracted, with identical output                   |

The two clean refactors measure false alarms on changes with nothing to find.
Their behaviour was checked against the code they replace when they were
written.

`fixtures.test.ts` keeps every fixture honest: the diff must parse with
`parseUnifiedDiff` with every hunk's counts right and no line left outside a
hunk; each changed file's `head/` copy must be exactly the diff's post-image (the
base is rebuilt by applying the diff in reverse, and applying the diff to it
must give the copy back); and every planted bug must sit on a line the diff
adds. `run.ts` refuses to send a fixture that fails these checks.

## How it is scored

A finding matches a planted bug when the paths are equal (after stripping a
leading `./` or `/`) and the finding's `line..endLine` overlaps the planted
range widened by `--slack` lines on each side. Matching is one-to-one, closest
pairs first, so a second finding about the same bug is a false positive.
`nit` findings are not claims of a defect and are ignored unless
`--count-nits`.

```
precision = TP / (TP + FP)    1 when there are no findings
recall    = TP / (TP + FN)    1 when nothing was planted
F1        = 2PR / (P + R)     0 when both are 0
```

Totals are micro-averaged: the counts of every scored run are summed before the
rates are taken. A run that could not be measured (an HTTP error, a timeout, an
answer with no report in it) is reported as an error and left out of the
totals. It is neither a clean review nor a missed bug, and the process exits 1
so it is not overlooked.

## What it costs

`--dry-run` prints the prompt size of every fixture. The whole set is about
29,000 input tokens per repetition (2,600–3,300 per fixture, estimated as
characters / 4). Output is usually a few hundred to a few thousand tokens per
fixture, and more for models that reason before answering. A full run is
therefore roughly 30k input and 5k–30k output tokens times `--repeat`; multiply
by your model's price per million tokens.

The table shows each run's tokens and cost as the API reported them. OpenRouter
reports the cost of each request (`usage.cost`, requested with `usage: {
include: true }`). Other endpoints usually report tokens but not cost, and then
the cost is shown as **unknown**, never as $0; the total is shown only when
every run reported one. A provider that rejects `response_format` is asked
twice per fixture; the rejected request is normally not billed.

## Limits

This measures the **model plus the review prompt**, not the full in-app
pipeline. In particular:

- **Single shot, no tools.** The app's reviewer can open files, grep and follow
  callers; here the model sees only the diff and the changed files. Code the
  fixtures import but do not include (`../db`, `../logger`) is invisible.
- **No other passes.** The security specialist, the verify pass that re-checks
  blocking findings, and the finalize step do not run.
- **No CI context.** No related code, history, repository instructions, review
  rules, prior findings, team-dismissed patterns or human comments.
- **No selection.** The app drops findings below its confidence threshold (0.7
  by default), caps inline comments and anchors findings to the diff. Here every
  decoded finding counts, whatever its confidence.
- **Ten fixtures.** Eight planted bugs means recall moves in steps of 12.5
  points. Use `--repeat` before reading anything into a difference, and compare
  models in the same session: provider routing and model versions change.
- **Line matching only.** A finding at the right lines that describes a
  different problem still counts as a hit. The "misses, false alarms and
  errors" list and the `--out` report show what was actually said.
- **Synthetic code.** The fixtures are small and self-contained, written to
  hold one unambiguous bug each. Real pull requests are bigger and messier.

No results are checked into this repository, and none should be: `--out`
refuses paths inside it.

## Adding a fixture

1. Write the base and head versions of each file somewhere outside the repo,
   format TypeScript and JavaScript with the repo's Prettier settings (no
   semicolons, 120 columns), and generate `diff.patch` with `git diff`
   between them. `script/format.ts` runs Prettier over the whole repository, so
   a head copy that is not already in Prettier style would drift from its diff.
2. Copy the head files to `head/`, write `pr.json`, and put each planted bug in
   `expected.json` with `line` on an added line (and `endLine` when it spans
   several).
3. Run the checks:

```
cd script/vectorscope-eval && bun test
cd packages/core && bun test test/review/eval.test.ts
```

Make the bug unambiguous to a careful reviewer, and make sure nothing else in
the change is worth a finding, or every model will be charged a false alarm for
it.
