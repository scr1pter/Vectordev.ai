# Orchestration release validation

Validation ran on the eight-core macOS development machine on October 16–17, 2026, with Bun 1.3.14. Package tests ran from their package directories, with isolated fake providers and placeholder credentials. No paid model calls or credential-store reads were performed. Heavy suites and production builds were limited to avoid the machine's known timeout failures under load.

This record covers desktop 1.99.108 preparation, not a published installer or a live model-quality result. See the [offline benchmark](README.md), [design and boundaries](../../vector/design/subagents-v2.md), and [owner release steps](../../vector/owner-actions/subagents-199108.md).

## Package checks

| Package / check                        | Result                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| Core full suite                        | 1,836 passed, 1 skipped; 7,660 assertions                                      |
| Engine full suite                      | 4,557 passed, 23 skipped, 0 failed; 60 snapshots, 16,942 assertions; 373 files |
| Desktop canonical isolated-file suite  | All 98 files passed; 1,150 passed, 2 skipped; 4,591 assertions                 |
| App unit suite                         | 1,706 passed                                                                   |
| App browser component suite            | 46 passed; 112 assertions                                                      |
| App end-to-end suite                   | 127 passed, 1 existing skip, 0 failed; 6.5 minutes                             |
| Public viewer production suite         | 4 passed; 20.7 seconds                                                         |
| TUI full suite                         | 270 passed, 1 skipped; 8 snapshots and 722 assertions                          |
| Schema                                 | 30 passed                                                                      |
| Protocol                               | 2 passed                                                                       |
| Client                                 | 16 passed                                                                      |
| Server                                 | 22 passed                                                                      |
| SDK-next                               | 5 passed                                                                       |
| Effect Drizzle SQLite                  | 7 passed                                                                       |
| HTTP API codegen                       | 69 passed                                                                      |
| HTTP recorder                          | 39 passed                                                                      |
| LLM                                    | 306 passed, 30 skipped                                                         |
| Session UI                             | 76 passed                                                                      |
| UI                                     | 23 passed                                                                      |
| Plugin                                 | 6 passed                                                                       |
| CLI                                    | 4 passed                                                                       |
| Cloud                                  | 132 passed                                                                     |
| Legacy JavaScript SDK                  | 19 passed                                                                      |
| Website full suite with local services | 333 passed, 1 skipped; 8,473 assertions                                        |
| Script / Effect SQLite Node            | No test files; typechecked                                                     |

The website suite used isolated PostgreSQL 17.11 and Valkey 7.2.14 instances on loopback, with placeholder configuration and no dotenv files. Both services were stopped after the run. An initial run without services and a first service-backed run missing Node on PATH were retained; the corrected complete run passed. The final full run used integrated source `7fc99001a`, including the concurrent marketing and account-photo changes. The 30-file suite completed in 8.67 seconds; both local service ports were verified closed afterward. Earlier green results remain preserved.

The merge of `origin/main` at `5d857ba08` included account photos and marketing navigation. The 15 desktop account tests, 11 API account tests, and three app account tests passed on the integrated source. Final web validation and the production app build include those merged files. The later `a8e9e2117` release-note-only change was integrated as `bb72db999`; changelog regeneration produced no diff, release-copy checks passed eight tests with one existing skip, and the website production build passed again.

The first complete engine attempt found stale foreground expectations, malformed old subagent fixtures, a schema snapshot update, and timing failures under load. It also exposed a real slash-command regression: command subtasks must remain explicitly attached to their provider turn. Those fixtures and the production command call site were corrected; 211 focused tests and the semantic prompt checks passed. Cloud, retry, and artifact-audit files passed all 92 tests in isolated reruns. CLI background completion now has an actual actor-routed regression that counts its extra notification turn. Output cleanup retains foreign artifact names instead of interpreting them as generated IDs. The original failed run remains available as `engine-tests-attempt-1.log`; the final complete result is recorded above.

The first canonical desktop pass completed 97 of 98 files successfully. Its spend-cap fixture used a nonexistent teammate identity; the production membership check correctly rejected that message. The fixture now creates a real teammate and membership. Its isolated rerun passed all five tests, followed by the green complete suite above. A subsequent fixture-only cleanup awaited optional asynchronous HTTP responses correctly; all 36 swarm lifecycle tests passed again without the prior fake-server response warnings.

The first full browser attempt had two failures: an older task-list response shape broke history rendering, and an external-agent draft check failed under load. The response-shape bug and the related per-source truncation edge now have regression coverage. The draft case passed twice in isolation without a source change, then passed in the final full run. The final skip is the existing remote-tab busy test, not a new exclusion. Failed and interrupted attempts are retained with the UI evidence.

## Cross-surface and security checks

- HTTP route coverage: all 243 routes accounted for, with no missing, extra or skipped routes.
- HTTP authentication exercise: 243 passed, including guest boundaries. All eight new task and bridge routes also passed the behavior exercise.
- Task regression checks cover background batches, 500 ms notification coalescing, dependencies and failed prerequisites, bounded inspection, steer/queue admission, cancellation races, durable restart observations, ownership enforcement, guest controls, and budget lineage.
- Provider-wire regression: the actual registered `task_manage` tool advertises all five actions through OpenAI Chat, OpenAI Responses, and Anthropic Messages. Two tests and 29 assertions verify the schema and strict action-specific input validation. This corrected a provider union conversion that previously exposed only `list`, hiding instructions and other controls.
- Generated both public clients using `packages/client`'s generator and the legacy SDK build script. Generated files were not edited by hand.
- Benchmark actor and simulated-cache unit tests: 18 passed. Request-shape tests: 11 passed. Run Guard tests: 47 passed, also covered by the full core suite.
- Desktop bundling found an existing Bun-only output digest in the engine processor. Replaced it with Node SHA-256; all 25 processor tests passed (134 assertions), and the Node bundle scan passed.
- Final website production build passed after integrating the concurrent marketing changes. Desktop production build passed at `bb84261e0f4f35766163d5515c0742dd8b314ee8`; its embedded identity is `prod`, desktop 1.99.108 and required CLI 1.99.108. The Node runtime scan and renderer-entry verifier passed. The local build used the committed catalog with SHA-256 `a96b465110dd2fcc38e0dcca1a4115e12ea43ddaafdb0ebf587e15026767bf14`. This validates the local production bundle; native installer publication and the owner-reviewed immutable release catalog remain release-workflow gates. Final app, desktop and website package typechecks passed after the upstream merge and CLI version pin. Final engine typecheck passed at the same runtime source. All package typechecks passed. The repository pre-push hook then passed all 23 packages with zero cache hits in 3 minutes 16 seconds before updating remote `main` to `489ea9e13`. The subsequent provenance merge retains the measured benchmark source commits without changing application code; Git verified its candidate tree was identical before this validation-record update.
- Production app timeline probe passed with all 40 updates, no blank samples, remounts, drift or long tasks. RAF p95/p99 remained 9.2/9.3 ms; completion was 10,132.5 ms versus the recorded baseline 10,113.2 ms. One run per version does not establish a statistical performance change. See the [raw UI evidence and comparison](ui/validation.md). Synthetic UI measurements are not model latency measurements.
- Final release audit aligned required CLI 1.99.108 with desktop 1.99.108 so WSL receives the new controls. Build identity tests passed 2 tests/14 assertions; required CLI and immutable catalog checks passed 7 tests/70 assertions. Owner steps now require matching standalone archives and npm packages before desktop dispatch, and explicitly disable container publication for this handoff.

## Independent review and confirmed fixes

The runtime, experience and cost tracks reviewed one another's changes. Review findings were checked against the implementation and covered by regression tests before integration:

- Removed a cancellation deadlock caused by holding the task-control lock while waiting for execution cleanup; gated messages and continuations during stopping.
- Preserved live worker cancellation when its coordinator had already settled or did not support Stop.
- Joined swarm workers through their recorded workspace IDs and real parent scope, including staging-directory workers; excluded synthetic coordinator scopes.
- Published a task-board update when a desktop lease expires, retained truthful last-known status, and disabled controls until reconnection.
- Propagated snapshot truncation so Stop all cannot silently act on an incomplete board.
- Enforced guest ownership before remote forwarding, validated lease and receipt scope, and persisted an uncertain command marker before desktop execution to prevent blind crash replay.
- Retained launch-time child and batch budget lineage, counted provider usage once, and removed stale aliases when ledgers are released.
- Required successful tool verification receipts in the benchmark, in addition to independent fixture tests; retained unsuccessful attempts rather than selecting only passing cells.
- Kept desktop spend separate from the cumulative native ledger where latest-run records cannot establish lifetime totals; preserved unsupported and unknown external capabilities explicitly.
- Preserved prior task observations when an older server returns a response without the task-list schema, preventing a history-rendering failure found by the full browser suite.
- Corrected the desktop CLI compatibility pin to 1.99.108 and documented CLI-first publication; publishing a newer standalone channel alone cannot update an older embedded WSL version requirement.
- Kept slash-command subtasks explicitly in the foreground so their result, cancellation, and budget remain attached to the command turn.
- Exposed every task-management action in provider schemas while retaining the discriminated execution validator; this protects the user's ability to instruct an existing child.
- Retained each source's truncation independently across refresh failures, so an incomplete desktop snapshot cannot become eligible for Stop all merely because the engine refresh succeeds.

Local command logs are retained in `/tmp/vector-subagents-validation`; browser and performance artifacts are referenced alongside their results. Owner-only release dispatch, production approval, npm 2FA and paid live checks remain outstanding by design.

## Cross-platform CI follow-up

The initial native [test run 38996170036](https://github.com/scr1pter/Vectordev.ai/actions/runs/38996170036), on pushed commit `de7983393`, did not pass all gates despite the earlier local results above. Windows unit tests exposed nine app failures and three Core fixture failures. Windows E2E completed with 126 passed, one existing skip, and one failure: the history-paging smoke test reported an inline-script CSP mismatch on all three attempts. Linux E2E passed. Native engine checks also exposed platform-sensitive fixtures and compatibility issues requiring the follow-up below; the prior results are retained as evidence of their original source, not substituted for native CI confirmation.

- Upstream `501b80914` removes an obsolete global SDK mock from the prompt-submit tests and runs app files with Bun `--isolate`. That mock lacked `session.get` and `session.list`, explaining both empty economics request lists and the traffic-test error. The Composer fixture now supplies its own router mock. No request-count or spend assertion was weakened.
- Core fixtures now handle native path spelling and case correctly. Separately, Windows built-in directory permissions normalize path aliases when the ruleset is created, retain those pinned paths, and preserve explicit deny precedence instead of resolving an allowance again after a junction may have changed.
- Bun invocations use a private empty TOML configuration, with migration and tamper checks, so project configuration cannot become unintended process authority. Native PowerShell fixtures exercise the actual Windows shell. Preconnect tests assert supported Bun behavior; GitLab fixtures handle CRLF input. Linux startup-pipe and configuration fixtures were also corrected.
- The shared app/desktop CSP hook now hashes inline script text after the same CRLF/lone-CR normalization performed by HTML parsing. The old Windows theme hash exactly matched the raw CRLF bytes, while Chromium requested the LF hash. A real Chromium regression first reproduced the CRLF and CR failures, then passed with the fix. It verifies trusted execution and continued rejection of unlisted inline code; no broader CSP allowance was added.
- The CLI now recognizes request rejection before interpreting a pending event iterator's teardown. A deterministic real CLI fixture reproduced the duplicate error before the fix; afterward a rejection produces one error and no extra abort, while a genuine unfinished-stream disconnect still reports an error and aborts the session.

Local follow-up checks completed so far:

| Check | Result |
| --- | --- |
| Core full suite | 1,840 passed, one existing skip; 7,670 assertions; 44.03 seconds |
| App isolated suites | 1,709 unit tests and 46 browser tests passed; app typecheck passed |
| Provider focused checks | Four tests passed; 16 assertions |
| Cloud tool focused checks | 34 tests passed; 891 assertions |
| Linux startup/configuration fixtures | Three tests passed; eight assertions |
| CSP, task controls, and timeline browser scenarios | 15 passed; 57.1 seconds; E2E typecheck passed |
| CLI rejection and genuine disconnect checks | Eight tests passed; 24 assertions, including the existing real rejection cases |
| Final Agent permission checks | 57 passed; 328 assertions, including explicit denies and junction retargeting |
| Engine config and skill checks | 151 passed; 352 assertions; the combined Agent, shell and formatting run also passed 119 tests |
| Custom LSP initialization | Two passed; three assertions |

The app logs are retained as `app-ci-isolated.log`, `app-ci-typecheck.log`, `app-csp-regression-before.log`, `app-csp-regression-after.log`, and `app-csp-typecheck-e2e.log` under `/tmp/vector-subagents-validation`. The failing CSP and CLI teardown baselines are retained rather than omitted. The final desktop production rebuild passed with the same pinned catalog and desktop/required CLI 1.99.108, including the Node runtime scan and renderer verification (`desktop-build-ci-final.log`). The website production build passed after the latest upstream investor-page change (`web-build-ci-merge.log`). Final native CI confirmation is recorded below; the earlier full suites, build records, and benchmark measurements above remain unchanged.

The next native [test run 38997943179](https://github.com/scr1pter/Vectordev.ai/actions/runs/38997943179), on `957669253`, passed Windows unit tests, the Node desktop bundle, three Windows engine shards, and both browser jobs. All 23 pre-push package typechecks passed, as did the native typecheck and website workflows. Windows unit results included Core 1,824 passed/16 skipped, app 1,709 passed, app browser 46 passed, session UI 76 passed, and UI 14 passed. Both browser jobs reported 129 passed, one existing skip, and one test passing on retry; each production viewer suite passed all four tests. All three new CSP cases and the original Windows history smoke passed.

That run still failed four engine assertions across the two platforms. Windows engine totals were 4,561 passed, 81 skipped, and two failures: old Agent fixtures fed raw path aliases directly to the lexical permission evaluator, unlike actual tool requests. Linux retained a startup-inventory transport failure and a configuration smoke failure. The subsequent fixes exercise actual external-directory request normalization, transport the large startup inventory through a temporary regular file, and place the owner-config fixture outside its untrusted workspace. The latter investigation also reproduced an actual configuration trust bypass through aliases, rather than treating every failure as a fixture issue. Its failing real CLI and TUI regressions are retained with the validation logs.

The Linux browser retry occurred during initial external-agent workspace startup, with a startup overlay and severe frame delays in the captured artifact. The Windows retry concerned draft text after switching through Files/editor, also observed intermittently in the earlier local suite. Five unchanged local repetitions and three instrumented repetitions subsequently passed. Instrumentation confirmed native input, an enabled Send action, and the draft being initialized in the replacement composer before removal of the previous node. No deterministic defect was established and no speculative UI fix or timeout increase was made. These retries remain disclosed separately from first-attempt passes; the local checks cannot prove the intermittent issue is eliminated.

## Integrated follow-up validation

Candidate `70087d55425ed259ae9278ab3256c93c79b1493e` merges current main through `bfa6eea09`, retaining the direct in-project config regression while extending the fix to aliased config directories and TUI plugins. Source classification preserves lexical project identity and recognizes physical project aliases; safe settings and narrowing permissions survive, while executable settings require trust. Known owner-global paths preserve their authority. Snapshot capture, reads, approved materialization, and stored MCP references use consistent source identities.

The final local config checks passed **191 tests, three existing skips, zero failures, and 487 assertions**: engine config 135/302, TUI config 46/156, and CLI smoke plus path/snapshot and startup checks 10/29 (passed/assertions). The canonical package timeout of 30 seconds was retained. Earlier interrupted runs during heavy machine load, including a TUI timeout that poisoned its temporary spy, remain recorded; complete serial reruns passed without source changes. Logs are `config-alias-integrated-config-full.log`, `config-alias-integrated-tui-full.log`, and `config-alias-integrated-smokes-paths-startup.log`. The Agent/external-directory suite separately passed 66 tests and 343 assertions. All **23 package typechecks** passed in the pre-push hook for the exact merged candidate, with 20 cache hits in 45.075 seconds.

The final desktop production rebuild passed at the merged candidate with the same catalog digest noted above: main bundle 15.53 seconds, renderer 40.49 seconds, Node compatibility and renderer entry verification passed. Its embedded identity is **prod, desktop 1.99.108, required CLI 1.99.99** (`desktop-build-integrated-final.log`). This supersedes the earlier CLI 1.99.108 pin/build record: main's `b8619c0c2` adopts desktop-first publication. WSL and separately installed CLIs need the later CLI release for the new controls, as the updated [owner handoff](../../vector/owner-actions/subagents-199108.md) explains. The website production build passed in 10.30 seconds after merging the consolidated release notes (`web-build-integrated-final.log`). No release was dispatched by this task.

Native [test run 38999870227](https://github.com/scr1pter/Vectordev.ai/actions/runs/38999870227) passed both browser jobs and the desktop Node bundle, but exposed a Windows snapshot casing collision and three skill fixtures that incorrectly made the project directory the owner home. The config helper now maps physical aliases back through the workspace's spelling so snapshot normalization captures one identity. The skill fixtures use a separate empty home while retaining their captured-file and permission assertions. The unchanged Core Git integration test also exceeded its five-second limit on Windows; its isolated local file passed all seven tests and 30 assertions. A targeted GitHub retry was rejected while the workflow was still running; the subsequent candidate runs that job again normally.

Final runtime/test candidate `8a909b79a39ebe67ca6f504265f57c1ade2274dd` passed the path regression file (four tests, 11 assertions), the affected Agent/Skill cases (two tests, five assertions), and the SkillTool file (two tests, 14 assertions). A broader repeat during machine load above 50 was interrupted and retained as `config-alias-root-spelling-final.log`; no timeout was increased. All 23 pre-push package typechecks then passed for this final candidate in 4 minutes 7.422 seconds, with 21 cache hits (`ci-final-fixtures-push.log`). An obsolete earlier push was intentionally interrupted after the final fixture commits were prepared.

Final native confirmation passed all nine jobs in [test run 39001534256](https://github.com/scr1pter/Vectordev.ai/actions/runs/39001534256) at `8a909b79a39ebe67ca6f504265f57c1ade2274dd`. The matching [typecheck](https://github.com/scr1pter/Vectordev.ai/actions/runs/39001533859) and [website verification](https://github.com/scr1pter/Vectordev.ai/actions/runs/39001533739) workflows also passed. Windows engine shards totaled **4,582 passed, 81 skipped, and zero failures**. Windows unit results included Core 1,824 passed/16 skipped, app 1,709 passed, app browser 46 passed, session UI 76 passed, and UI 14 passed. Linux unit/API checks and the desktop Node bundle passed. Windows browser tests reported 130 passed and one existing skip, with no flaky result; Linux reported 129 passed, one existing skip, and one test passing on retry. Each production viewer suite passed all four tests. The Linux retry was the external-agent Claude Code workspace scenario; it remains disclosed and is not claimed eliminated.

The final documentation-only commit records these results without changing the validated runtime or test tree. The benchmark table remains attributed to its separately recorded measured source; these follow-ups were not measured again. No additional tests were requested after the user instructed immediate shipment to main.
