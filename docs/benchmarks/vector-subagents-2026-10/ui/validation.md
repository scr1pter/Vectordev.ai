# App and desktop task experience validation

All UI scenarios use fixture data and local fake servers. No paid model requests or credentials are involved.

## Final functional checks

- App unit suite: 1,706 passed across 175 files (14.14 seconds).
- App browser unit suite: 46 passed across 14 files (1.68 seconds).
- Final full app Playwright suite: 127 passed, one existing `remote-tab-busy` skip, zero failures (6.5 minutes); see [browser-final.log](browser-final.log).
- App and browser-test TypeScript checks passed.
- Latest merged account-profile tests: three passed, nine assertions; see [account-profile-final.log](account-profile-final.log).
- Production public-viewer suite: four passed, zero failures (20.7 seconds), including deletion, expiry races, and large inert content; see [public-viewer-final.log](public-viewer-final.log).
- Desktop focused adapter, mailbox, and swarm suite: 63 passed, 346 assertions.
- Engine bridge focused suite at its initial integration: 10 passed, 61 assertions. Later integration coverage is recorded in the parent validation report.

The first full browser attempt completed with 125 passes, one skip, and two failures. The external-agent draft case passed twice in an isolated rerun without a source change. The history-paging failure exposed an unsupported task-list response shape; the app now retains the last valid observations instead of assigning a missing array. The full timeline smoke and subagent scenario rerun passed all 12 tests. A subsequent review added per-source truncation retention so a failed desktop refresh cannot enable Stop all against an incomplete retained snapshot.

Original failures are retained in [browser-first-attempt.log](browser-first-attempt.log), followed by the [external draft rerun](external-draft-isolated-retry.log) and [timeline/subagent rerun](timeline-and-subagents-retry.log). An additional full attempt was deliberately interrupted after 11 passing scenarios to apply the truncation fix; it is not counted as a completed suite.

Run the functional checks from `packages/app`:

```sh
bun run test
GOMAXPROCS=2 bun typecheck
GOMAXPROCS=2 bun run typecheck:e2e
PLAYWRIGHT_PORT=4567 PLAYWRIGHT_WORKERS=1 bunx playwright test
```

## Visual checks

The active and stopped states were inspected after the controls scenario passed. The inline child composer preserves the parent draft, stays within the task pane, and keeps activity and measured spend visible. Ask Vector appends its question to the existing parent draft. Stop preserves partial output and shows a terminal state.

![Active child controls and preserved parent draft](subagent-active-controls.png)

![Stopped child and preserved parent draft](subagent-stopped-controls.png)

## Performance scope

The production timeline comparison uses the same fixture: 80 history turns, 40 streamed deltas, CPU throttle 4, review pane closed, one Chromium worker. It measures the existing conversation timeline, not a stress test of hundreds of live desktop workspaces. The baseline was captured before the app changes; its console metrics were recorded, but its raw log was not retained. No live-model latency, cache savings, quality, or cost claim follows from this UI benchmark.

Baseline: initial content observed at 432.125 ms; completion 10,113.2 ms; 40/40 deltas; RAF p95 9.2 ms, p99 9.3 ms, maximum 9.4 ms; no long tasks, row replacement, markdown replacement, blank samples, or viewport drift. The first attempted final build hit the existing 120-second server-start timeout while other checks were active; its output is retained in [production-build-timeout-attempt.log](production-build-timeout-attempt.log).

The final production build and timeline scenario passed in 48.3 seconds on integration source `7fc99001a` (the only concurrent commit, `50f9359c8`, changed benchmark documentation). The final [raw output](production-timeline-final.log) and [structured metrics](production-timeline-final.json) are retained.

| Measurement | Before app changes | Final integration |
| --- | ---: | ---: |
| Initial content observed | 432.125 ms | 444.564 ms |
| Stream completion observed | 10,113.2 ms | 10,132.5 ms |
| Delivered deltas | 40/40 | 40/40 |
| RAF gap p95 / p99 | 9.2 / 9.3 ms | 9.2 / 9.3 ms |
| Maximum RAF gap | 9.4 ms | 16.5 ms |
| Long tasks | 0 | 0 |
| Blank samples / viewport drift | 0 / 0 px | 0 / 0 px |
| Row or markdown replacement | Neither | Neither |

Final initial content was 12.439 ms slower and stream completion 19.3 ms slower. The maximum frame gap increased, with no final gap above 33 ms; p95 and p99 were unchanged. These are single runs on a shared machine, not a statistically controlled performance improvement claim. The measured timeline stability checks passed.

Run these final production checks serially from `packages/app`:

```sh
bun --no-env-file test src/vector-account.test.ts
PLAYWRIGHT_VIEWER_PORT=4569 PLAYWRIGHT_WORKERS=1 bunx playwright test --config e2e/public-viewer.playwright.config.ts
PLAYWRIGHT_PORT=4568 PLAYWRIGHT_WORKERS=1 TIMELINE_CPU_THROTTLE=4 TIMELINE_DELTA_COUNT=40 TIMELINE_HISTORY_TURNS=80 VECTOR_PERFORMANCE_RUN_ID=subagents-after-final bunx playwright test --config e2e/performance/playwright.config.ts e2e/performance/timeline/session-timeline-benchmark.spec.ts --grep 'streams assistant text in v2 with review pane closed'
```

Owned test-server ports 4567, 4568, and 4569 were verified closed after the checks.

## Independent review closure

The runtime, cost, and integration reviewers checked the adapters and controls independently of their implementation. The following confirmed findings were fixed before the final functional run or the later integration gates:

| Finding | Resolution and retained coverage |
| --- | --- |
| Swarm workspaces disappeared after provisioning because their internal scope differed from the user's parent task. | The desktop board joins workspace IDs through the authorized swarm run and projects the real parent scope; inspect, message, and stop use the same lookup. Synthetic scopes are excluded from relay registration. |
| Waiting for desktop receipts or nested native cancellation while holding the admission lock could block unrelated work. | Controls validate selection under the lock, then release it before cancellation and receipt waits. Engine bridge tests cover pending remote controls and cancellation finalizers acquiring that lock. |
| An expired lease could falsely imply an executor had stopped or leave stale controls visible. | Expiry preserves the last known task state, marks it disconnected, disables write controls, rejects stale leases, and emits an automatic parent update. Tests cover renewal and deadline notification without a subsequent read. |
| Truncated snapshots or an unsupported task-list response could hide active work or enable an incomplete Stop all. | Active tasks are prioritized, truncation propagates across the relay, retained app snapshots keep per-source truncation, and Stop all rejects incomplete boards before mutation. Engine and browser regressions cover these cases. |
| Provider projection of the action union advertised only `list`. | The registered tool now advertises a flat public object with all five actions, while runtime validation keeps the action-specific union. The focused provider-wire regression passes for OpenAI Chat, Responses, and Anthropic and rejects nine malformed control payloads: two tests and 29 assertions; see [provider-wire-schema.log](provider-wire-schema.log). |

The screenshots above show the implemented panel, not a design mockup. Historical relay scaling and desktop spend scope remain explicit limits below; they were not represented as solved by these checks.

## Explicit boundaries

Desktop task spend is a separate subtotal of latest recorded workspace runs. It is not added to the native lifetime Session cost or native run-cap meter; unsupported usage remains unknown. Native ledger mirrors are excluded from the desktop subtotal.

Desktop control currently uses one authenticated long poll per retained real parent/project scope, including settled history. This preserves historical inspection but is not a measured large-history scaling solution. Coalesced polling or retention-aware registration remains follow-up work. Lease expiry is event-driven and does not claim that a disconnected executor stopped.
