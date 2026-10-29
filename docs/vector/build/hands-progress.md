# Vector Hands 1.99.112 checkpoint

The build contract is [hands-build-spec.md](./hands-build-spec.md). Read [hands-deviations.md](./hands-deviations.md) before continuing. Work only on `hands`, implement one work package at a time in the contract's order, and push each package. Do not merge or push to `main`.

## Completed and current work

The first 23 work packages, through D6a, are implemented and pushed. D6a in `3bb67725` has passing local model/controller/copy tests, app/browser-fixture typechecks and Linux/Windows browser tests. D5b is next.

- D4: `2772e1f1`; Linux/Windows browser run [40812108743](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40812108743) passed. Production comparison is committed under `docs/benchmarks/vector-hands-1.99.112/`; both runs have 12 successful measurements and zero blank samples. CPU models differ, so timing deltas are observational. Production JavaScript contains no fake-platform markers.
- Database cleanup fix: `a227c869`. The Bun adapter now owns and finalizes a bounded prepared-statement cache. A strict-close regression failed before the fix and passes afterward. Both OS unit jobs passed all three new regressions; Windows passed all five screenshot-pruning cases with immediate cleanup.
- D5a: `ba845338`; six focused files passed 114 tests and app typecheck passed. Pure mention options, actual editor pills, history identity and request markers are implemented.
- D6a: `3bb67725`; 10 model tests, 13 controller tests and the English dictionary checks passed, as did app and browser-fixture typechecks. [Focused browser run 40816142340](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40816142340) passed all fifteen Hands scenarios on both operating systems.

## Outstanding validation

Full run [40813327379](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40813327379), at `a227c869`, completed with two failing Windows jobs. All Linux jobs, both browser suites, the Node bundle, and Windows engine shards 1–5 passed.

1. Windows unit job `123248533002`: the unchanged `core/test/util/windows-powershell.test.ts` native-command fixture exceeded its deadline after successfully loading certificate/archive commands and hashing a file. Its child imports only Node utilities and the direct Windows PowerShell helper, not the database or Hands code. Preserve the deadline/assertions; a single failed-job retry is appropriate to distinguish transient runner timing. This is not yet confirmed as a flake.
2. Windows engine shard 6, job `123248533096`: `engine/test/local-mode/local-run.test.ts`, “refuses a V2 runner turn on a model off in Vector Local before a route is built, and picks none”, unexpectedly resolved the free `vector/north` model. Investigate the fixture's in-memory policy versus watched configuration, as with the two Git fixtures fixed in `10f48ee3`. Keep the zero-outbound guard and all refusal assertions. No fix or rerun for this failure is committed yet.

## Next work

Next: D5b, D6b, D7, D8, D9, D10, D11, D12, then the remaining phases in Section 0. The desktop controller and native helpers are still unimplemented; this checkpoint is not a releasable Hands feature.

D5b integration details discovered during D5a review:

- Resolve mention option description/disabled localization keys before rendering.
- Normal queued sends preserve markers. Custom command sends use a file-only protocol; do not silently drop computer pills. Refuse that unsupported combination without clearing the draft unless command transport is deliberately extended with its generators/tests.
- Undo/fork currently ignores synthetic markers. Restore only valid existing markers using exact canonical mention text; do not infer app hints from arbitrary plain text or extend the fixed marker shape casually.
- Dictation currently flattens non-image pills; preserve computer pills when appending transcription.
- Open onboarding through `showComputerOnboarding` so immediate close-start disposal cancels pending work. First-step consent never enables Hands; Finish performs a new permission probe after older polls and rereads policy before enabling. Examples insert without sending and preserve existing drafts.

## Local validation limits

Run one Bun process at a time, only individual test files from their package directory and per-package `bun typecheck`. Browser fixture checking uses `bun typecheck:e2e` in `packages/app`. Inspect tests for nested Bun subprocesses before running them; CLI-help, migration-generator and Windows subprocess fixtures stay in CI when they would violate this limit. Never run local full suites, Turbo, Playwright or Electron, and never operate the real screen/input or OS privacy settings in tests.

Engine runtime uses Node in the desktop utility process. Keep Bun APIs confined to existing Bun-specific adapters and test/build code. Public schema changes require the prescribed generators, one at a time. Commit as `Vector <bot@vectordev.ai>`. Never read credential files or publish personal contact details.
