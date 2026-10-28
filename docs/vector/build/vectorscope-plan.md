# VectorScope implementation plan

Status: proposed build plan, not an implementation or a claim of measured quality.
Baseline: `main` at `b3669a6b`, inspected 2026-10-28. Implement on `vectorscope`
after the owner reviews the plan and chooses the unresolved product gates below.

## Summary

Make VectorScope a distinct coding agent across the desktop, CLI and GitHub,
with an explicit review mode and a separately authorized fix mode. Establish
how well the existing product works before choosing improvements. Run the
production pipeline on real changes, preserve its trust and spending boundaries,
then consolidate the two runners and improve measured weaknesses in that order.

This plan does not implement a hosted development environment, Vector Labs,
team features or organization configuration. It does not take over the Hands or
`@vector` cloud-agent workstreams. GitHub Actions remains an existing execution
surface; this work does not create or purchase a new compute service.

## What the code does today

| Evidence | Present behavior and consequence |
| --- | --- |
| `script/vectorscope-eval/run.ts`, its README, `packages/core/src/review/eval.ts` | Ten synthetic fixtures, eight planted defects and two clean refactors. One prompt without tools, security/verify passes or production selection. Matching uses paths and nearby lines, not whether the finding identifies the defect. It is a prompt smoke test, not a product benchmark. |
| `.github/workflows/vectorscope-eval.yml` | Manual OpenRouter runs with model/repeat inputs and retained artifacts, but no total-dollar input or admission ledger. Do not dispatch it to measure the new plan without the budget work. |
| `packages/engine/src/review/run.ts`, `packages/app/src/features/pull-requests/ai-review.ts` | Separate execution loops share pure core functions but own session creation, cancellation, verification and cost handling. Both need to be measured; shared imports do not establish parity. |
| `packages/core/src/review/types.ts`, engine runner, desktop `ai-review.ts` | Default `verify` is `blocking`; desktop checks findings above nit unless explicitly off. Triage forces confirmation. Untrusted suggestions receive additional checks. Preserve these safeguards during consolidation and measure the cost of verifying all findings. |
| `packages/core/src/review/workflow.ts`, `packages/desktop/package.json` | `cliVersionSpec` pins an exact supplied version, falling back to `vectorRequiredCliVersion` for development versions. The manifest still requires `1.99.99`; a new desktop version is not proof that its CLI exists on npm. Fix publication/compatibility as one workflow, not by blindly substituting the desktop version. |
| `packages/engine/src/review/model.ts` | Model choice is configurable; an unattended run can fall back to an available free model which may not train on prompts. No benchmark-backed model certification exists. Keep the existing privacy restriction. |
| `packages/engine/src/cli/cmd/github.review.ts`, `github.review-api.ts`, core `prompt.ts` | GitHub passes PR title, body and author to the runner, plus gathered history/context and human comments. It does not pass a complete PR commit list or bounded linked-issue context. |
| `packages/core/src/review/symbols.ts`, engine `context.ts`, generated workflow | Call sites are gathered from regex-extracted changed symbols, with fixed limits; generated CI disables LSP, formatter and project config. Enabling an untrusted repository's tools is not a safe shortcut to deeper context. |
| `packages/core/src/review/permission.ts` | Review sessions deny all capabilities then allow a small read set; MCP resource reads under `read` with `mcp:*` are denied explicitly. No review MCP support should ship by removing that deny alone. |
| `packages/engine/src/agent/agent.ts`, `agent/prompt/review.txt`, desktop `runVerify` | Internal `vectorscope.*` sessions run with generic `review`/`security` specialist identities and helper lookup, not a separately configurable VectorScope identity. |
| Engine `session/prompt.ts`, `session/system.ts`, `session/tools.ts`, `session/posting.ts` | Outward memory audience depends on `vectorscope.*` session metadata, MCP instructions can enter through a zero-tool server, and resources have a separate read path. Posting checks traverse bounded child-session lineage. Changing only the agent name or tool list misses these boundaries. |
| `packages/core/src/review/skip.ts`, `types.ts` | Automatic reviews skip forks, and skip over 300 files or 5,000 changed lines after ignores. A permitted command can review a fork with untrusted handling. Large changes need bounded coverage, not an unlimited-size default. |
| Core `command.ts`, `state.ts`, CLI `github.review.ts` | Review commands, dismissal feedback, incremental state and verified-fix thread handling exist. They are foundations for conversation, not a general thread-answering agent. |

Existing protections are requirements: configuration from a trusted base for
remote PRs; no checkout or execution of fork code in a privileged review job;
redaction and posting checks; anchored suggestions; bounded attempts including
retries/finalizers; honest partial coverage; and exact head checks before writes.
Spending reservations are estimates and reported usage can exceed them. Neither
the product nor the eval may describe those estimates as guaranteed billing caps.

## Phase 0: measure the product first

### Dataset and ground truth

Build a versioned manifest of approximately 100 real, independently confirmed
bug-fix cases, plus at least 25 clean or behavior-preserving control changes.
Do not treat the corrective diff itself as the bug being reviewed. For each case,
identify the buggy candidate change and its prior base, then retain the later fix
as hidden ground truth. Cases without a defensible candidate/base pair are
excluded with a recorded reason, rather than manufacturing an easy reverse diff.

Record repository URL, license/redistribution permission, immutable base/head
and fix SHAs, language, defect family/severity, expected causal explanation,
locations with acceptable alternative evidence, regression-test evidence and
selection provenance. Public, licensed material only; no customer repositories,
personal email, credentials or private support threads in committed fixtures.
Prefer manifests and fetched immutable objects over redistributing whole repos.
Review archived content for secrets before committing excerpts.

Cover correctness, auth/security, asynchronous/concurrent code, persistence,
error paths and resource handling across several languages and repository sizes.
Use a reproducible sampling rule and record exclusions, so difficult or
oversized changes cannot disappear after results are seen. Include rename,
cross-file, incremental, fork and prompt-injection cases. Injection controls
are separate adversarial tests, not extra easy defects added to improve recall.

Split the bug cases roughly 60/20/20 for development, calibration and held-out
evaluation, grouping related repositories/fix families and respecting chronology
to limit leakage. Split controls separately. Freeze held-out labels before prompt
tuning; keep labels/fixes unavailable to model tools, retrieval and MCP snapshots.
Public model training contamination cannot be ruled out; record dates and this
limit. Do not advertise general real-world recall from 100 sampled cases alone.

### Runner and baselines

Add an eval adapter around the real engine `Review.run` pipeline with actual
read tools, context collection, security/verify passes, selection, anchoring,
finalization, spending and timeout behavior. Exercise the desktop adapter on
the same cases until consolidation proves equivalence. Mock only external
posting; retain the formatted payload the product would send. Use no live
GitHub write, repository install hook, project plugin or untrusted executable.

Baseline variants are: the frozen current engine pipeline; current desktop
pipeline; existing single-prompt harness; and an empty-finding control that
exposes precision denominator behavior. Compare verification/triage/context
variants one change at a time. External competitors are optional only if their
terms, access and owner-set budget permit a comparable replay; their absence
does not block measurement, and no comparative claim follows from proxies.

Record source SHA, fixture manifest hash, prompts/config hashes, exact model
identifier and provider/routing metadata where available, pricing snapshot,
randomization/repetitions, attempt history and tool traces. Record the runtime
and adapter. Hosted aliases can change underneath an ID; certification expires
when the relevant model, prompt, policy or pipeline changes.

### Metrics and judging

Report both proposed findings and findings that survive verification/selection
and would actually be posted. Measure defect recall, actionable-finding
precision, F1, duplicate comments, false alarms per clean PR, comments per PR,
severity agreement, location/anchor validity, suggestion validity, coverage,
timeouts/errors, wall time and total dollars/tokens including retries and judge
calls. Separate security categories, languages, trust modes and size buckets.
Report macro and micro aggregates, sample sizes and uncertainty intervals.

Match the causal defect, not merely line proximity. Two independent annotation
passes establish expected defects and adjudicate ambiguous results; a human
resolves disagreement. A separate model may assist with blinded matching but
cannot be the sole authority or score its own generated findings. Randomize
model identities in judge inputs. Review unexpected findings against the actual
code: a real additional defect is not automatically a false positive because it
was absent from the fix label. Freeze rubric revisions and re-score saved
outputs without repeating provider calls when possible.

Invalid/failed/partial reviews remain visible in the denominator and coverage
report. Present both conditional recall on completed reviews and end-to-end
recall where a failure cannot count as success. Never interpret missing usage
as zero spend or a skipped file as reviewed. Controls with zero findings have
undefined empirical precision on their own; show counts instead of presenting
the legacy scorer's convention of precision 1 as quality evidence.

### Budget, privacy and release gate

The paid eval is manual CI only. Require an owner-set finite positive total USD
budget, per-case limit, model list, fixture selection and repetition count.
Default to a no-network dry run that validates manifests and estimates cost.
Validate inputs without shell interpolation. One coordinator reserves remaining
budget before each provider/judge attempt, including retry and finalizer work;
settle reported usage, retain uncertain charges and stop new work when pricing
or usage cannot be bounded. Apply output/context/time limits and a conservative
reserve. An isolated provider key with a provider-side spend limit is the
stronger monetary boundary; it remains owner setup. Report overshoot honestly.

Use a protected eval environment whose reviewer is the owner. The repository's
existing `OPENROUTER_API_KEY` name is not permission to run it. Untrusted dataset
code never receives the key or network tools. Redact outputs, bound artifact
retention/access, keep raw reports outside the repository and publish only an
owner-reviewed aggregate. An eval failure cannot trigger a paid automatic retry.

Gate rules are to be ratified before collecting the held-out result. Proposed
first gate: no trust/consent regressions; no unaccounted paid attempts; at least
95% completed case coverage within the approved budget; at least 80% actionable
precision; at most 0.2 false alarms per clean PR; and no recall regression above
five percentage points against the frozen current pipeline on paired cases.
Report confidence intervals and require human review when they cannot resolve
the decision; the point thresholds are proposals, not current achievements.
Prioritize measured recall gains subject to precision, noise and spend limits.
Small held-out samples may require more data, not weaker thresholds. The owner
chooses whether these gates block release or first ship behind an opt-in.

## Architecture: one VectorScope agent, one runner

### Identity, modes, model and sessions

Introduce a dedicated `vectorscope` agent definition and prompt. Its settings
are independent of the generic `review` subagent, with an explicit review model
and optional triage model. Existing internal-session visibility and cancellation
continue to work when generic Subagents are disabled. Keep `review`, `security`
and `verify` as identifiable passes under VectorScope, with their permissions
intersected with the mode and trust policy; a specialist cannot broaden it.

Represent the invocation with validated mode, base/head, target repository,
source/trust, model/config snapshot, permission policy, memory namespace and
spend ledger. The trusted adapter sets these fields. PR text, MCP responses and
model output cannot choose them. Keep durable session admission and the
process-local runner coordinator separate as described in root `AGENTS.md`.

The engine owns orchestration. Core holds pure contracts, prompts, parsing,
selection and formatting. The desktop becomes an adapter for source capture,
progress, cancellation and presenting proposals; it must not import engine
runtime into the renderer. Expose typed protocol/server operations and regenerate
the client when that boundary changes. The CLI and GitHub call the same engine
entry point. Keep Node-compatible engine code, no Bun runtime dependencies.

Review mode can inspect permitted source and return findings/suggestions. It
cannot edit, run project code, push, merge, invoke arbitrary shell or write MCP.
Existing opt-in local `--checks` requires separately confirmed trusted-code
execution; a command-name allowlist does not make repository scripts safe.
Neither review mode nor a reviewer prompt may silently switch into fix mode.

### Fix proposals and consent

Fix mode creates a bounded patch proposal against an exact base/head. Applying
locally, running repository checks and pushing are separate capabilities. Show
the concrete diff, paths, destination branch/repository and requested commands
before granting each new capability. A trusted preauthorization may cover an
explicit bounded operation; vague PR text and other people's replies never do.
Store consent with actor, scope, source/head SHA, patch digest and expiry.

Use a separate worktree for a fix. Re-check head and user worktree state before
apply/commit/push and compare-and-write files atomically against the approved
preimage; a moved head or changed patch invalidates consent. Commit and push
are separate permissions, and existing no-push fix prompts stay effective. Never
overwrite dirty user changes. Keep writes behind a trusted executor, not free
shell access for the model. GitHub verifies the requester's current write access
on the target and uses a separate short-lived write credential only after
approval. No fix job executes fork code with privileged tokens. If safe isolated
checks are unavailable, report checks not run. No automatic merge or permission
to push to the base branch; creating a fix branch/PR also needs scoped consent.

Posting a suggestion is not consent to apply it. Test failures or an additional
model pass cannot authorize new changes. Preserve audit records and cancellation
without persisting tokens or leaking private review context into commits/PRs.

### Memory and feedback

Give VectorScope its own repository-scoped namespace for accepted review
preferences, adjudicated finding outcomes and approved recurring checks.
Separate owner-authored policy from observed PR data and proposed learning.
Do not automatically import general chat/personal memory into shared reviews.
Retain the existing posting guard for any recalled content that could leave the
machine. PR/MCP content cannot install instructions or create durable accepted
memories; proposed learning requires the user's approval. Separate local/private
memory from repository-shareable policy, with inspect/delete/disable controls.
Deleting a review or clearing memory must cover this namespace and raw context.

Do not record a dismissed finding as a universally false rule. Capture reason,
scope and supporting evidence; contradictory evidence can reopen a proposal.
Review quality improvements must be measured before enabling automatic learning.

Today `session/prompt.ts` chooses the outward audience from `vectorscope.*`
internal-session metadata, not the agent name. Preserve that metadata or replace
it with an equivalent server-bound policy for review, fix and all child passes;
missing scope stays untrusted. Every external write must retain the posting
guard and complete contributing session lineage. Existing traversal is bounded
(depth three, 200 sessions); new fan-out must either stay within a proven bound
or fail closed when the guard cannot inspect every contributor.

### MCP support without PR-driven egress

Reuse Vector's MCP connection, authentication and lifecycle infrastructure,
supporting existing server transports through a review-specific broker. Servers
and tools are disabled for VectorScope until the owner consents per server and
repository/context. Grant only selected read capabilities; server-provided
`readOnlyHint` or tool names are not sufficient authority. Unknown or potentially
writing tools stay denied. Schema/endpoint/capability changes invalidate consent.
MCP write access is not part of this plan; fix mode does not inherit it.
Consent also filters server instructions, prompts and resource listings before
they reach the agent. In particular a server with zero tools must not bypass
consent through the current system-prompt instructions path.

Read calls are outbound data too: search arguments, resource URIs, pagination
cursors and errors can carry code or secrets. Therefore untrusted PR reviews
receive **no live model-controlled MCP calls**, even to approved read servers.
Before exposing PR text, a trusted broker may take an explicitly authorized,
bounded snapshot from owner-selected resources with fixed arguments originating
from trusted configuration. PR titles, bodies, diffs, comments, model-generated
queries and derived identifiers must never influence those requests. Run no
MCP calls after PR exposure for an untrusted invocation. Disable dynamic tool
discovery/resource expansion that would send its contents outward. If a server
cannot supply such a snapshot safely, it remains unavailable for that review.

Trusted local reviews may request live read calls after server consent, with
tool and argument allowlists, directory/resource scopes, bounded results and
confirmation before sending sensitive code. A locally checked-out PR is not
automatically trusted; author identity, provenance and requested operation
matter, and same-repository contributions can still contain hostile text.
External/untrusted inputs downgrade subsequent egress capability until a new
trusted invocation is created. Responses remain untrusted data, cannot request
more permissions, and cannot be learned or posted without the normal checks.

Keep MCP credentials within the connector, remove model-facing general network
tools, and deny alternate resource-read routes such as `read mcp:*`, nested
subagents and plugin-exposed tools. Enforce policy at execution as well as tool
listing. Audit consent/server/tool identifiers and hashes rather than raw query
data. Test attempts to encode source in URIs, search, error handling and retries;
resource redirects, server reconnects and cancellation must obey the same policy.

## Phased work packages

Paths marked new are proposed files. Test paths are to extend where present or
create when absent. Run test files individually from their package directory;
typecheck affected packages individually. CI owns full suites; no paid eval is
an implicit validation step.

| Phase / package | Files and implementation scope | Verification and done criteria |
| --- | --- | --- |
| 0 / VS-01 Dataset contract | New `script/vectorscope-eval/dataset.ts`, manifest/schema and annotation guide; existing `fixture.ts`. Define immutable candidate/base/fix records, licensing, provenance and grouped splits. | Extend `script/vectorscope-eval/fixtures.test.ts` with missing objects, wrong ancestry, post-fix leakage and duplicate-family split cases. Dry-run validates the frozen manifest and reports exclusions; labels never enter a prompt/tool view. |
| 0 / VS-02 Production replay | New `packages/engine/src/review/eval.ts`; engine `run.ts`, `source.ts`, `context.ts`; eval driver. Run the actual pipeline with recording posting adapter; replay desktop through its injected client. | New engine `test/review/eval.test.ts` covers security/verify/finalize, partial/error/timeout and an untrusted case; compare final placed findings/payloads, not just raw JSON. Baseline artifacts identify source/config/model and every attempted call. |
| 0 / VS-03 Budgeted manual CI | Eval driver and `.github/workflows/vectorscope-eval.yml`; new `script/vectorscope-eval/budget.ts`. Add total budget, per-case bound, dry-run, protected environment and ledger. | New budget tests exercise parallel reservations, retries, unknown cost, cancellation and overshoot accounting without real API calls. Dispatch has no paid default or PR trigger; every paid provider/judge attempt needs admission. |
| 0 / VS-04 Causal judging and gate | Core `review/eval.ts`, new eval judge/report modules, annotation rubric and gate config. | Extend core `test/review/eval.test.ts` for same-line wrong defect, extra true defect, duplicates, zero denominators and missing runs. Blinded human-adjudicated report includes confidence intervals/coverage/spend; owner chooses thresholds before held-out run. |
| 1 / VS-05 Compatible CLI setup | Core `review/workflow.ts`, desktop manifest/build identity and `src/main/github-pr.ts`; CLI publication owner action. Pin a verified published compatible CLI and detect stale installs. | Core `test/review/workflow.test.ts`, desktop `github-pr.test.ts` and `scripts/build-identity.test.ts` cover release/dev/missing-publication paths. Do not point workflows at an unpublished version or a moving `latest`. Owner publishes npm; plan work never does. |
| 1 / VS-06 Verification parity | Core `types.ts`, `config.ts`, `plan.ts`; engine `run.ts`; desktop `ai-review.ts`. Use one documented verify policy, proposed default `all`, preserving stricter triage/untrusted-suggestion rules and explicit override semantics. | Core config/plan tests plus engine `test/review/run.test.ts` and desktop `ai-review.test.ts` cover all/blocking/off, denied attempts and incomplete verify. Evaluate precision, recall and added spend before changing defaults. |
| 1 / VS-07 Model evidence | Engine `model.ts`; core new `review/model-evidence.ts`; desktop model selection and workflow setup. Associate certification with eval artifacts/config and expiry. | Engine `test/review/model.test.ts`, core new evidence tests and desktop review tests cover unvetted/retired/rerouted models, explicit choice and private-code policy. Warn accurately without silently switching model or treating free/privacy-safe as quality-certified. |
| 2 / VS-08 Shared invocation contract | Core new `review/invocation.ts`, schema/protocol review contracts as needed; engine new `review/service.ts`; existing CLI/adapters. Validate mode, target, trust, consent, snapshots and budgets centrally. | New core contract and engine service tests reject PR-controlled policy, incompatible modes and stale heads. Follow Schema→Core/Protocol→Server dependencies; regenerate client for public API changes. |
| 2 / VS-09 Standalone agent | Engine `agent/agent.ts`, new `agent/prompt/vectorscope.txt`, review model resolution, settings agent selection and internal-session metadata. | Engine `test/agent/agent.test.ts`, `test/review/structured-output-review.test.ts`, review model tests and app settings tests prove independent prompt/model, hidden pass identity, cancellation, and operation when generic review Subagents are disabled. No new permission inherited from generic build mode. |
| 2 / VS-10 Consolidate desktop runner | Engine review service, protocol/server/client boundary and app `ai-review.ts`, `pull-requests.tsx`. Move execution/limits into engine; keep renderer presentation and transport adapter. | Run the frozen shared replay against CLI/GitHub/desktop; extend app `ai-review.test.ts` and engine review tests for disconnect/reconnect/cancel/finalizer/usage. Payload/selection parity or documented intentional differences; no engine imports in renderer. |
| 2 / VS-11 Isolated review memory | Engine new `review/memory.ts`, `session/memory.ts`, `session/posting.ts`; core review state and existing persistence/migration facilities. Add scoped preferences and approval-backed feedback. | New review memory tests and existing knowledge/posting tests cover no personal-memory recall into public reviews, forged dismissal/learning, cross-repo isolation, migration and erase. Namespace inspect/delete/disable works; no global rule learned from one dismissal. |
| 3 / VS-12 Consented local fixes | Engine new `review/fix.ts` and consent contract; CLI `review.ts`; app PR actions/diff preview. Separate proposal, apply, checks and push states. | New engine fix tests and app action tests cover dirty checkout, path traversal/symlinks, head movement, changed digest, revoked/expired consent, failed check and cancellation. Approved patch applies only in its own worktree; unrelated work and base branch remain intact. |
| 3 / VS-13 GitHub fixes and thread replies | CLI `github.review.ts`, `github.review-api.ts`, core `command.ts`, `workflow.ts`, state; dedicated narrowly scoped fix execution boundary. Reply only to an authorized addressed thread and bind fixes to its exact head. | Extend CLI GitHub tests/core command/workflow tests for revoked collaborator rights, fork requests, bot loops, duplicate delivery, quoted commands, force-push, permission separation and stale findings. No push without scoped consent; reply posting goes through current redaction/posting guards. Coordinate with `@vector` owner before changing shared routing. |
| 3 / VS-14 MCP broker and consent | Engine new `review/mcp.ts`, existing `mcp/index.ts`/lifecycle/auth; core `review/permission.ts`; protocol/settings UI for per-server grants. | New engine `test/review/mcp.test.ts`, core permission tests and MCP lifecycle tests cover missing grants, unknown write tools, fake annotations, changed schema/endpoints, symlinks/resource redirects, token leakage and alternate `read mcp:*` paths. Default remains deny, credentials stay out of model tools. |
| 3 / VS-15 Untrusted MCP snapshots | Broker, invocation contract, source/context packers and desktop/GitHub adapters. Acquire fixed owner-selected snapshots before PR exposure; strip live MCP from untrusted sessions. | Adversarial tests inject code into query/URI/cursors/comments and request nested tools/retries/reconnects. Instrument the broker: zero outbound calls influenced by PR or model text, no post-exposure network calls. Unsupported servers fail closed with an explicit unavailable-context note. |
| 4 / VS-16 PR and issue context | CLI GitHub API adapter, engine `context.ts`, core `prompt.ts`, desktop PR data contract. Fetch bounded commit messages and explicitly linked same-repository issue context with permission/provenance labels. | Adapter/context/prompt tests cover pagination caps, deleted/cross-repo/private issues, untrusted URLs, API rate limits and injection. No arbitrary URL fetch; no extra account scopes by default; all new text remains data. Measure cross-file recall improvement. |
| 4 / VS-17 Semantic context | Core `symbols.ts`, engine `context.ts`, existing language-service adapter behind trusted execution policy. Begin with deterministic syntax/call-graph context from pinned trusted parsers. | Context/source tests cover renamed/overloaded symbols, unsupported syntax, dependency limits, generated files and timeouts. No project install or untrusted LSP launch in privileged CI. Ship deeper context only with measured gains and bounded latency/spend. |
| 4 / VS-18 Deterministic diagnostics | New engine `review/checks.ts`, isolated diagnostic adapters and core finding provenance/deduplication. Opt-in trusted linters and offline secret scanning with pinned tools/rules. | New check tests cover malicious configs/scripts, secret redaction, no scanner network/telemetry, duplicate model findings and cancellation. Never print the discovered secret. Treat runner isolation as a prerequisite for executing project code; unsupported CI reports unavailable diagnostics. |
| 5 / VS-19 Bounded large PR coverage | Core `skip.ts`, `plan.ts`, state/types; engine runner; desktop estimates/progress. Add explicit resumable batches and cross-batch context rather than deleting size limits. | Core skip/plan/state tests and engine replay cover exactly-once batches, head changes, cross-file defects, cap exhaustion and partial coverage. Never label an incomplete review clean; measure size-bucket precision/recall/spend before automatic enablement. |
| 5 / VS-20 Feedback, setup and rollout | Review state/commands/memory, desktop setup, docs/vectorscope page and owner-actions. Show verified/unverified model status, consent and missing setup; add opt-in rollout and rollback flags. | Existing desktop GitHub/app tests cover stale workflow detection, interrupted setup and clear unavailable states. Final frozen eval, security review and per-surface smoke fixtures pass; owner approves release/public language. No team/org features or new commercial gate chosen by engineering. |

Order: VS-01–04 before quality promises; VS-05–07 for immediate correctness and
consistency; VS-08–11 before adding capabilities; VS-12–15 for consent and MCP;
then VS-16–20 ordered by measured impact. MCP snapshot design and fix consent
must be reviewed before implementation, not bolted onto permissive tools later.
At each phase review from two angles: contract/tests and trust/cost/portability.
Record deviations and evidence, commit review fixes and push the phase branch.

## Branch overlaps and sequencing

| Workstream | Coordination boundary |
| --- | --- |
| `self-evolving` multi-agent parity | Agent registry, subagent identity/permissions, file locks, session orchestration and memory may change. Rebase and reconcile these contracts before VS-08–12; do not copy a second coordinator or bypass read-before-write/locking. Keep review worker fan-out under its limits. |
| `codium` | Consumption percentages, model entitlement, gateway privacy and cloud-agent allowance are owned there. Use existing billing/model abstractions; do not expose tokens/prices in a Codium product UI or invent top-ups. Eval dollars are operator diagnostics. Product plan gating is an owner decision. |
| `vector-at-mention` | `api/cloud-agents/*`, `api/_lib/cloud-agents-*.ts`, `api/_lib/github-oidc.ts` are reserved. Agree shared GitHub routing/permission and consent contracts rather than editing those files. Separate review/fix identity from generic task mention behavior. |
| `hands` | Computer-use tools are unrelated to review and remain denied. No takeover of that branch or its work packages. |
| Release 1.99.112 | This plan is based on its merged main state. It neither blocks the approved release nor changes its version/catalog. Do not bundle unmeasured reviewer changes into it. |
| Owner npm/catalog work | CLI publication is required for VS-05; use a verified published version only. Model evidence identifies exact evaluated models, not an unsupported catalog claim. |

## Owner decisions and external prerequisites

1. Approve/revise this plan, numeric release gates, whether they block release,
   and any product-plan gating. These choices are unresolved, not assumed.
2. Choose the finite eval budget, candidate models, protected CI reviewers,
   OpenRouter key/provider limit, annotation time and permitted source datasets.
   No live paid eval runs before those are supplied.
3. Publish an appropriate CLI on npm and approve workflow migrations. Register
   any needed GitHub App permissions via the separate owner setup workflow.
   Reuse existing auth until explicit new scopes are approved.
4. Choose local and GitHub fix preauthorization boundaries. Default is a concrete
   per-operation approval, separate for apply, repository execution and push.
5. Approve servers/resources for MCP snapshots and whether trusted local live
   read tools are offered initially. No untrusted live-call exception is proposed.
6. Review publication of eval aggregates and any new product claims. The plan
   and fixtures do not establish parity with another reviewer.

These owner actions do not block deterministic contract/tests, dry-run tooling
or plan review. Keep a short status record of implemented packages, measured
results, unavailable prerequisites and the next exact action; do not mark a
phase complete because a design document exists.

## Deferred work and public claims

Deferred: organization/team policy, seats, non-GitHub review hosts, broad MCP
writes, automatic merging, hosted development workspaces, laptop/Slack/Linear/
Jira bots, Vector Labs, and arbitrary untrusted-code execution. Also defer
autonomous durable learning until measurement supports it. Existing GitHub
Enterprise support must keep working; it is not a new provider expansion.

Allowed before measurement: factual descriptions of implemented surfaces and
their tested behavior, qualified by current limitations. After an approved eval,
describe only the exact pipeline/model/dataset/version and observed metrics with
sample size, uncertainty, coverage and spend. No claim of competitor parity,
superiority, certified accuracy, guaranteed spend cap or universally safe MCP
follows from this plan. Public wording requires the owner's approval.
