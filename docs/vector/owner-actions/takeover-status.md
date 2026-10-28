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
| Release 1.99.112 | `release-prep` | Candidate `dfc98974` landed on clean `main` through all 23 pre-push checks. Full source CI is green. Release run [40781089625](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40781089625) was dispatched from that exact SHA with the existing catalog. Full source CI, native tests, catalog parity and all platform builds passed. The publish job is waiting for the owner's `production-release` review; publication is not claimed. See `release-199112.md`. |
| Service setup prompt | `vector-takeover` | Written in `codex-setup-prompt.md`. No external setup performed. |
| Multi-agent parity | `self-evolving` | WP1–22 inherited; WP23 committed with 237 passing cases and engine typecheck. WP24 and WP25 committed and pushed, with 231 and 143 passing cases respectively and independent review closed. WP26 is in progress; phase/final review and later work packages remain. |
| Codium | `codium` | A00–08 inherited; A09 and A10 committed and pushed. Complete CI run `40783630533` passes, including billing/API tests, browser specs and all eight typechecks. A11 focused and regression checks pass; its final review is pending. A12–60 and Track B remain. Protected provider end-to-end setup needs the owner. |
| VectorScope | `vectorscope` | Measurement-first build plan written in `docs/vector/build/vectorscope-plan.md`. Runtime implementation and paid eval have not started. |
| Approved tokenomics/copy | `approved-fixes` | Standard task tracking and planned 550B+ Vector Velocity wording validated by 47 tests; evidence-gated audit recommendations recorded separately. |
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

- Approve `production-release` in GitHub for the approved 1.99.112 run only;
  later releases and unlisted main merges need separate authorization.
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
