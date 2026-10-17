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
- Final website production build passed after integrating the concurrent marketing changes. Desktop production build passed at `bb84261e0f4f35766163d5515c0742dd8b314ee8`; its embedded identity is `prod`, desktop 1.99.108 and required CLI 1.99.108. The Node runtime scan and renderer-entry verifier passed. The local build used the committed catalog with SHA-256 `a96b465110dd2fcc38e0dcca1a4115e12ea43ddaafdb0ebf587e15026767bf14`. This validates the local production bundle; native installer publication and the owner-reviewed immutable release catalog remain release-workflow gates. Final app, desktop and website package typechecks passed after the upstream merge and CLI version pin. Final engine typecheck passed at the same runtime source. All package typechecks passed; the repository pre-push hook repeats the complete typecheck graph before allowing the remote update.
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
