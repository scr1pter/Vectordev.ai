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
| Release 1.99.112 | `release-prep` | Version, unsigned allowlist and changelog preparation; publication needs green integrated CI, exact catalog parity and protected release approval. See `release-199112.md`. |
| Service setup prompt | `vector-takeover` | Written in `codex-setup-prompt.md`. No external setup performed. |
| Multi-agent parity | `self-evolving` | WP1–22 inherited; WP23 implementation and independent review in progress. WP24–40 and phase/final review remain. |
| Codium | `codium` | A00–08 inherited; A09 plan changes/consent in progress. A10–60 and Track B remain. Test environment and CI branch approval need the owner. |
| VectorScope | `vectorscope` | Measurement-first build plan written in `docs/vector/build/vectorscope-plan.md`. Runtime implementation and paid eval have not started. |
| Approved tokenomics/copy | `approved-fixes` | Standard task tracking and planned 550B+ Vector Velocity wording; evidence-gated audit recommendations recorded separately. |
| Reviewed catalog restoration | `catalog-112` / catalog fork `codium-112` | Restore prior reviewed model records through the fork before unskipping the canonical mirror check. Coordinate the release pin and website mirror. |

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
- Confirm/set the reviewed catalog fork revision with an appropriately scoped
  account; this session's integration receives HTTP 403 listing Actions variables.
- Provide Codium's CI branch approval, `codium-test` environment and test-only
  secrets before that protected lane can run. No real billing APIs or deployment
  are part of implementation tests.
- Use the supervised setup prompt for GitHub App registration, Slack registration
  and Codium OpenRouter privacy. Codium and free-model privacy accounts have
  different documented ZDR settings; keep them separate.
- Stripe setup, signing credentials and npm CLI publication remain owner actions.
- Choose a finite budget, model set and dataset/release gates before a paid
  VectorScope eval. No measured quality claim follows from writing its plan.

The 1.99.111 GitHub release is a draft, but its successful release workflow
verified the separate production download and update pointers. Do not use the
GitHub latest-release endpoint alone to infer Vector's installed version.
