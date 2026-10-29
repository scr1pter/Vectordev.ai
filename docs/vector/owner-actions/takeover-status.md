# Vector handoff execution

Baseline checked 28 October 2026: `main` is `b3669a6b`; `self-evolving` starts
at `e92862a2`; `codium` starts at `591cd1f0`. GitHub is the source of truth.
Changes below belong to separate work branches and do not imply deployment.

## Repository map

- `packages/app`: SolidJS application and pull-request UI.
- `packages/desktop`: Electron host, secure credentials, IPC and update handling.
- `packages/engine`: Node-compatible agent/session execution, tools and review runner.
- `packages/core`: shared policy and review logic; task sizing and model context.
- `packages/schema`, `protocol`, `server`, `client`: typed contracts and transport.
  Generate clients after changing a public protocol; do not edit generated code.
- `packages/web`: Astro website, shared release copy and static model mirror.
- `api`: hosted account, GitHub identity exchange, billing and gateway handlers.
- `.github/workflows`: general CI, protected releases and operator workflows.

Engine runtime changes must use Node APIs. Install with lifecycle scripts
disabled, run focused tests from package directories and serialize local Bun
checks. Push through the required pre-push typecheck; never bypass it.

## Workstreams

| Work | Branch | State / next gate |
| --- | --- | --- |
| Release 1.99.112 | `release-prep` | Exact source `dfc98974` passed full CI, native tests, catalog parity and all platform builds in [40781089625](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40781089625), using the existing catalog. The owner authorized the agent to approve this run. GitHub rejected the connected integration's review POST with HTTP 403, so the protected publish job still waits. Publication is not claimed. See `release-199112.md`. |
| Service setup prompt | `vector-takeover` | Written in `codex-setup-prompt.md`. No external setup performed. |
| Multi-agent parity | `self-evolving` | WP1–22 inherited; WP23–26 committed and pushed with focused checks and independent review closed. WP26 at `fbefa794` passed all 23 pre-push checks. Its 22 new cases passed; existing regression results and the isolated timing failures are recorded in the branch's deviation notes. WP27 source work is in a separate checkout. Pre-push review reproduced two size-limit cleanup cases that could lose uncaptured edits; the retention fix and regression checks are in progress before publication. Phase/final review and later work packages remain. |
| Codium | `codium` | A00–14 and reviewed browser repairs are pushed at `4539d83b`; all 23 pre-push checks pass. The fresh Codium browser job passes. Full Linux/Windows CI [40810044741](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40810044741) is running after three obsolete top-up assertions were replaced. A15 is pushed separately at `56bb1b69` on `codium-next`, with 138 tests, API/web types and all 23 pre-push checks passing. New models stay inactive pending gateway enforcement and provider evidence. A16 is underway; later work and Track B remain. |
| VectorScope | `vectorscope` | Measurement-first build plan written in `docs/vector/build/vectorscope-plan.md`. Runtime implementation and paid eval have not started. |
| Approved tokenomics/copy | `approved-fixes` | [Draft PR19](https://github.com/scr1pter/claudeondfsfdaf/pull/19), source `279d4292`, contains milestone-only task tracking, planned 550B+ Velocity wording, initial work-session titles and stream-deadline cleanup. Focused tests, native Node regression and all 23 pre-push checks pass; full required PR CI passes, including both browser platforms and the Node engine bundle. Both navigation jobs passed 9/9 samples, with mixed timings. Four offline footprint jobs completed eight valid sessions; raw evidence and limits are preserved. Live cache work remains a proposal. |
| CI timing fixture | `ci-timers` | [Draft PR18](https://github.com/scr1pter/claudeondfsfdaf/pull/18), source `eaffaf26`, has full Linux/Windows CI, browser, Node bundle and Vector Local checks passing. Controlled delayed execution reproduces the old extra-read failure and passes after the fixture repair. Current request-count and spending assertions remain intact. |
| Reviewed catalog restoration | `catalog-112` / catalog fork `codium-112` | Four prior reviewed model records restored through the fork; canonical mirror test re-enabled (26 tests pass). The owner chose to keep the existing catalog for 1.99.112; restoration remains deferred on separate branches. |

Newer Mac-only specs, deviations and the partial A09 patch were unavailable in
this cloud workspace. Their absence is not evidence that no local work exists;
reconcile those notes before replacing them on another machine. Committed
contracts govern work here; new deviations must be committed too.

## Decisions preserved

The owner canceled cloud GitHub development sessions in this chat. Do not build
or purchase a sandbox provider or implement the handoff's Open from GitHub
cloud-environment item without renewed direction.

Vector Velocity is the owner's planned model with 550B+ parameters. No weights,
benchmarks, performance result or release date is established. Codium's future
Max/Ultra perk remains Coming, not part of a current purchase.

Hands and the `@vector` implementation remain separate owners' work. Do not edit
`api/cloud-agents/*`, `api/_lib/cloud-agents-*.ts` or `api/_lib/github-oidc.ts`
as part of Codium. Do not implement Vector Labs, team features or parked R2 work.

## Owner and external gates

- The owner has authorized approval of the specific 1.99.112 run. GitHub reports
  the reviewer eligible, but the connected integration's approval POST returns
  `403 Resource not accessible by integration`. Browser-control tools are absent
  from this session. A GitHub UI approval or a connection with review capability
  is still needed; no protection setting was changed. Later releases and unlisted
  main merges need separate authorization.
- Keep the existing catalog for 1.99.112, as the owner directed. The restored
  catalog is separate; landing it later requires coordinated fork and mirror pins.
  This session receives HTTP 403 listing Actions variables. Release catalog job
  `123143384093` verified the existing fork revision
  `52edfd113616e57761c70fd5d01ac578d645211c` and the unchanged
  `a96b465110dd2fcc38e0dcca1a4115e12ea43ddaafdb0ebf587e15026767bf14` digest.
- Codium's ordinary CI already ran, including its typecheck matrix; the handoff
  note about branch approval was stale. Its protected provider end-to-end lane
  still requires the owner's `codium-test` environment and test-only secrets.
  No real billing APIs or deployment are part of local implementation tests.
- Use the supervised setup prompt for GitHub App registration, Slack registration
  and Codium OpenRouter privacy. Codium and free-model privacy accounts have
  different documented ZDR settings; keep them separate.
- Stripe setup, signing credentials and npm CLI publication remain owner actions.
- Choose a finite budget, model set and dataset/release gates before a paid
  VectorScope eval. No measured quality claim follows from writing its plan.

The 1.99.111 GitHub release is a draft, but its successful release workflow
verified the separate production download and update pointers. Do not use the
GitHub latest-release endpoint alone to infer Vector's installed version.
