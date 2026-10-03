# Release approval and external prerequisites

Status checked October 3, 2026 UTC. The owner reserved version 2 and allowed an
interim 1.x release. The candidate follows main's **1.99.99** desktop and CLI
version; earlier **1.999.99** preparation records remain historical. Unsigned
builds are approved, and on October 3, 2026 the owner confirmed that unsigned
releases also update the in-app update feeds: everyone can download 1.99.99, and
installed copies update to it with Check for Updates.

The latest owner instruction authorizes landing the verified candidate on `main`
by a normal fast-forward after the release checks pass. If main advances, integrate
it and recheck parity before landing; never force-push main. The owner will start
the desktop release workflow. Neither main landing nor publication is claimed at
this checkpoint. No purchases or paid model fallbacks are authorized.

## Current checkpoint

The `release-validation` candidate and [draft PR #7](https://github.com/scr1pter/Vectordev.ai/pull/7)
include main `9252aba12694b8a6729a4b31cca0f4205e0d3e13` as an ancestor. Main's
free-access changes, branch switching, VCS behavior, footer and removal of Code
Archaeology and Why Vector are preserved. The signed-feed-only rule this candidate
briefly restored was reverted on the owner's confirmation: unsigned releases update
the in-app feeds. This candidate has since landed on main as `a3818c26d`.

Native validation at `1c7187dba6a14267c329224ba44c6c1c228c286f` has passed both
ordinary unit jobs, Linux's generated-client and full HTTP API gates, both browser
jobs, all four Windows Engine shards, all four typecheck jobs, the website build,
free-model and public-sharing integrations, and the real Windows installer. The
complete general test workflow passed at the saved 02:04:39 UTC checkpoint.

At `a6759ced78edc13d7cb538c5ab1066de2b3b723c`, the
[controlled Windows comparison](https://github.com/scr1pter/Vectordev.ai/actions/runs/37088744819/job/111104341047)
identified the missing `PSModuleAnalysisCachePath` environment variable as the
cause of the focused command-discovery failure: strict Turbo failed in 15,674.88 ms,
while restoring only that variable passed all three cases, with the nested case
finishing in 1,161.65 ms. The same nested case under loose Turbo passed in
1,173.27 ms, but removing only that variable made it fail in
15,567.39 ms. Restoring only `LOCALAPPDATA` still failed. All eight native Engine
identity and ownership cases passed with 52 assertions; the real Windows installer
also passed. These controls retain the original commands, assertions and deadlines.

The fix preserves the runner's existing cache setting only for the Core test task
and removes the experimental comparisons. At `9383a0260d048e5c13c1691798400ff16e0af194`,
both direct and strict-Turbo native runs passed all three cases with 14 assertions
each. The eight native Engine identity/ownership cases and real Windows installer
also passed. This changes no production environment handling or deadline.

The completed general workflow at that source passed Linux unit tests, generated
client and full HTTP API gates, both browser jobs, and Windows Engine shards 1–2.
All typecheck, website, free-model and public-sharing workflows passed. Windows
unit tests finished with 1,564 Core passes, 13 skips and one failure: the new
stdout-EOF fixture. The exact Node version on Windows deliberately ignores
`fs.closeSync(1)`, so the fixture never closed stdout. A replacement fixture closes
its own native Windows handle and independently checks stdout EOF while the same
child and stderr remain alive. Its full Core test file passed 33 tests and 49
assertions locally; Core typechecking passed. Native acceptance subsequently
passed at `d0ef7e5b2f2a479f5163e7caacdaf95835db87b4`: the raw stdout-EOF
precondition and actual process helper passed both cases with 11 assertions.

Windows Engine shard 3 recorded two CLI subprocess timeouts before their
substantive assertions. Its timeout path discards partial collected output, so an
empty reported stdout is not evidence that the child emitted nothing. Shard 4
recorded one held-shell readiness failure before PowerShell wrote its first
command marker; the later held-shell case passed. Matched native diagnostics are
prepared with isolated runtime checkouts and unchanged deadlines. The diagnostic
harness passed Engine typechecking, both CLI cases (17 assertions), both held-shell
cases (17 assertions), and eight stream-transparency assertions locally. These
failures have not been attributed to a runtime regression.

The full local Core suite before the fixture correction passed 1,575 tests with
one Windows-only skip and 5,973 assertions. The first full Engine run recorded
3,814 passes and three sandbox failures because its isolated HOME was inside the
deliberately writable temporary directory. The unchanged sandbox file then passed
all 23 tests and 202 assertions with a fresh credential-free HOME outside temporary
paths. The subsequent `9383a026` full run was stopped after 1,519.55 seconds under
severe host contention, with four recorded timeouts and no final suite summary.
All four cases subsequently passed on both the candidate and clean main with
their original deadlines, isolated source resolution and stable observed timers.
The interrupted full run remains incomplete and failed; focused passes do not
relabel it as successful. Full release acceptance is not claimed.

At `d0ef7e5b2f2a479f5163e7caacdaf95835db87b4`, the complete local Engine suite
passed with **3,817 passes, 23 skips, one todo, zero failures, 60 snapshots and
12,838 assertions** in 652.86 seconds. It ran from a clean exact-source checkout
with a fresh credential-free HOME outside temporary paths, unchanged deadlines
and no observed timer stalls. The completed native checks passed Windows unit
tests, Engine shards 1–3, both browser suites, all typecheck jobs, website,
free-model and sharing integrations, native process/ownership checks and the real
Windows installer. Linux unit tests, generated-client checks and the full HTTP API
gates also passed. The two shard 4 cases were the general workflow's only failures.

The same source's Windows Engine shard 4 failed both held-shell readiness cases:
862 passes, 26 skips, two failures and 2,916 assertions. Both fibers remained
pending with a running tool row but no first command marker. That row is persisted
before configuration, plugin hooks and native spawning, so its presence does not
prove PowerShell was launched. Both cases and both CLI cases passed the focused
comparison on the candidate and clean main with the original deadlines and
verified import ownership. Main remains unchanged while test-only phase tracing
and comparisons of the complete prompt file and the same 69-file preceding
workload investigate the full-suite delay. No deadline increase or unproved
production workaround is part of this diagnostic step.

The `ddee62fff6d03be2e63932ee4078c54d15f91b52` diagnostic runs did not reproduce
the readiness failure. Both complete prompt-file runs passed 55 tests with 14
skips and 233 assertions. The candidate's exact preceding workload passed 655
tests with 26 skips and 2,344 assertions; main ran the identical 69-file order and
passed both readiness cases but failed two unrelated baseline review/schema
checks. No protected review file was changed. The ordinary Windows Engine shard
4 also passed: 864 passes, 26 skips, zero failures and 2,933 assertions across
890 tests and 82 files in 583.84 seconds. Both native launches returned promptly,
and their children reported readiness within the original five-second window.

Those successes do not identify the earlier timeout's cause. The temporary
comparison workflow, file manifest, service tracing and optional CLI diagnostics
are removed before final release validation. The normal fixtures, real child
barrier, commands, assertions and original deadlines remain intact. After removing
the probes, Engine typechecking and both held-shell tests passed locally with 17
assertions. No production code changed during this diagnostic investigation.

The publishing machine's ordinary `npm whoami` check now succeeds after the owner
logged in. Earlier `E401` records below are historical. The public catalog fork
exists at the reviewed revision
`690fd27d61c7a8acc5fd93aeda4f128d67d149fd`; its canonical release catalog remains
SHA-256 `a96b465110dd2fcc38e0dcca1a4115e12ea43ddaafdb0ebf587e15026767bf14`.
Saving the final Actions revision still awaits the owner's GitHub passkey
confirmation. If both catalog variables are unset, the reviewed committed-export
fallback is available; a partial pair must fail closed. No immutable catalog
publication or installer publication is claimed here.

Vercel agreement/Create and Supabase OAuth confirmation remain owner actions.
Netlify registration was canceled and is not a blocker for this requested rollout.
No new OAuth credentials or live customer consent flow are claimed. Real personal
OpenRouter acceptance with an unfunded account also remains unverified: eligibility
and zero-price/privacy guards stay enforced, and rejection stops the request.
Do not add credit, a payment method, top-ups, paid plugins or a paid fallback to
make that check pass. Stripe was signed out, so its account-side wind-down still
requires the owner. The five retired billing/access environment variables are
absent; the existing nonbilling service variables were preserved.

The last verified public versions remain desktop **1.99.8** and CLI **1.99.7**.
A local app reporting 1.99.99 without source metadata does not prove installation
of this candidate. Verified local Mac artifacts from an earlier source likewise
do not establish a build or publication of the final landing commit.

Protected review runtime files, CLI commands and Vectorscope documentation are
unchanged relative to main. Four inherited test-only differences already existed
at resumed source `30aede8ab8bbef18710b9f628c9746684223f18a`: `github.auth.test.ts`
uses a file URL for the child import; `github.lifecycle.test.ts` preserves native
POSIX signals and exercises handlers through stdin on Windows; `cli/review.test.ts`
disables autocrlf for its exact-byte fixture; and `review/source.test.ts` does the
same during its clone. None of those four files changed after that resumed source.
No new Vectorscope change is part of this landing work.

All sections below record earlier checkpoints. Their branch holds, npm failures,
unfinished checks and owner-input lists describe those dates; the current status
above supersedes them without discarding their evidence.

## Historical integrated-main checkpoint

The candidate incorporates main through `9b6f2a45d`, including free Vector access,
session branch switching and removal of Code Archaeology. Another session pushed
those four commits and deployed them at 22:13 UTC. This task has not pushed main.
Main's release number is retained to avoid competing unpublished release lines.
The Cloud, free-selection and Windows repairs remain on `cloud-completion`.

At the preceding candidate `a113da23e`, Linux unit tests, generated-client checks,
HTTP API exercises, both Linux and Windows browser jobs, standalone installers,
Verify, free-model integration and public-sharing integration passed. Windows
unit validation exposed one nested PowerShell fixture failure and two deferred
uninstall failures. The worker never wrote its first status record, although the
parent identity command succeeded. Commit `81d6e89d8` encodes the nested fixture
command; `6b5a70ec3` starts the worker in an independent minimized console and
encodes path data, including Unicode and PowerShell quote characters. Local
ownership checks passed five cases with two native-only skips; Engine types and
independent review passed. The focused native Windows job at `0e8e9e127` passed all three Core
PowerShell cases (11 assertions) and all eight Engine identity/ownership cases
(52 assertions). The real Windows installer job also passed. Both browser jobs
passed, and the complete Linux job passed its unit tests, generated-client check
and HTTP gates. The full Windows unit step reached its existing 20-minute limit;
its detailed log is being investigated. These focused passes do not replace the
incomplete full Windows suite. No test deadlines were increased.

The complete Windows log reports one Core fixture failure: the outer PowerShell
call returned success without a native child exit code or child output. Core
finished with 1,554 passes, 13 skips and one failure. Engine showed no assertion
failures before the job cutoff, but its quiet output does not identify the
unfinished test. The next run explicitly waits for the nested Bun process and
splits Engine across two native Bun file shards, with full output and unchanged
per-test and job-step deadlines. Those changes still require native acceptance.

Vector Cloud registration is limited to Vercel and Supabase. Netlify registration
was canceled at the owner's request. The prepared Vercel agreement requires owner
submission; the prepared Supabase OAuth registration awaits action-time approval.
No new OAuth credential has been retrieved or saved, and no live customer consent
flow has been verified. Personal OpenRouter access still needs the documented
unfunded-account acceptance; no real inference request or purchase was made.

## Earlier candidate checkpoint

Cloud connection and project environment repairs are pushed on `cloud-completion`
at `bd69ea0f3`; all 22 package typechecks passed before that push. Platform repairs
are committed at `dc2fb8ce0` and await native CI. The main-branch hold remains in
effect. Neither checkpoint establishes a published or fully verified release.

The platform change fixes the notice generator's classification of physical
dependencies inside workspace `node_modules` directories, validates installed
package identities against the lock, and retains the committed notices unchanged.
It also repairs Windows packaging and approval fixtures and adds native
PowerShell/deferred-uninstall diagnostics. Local validation passed:

- Notice and generated-artifact checks: 32 tests, 99 assertions, including exact
  committed notice bytes and existing platform/bundled-license security checks.
- OAuth approval checks: eight tests, 75 assertions.
- Packaging checks: 16 tests, 119 assertions.
- Core and Engine typechecks, plus one focused onboarding browser case with its
  existing deadline and assertions unchanged.

The free-selection repair is committed at `6bf619953`. Switching agents now
preserves the active free model and variant, including automatic TUI plan
transitions and unavailable saved free selections. An explicit paid model choice
remains available. The actual TUI context checks passed five tests with nine
assertions, Schema passed three tests with 23 assertions, and all four free-model
browser cases passed in 1.3 minutes. App, TUI, Schema and browser-test typechecks
passed. Earlier cold-start browser attempts stalled at `page.goto`; no test
deadline was increased to obtain the final pass. These checks made no live model
requests. The eligible catalogue remains the canonical, tool-capable, zero-price
ZDR `:free` subset; this change does not widen that eligibility policy.

The completed native results at `e83f34b2b` passed standalone Windows installation,
typechecks, Verify, free-model integration, and Linux unit and browser validation.
The [standalone installer job](https://github.com/scr1pter/Vectordev.ai/actions/runs/37064154072/job/111027689940)
passed the real PowerShell installer, including the unchanged 290–325 second
stalled-body acceptance window and executable-preservation checks. The
[test workflow](https://github.com/scr1pter/Vectordev.ai/actions/runs/37064154111)
still failed Windows unit and browser validation. Those failures remain the
native baseline until the repaired source passes its own Windows jobs. New
PowerShell and deferred-uninstall diagnostics provide evidence for that run;
their local checks do not prove native acceptance.

## Source parity

The original comparison used `12c3ffd78fdd03219310f88573a188d3b2a32b77`, which
contains the complete `free-models`, `independence-rebuild`, and `release-ready`
histories. Another session subsequently advanced `main` to
`62a83b7258a688d470d110d24287019885305dd3`. Its model-mirror and GPT-6 changes are
included in `free-only-safety`, preserving both histories; this task
has pushed only the candidate branch since the owner imposed the main hold.
The subsequent documentation-only changes through
`7372c5b1c19add723be6b7ffa23e7a3abaed08ac` and main through `9b6f2a45d` are included
as well. The candidate retains the complete main history, not just selected
patches. Main's intentional licensing and Code Archaeology removals are preserved,
including its revised historical release copy. Recheck the final release
commit after further changes. The separate shared working checkout contains
other work and is not the release workspace.

## Remaining release inputs

- Publish and verify the prepared catalog from the owner-approved public
  `scr1pter/vector-model-catalog` fork at
  `690fd27d61c7a8acc5fd93aeda4f128d67d149fd`. Its committed export and artwork pass
  the existing gates; canonical SHA-256 is
  `a96b465110dd2fcc38e0dcca1a4115e12ea43ddaafdb0ebf587e15026767bf14`.
  Follow [model catalog preparation](model-catalog.md). The new catalog-only CLI
  workflow phase uses the existing protected Blob secret without retrieving its
  value or changing the shared mirror.
- Authenticate npm on the publishing machine. `npm whoami` returned `E401` at this
  checkpoint. Run `npm login` yourself; never paste a token or password into source,
  a task, or logs.
- Provide publication credentials through the existing protected release
  environment. Do not copy credential stores or print secret values. A local
  unsigned Mac build does not require npm authentication, but still needs the
  reviewed catalog and must pass the same artifact audit.
- Verify the exact release source in CI before publication. Local passing suites
  do not replace the macOS, Windows, and Linux release jobs.

Immutable catalog publication and npm authentication remain incomplete. No 1.99.99 installers, npm packages,
or standalone archives are claimed as published. Public desktop downloads remain
at 1.99.8 and npm CLI at 1.99.7, rechecked at 20:35 UTC. Another task replaced
the local Mac app during validation; it now reports 1.99.99 (the earlier local
1.999.99 checkpoint is historical). Its bundled build
metadata records the version and channel without a source commit, so that local
installation does not establish this candidate's provenance or publication.

## Earlier validation checkpoints

At source `7d8cf97318bba7a7acb78bff5f75b7185ca83cba`, all four native typecheck
jobs, the website build and the free-model integration job passed. Linux browser
validation passed; Linux unit tests, generated-client verification and all HTTP
API gate steps also passed. Windows browser validation failed and needs its
detailed authenticated log before the remaining failure can be diagnosed.
Windows unit validation also completed with failure at 20:40 UTC; its detailed
log remains unavailable at this checkpoint. These results do not establish a
passing Windows release candidate.

The same source's standalone Windows harness passed initial installation, beta
channel handling, and rejection of bad checksums and redirects without replacing
the old executable. It then failed while preparing a deferred update. The actual
installer passed ordinary PowerShell `$null` to `File.Replace`, which binds as an
empty string instead of the API's optional null backup path. Commit `7557bdf3e`
uses `NullString.Value` for both atomic status updates and rollback. Exact old
and new calls were exercised with portable Microsoft PowerShell 7.4.15 on Mac:
both old calls failed with an empty-path error and both corrected calls passed.
This confirms the binder defect, not native Windows PowerShell 5 acceptance.

The native harness now checks the real status writer directly before its HTTPS
scenarios. Bounded diagnostics retain the 60-second status deadline and report
early worker exits. Temporary holders and workers are disposed even when setup
fails, with a two-second termination-join limit. Five diagnostic checks passed,
including a real 60,040 ms timeout; three cleanup checks passed. Engine typecheck
and independent review passed. The native installer workflow also runs when its
shared Core PowerShell environment helper changes. TLS, process identity,
acknowledgement, checksum, rollback and exact certificate-cleanup checks remain
enforced. The repaired source still requires a successful native installer run.

A separate review of Microsoft's .NET Framework reference source established
that the HTTP body's inherited `ReadAsync` checks cancellation before starting
but does not monitor it during a blocked read. `ResponseHeadersRead` also ends
the client's timeout coverage at the headers. The downloader now waits on each
read with `Task.Wait(cancellationToken)` before retrieving its result, so its
existing stream/response cleanup can execute when the five-minute deadline
expires. This is a source-established defect; the long-running native job's
current phase was not visible and is not inferred from its elapsed time.

The native harness now publishes fixed phase notices and incremental evidence,
and aborts its stalled-body worker after a 330-second diagnostic watchdog. Its
actual acceptance window remains 290–325 seconds, with exact preservation of
the old executable required. Engine typecheck, formatting, independent review
and two real-child watchdog/evidence checks passed. Final native Windows
PowerShell acceptance is still required before deploying this installer change.

At source `013ebfeb0c081e024b3f2718461dc2b5d3ab28d2`, native typechecks,
the website build and the free-model integration job passed. The Windows Core
catalog wait now completes (38.26 ms), including its fresh-process deadline
regression (641.74 ms). The completed Windows Core suite reported 1,532 passes,
13 skips and 20 failures: one SDK file-URL resolution fixture, four searches
interrupted during first-use Ripgrep installation, two POSIX permission
assumptions, and 13 CRLF-converted review golden files. Turbo stopped Engine
after Core failed, so this run does not verify Engine notice or uninstall fixes.
Linux browser validation reported 94 passes, eight passing retries, one skip
and one persistent loading timeout; its viewer command was not reached.

Subsequent repairs prepare the real Ripgrep binary in a bounded setup hook while
retaining five-second search assertions, share native PowerShell module handling
from Core, resolve the SDK fixture with a native parent path, and keep review
golden bytes at LF. OAuth fixtures retain POSIX privacy checks where supported
and exercise malformed-schema and approval-identity rejection on every OS.
All 13 golden files remain byte-identical in a real autocrlf checkout. Focused
approval/review checks passed 48 cases; SDK/search checks passed eight. A real
empty-cache Mac download, extraction and execution of Ripgrep also passed.
The complete local Core suite after these changes passed 1,565 tests with one
Windows-only skip, zero failures and 5,947 assertions. Engine installation
checks passed 14 cases with two Windows-only skips; Core and Engine types passed.

The Windows browser trace showed hundreds of module requests passing through
test-worker routing, including 819 continue calls and individual replies taking
over 11 seconds. API mocks now use serializable matchers, retain exact backend
responses, and leave document/module handling to the real server. Three routing
regressions passed. An affected subset passed 13 cases with one skip at two
workers; five workers still produced one timeout. Other local build activity
limits that timing comparison. Both hosted platforms now use one browser worker,
following [Playwright's CI guidance](https://playwright.dev/docs/ci#workers), with
all test deadlines and assertions preserved. Independent unit tasks continue
after a peer fails so the job can report more failures without becoming green.

The native standalone harness at `013ebfeb0` passed the missing-module boundary
but then failed on an interactive CurrentUser certificate trust prompt. Its
replacement is restricted to disposable GitHub-hosted Windows runners, checks
administrator access, and imports the generated fixture into LocalMachine Root.
Cleanup is registered before import, targets only the exact generated thumbprint,
and verifies removal. TLS, ownership, hash and rollback checks remain enforced;
native acceptance is still required. npm authentication still returned `E401`
when rechecked at 20:04 UTC. No new installers or packages are published.

The [candidate PR](https://github.com/scr1pter/Vectordev.ai/pull/5) is a draft.
At source `948649315e75e060c2e47a3aefecd141fc10c640`, the
[native test run](https://github.com/scr1pter/Vectordev.ai/actions/runs/37054778865)
completed Linux successfully: Engine 3,752 passes, 35 skips, one todo and no
failures; Core 1,556 passes, six skips and no failures; app 1,265 unit cases plus
32 browser-condition cases passed. All nine Turbo tasks passed. Generated-client
verification passed, and HTTP coverage, authentication and actual request modes
each completed with 230 passes and no failures, skips, missing or extra scenarios.
Linux browser checks passed with 98 initial passes, five passing retries, one
existing skip, and all four public-viewer cases passing. All four native typecheck
jobs and the website build passed at this source.

Windows was still incomplete when these results were recorded. Its unit log
showed 25 failures: 13 packaging cases assumed a package-local dependency path
despite Windows using the hoisted linker, nine POSIX installer fixtures required
`shasum` although Git Bash supplies `sha256sum`, one generated-notice byte mismatch,
and two deferred-uninstall cases stopped before scheduling. The Core log stopped
at the bounded free-catalog wait, and browser navigation still timed out without
the earlier ONNX optimizer error. These partial logs are not final suite totals.

Subsequent repairs preserve Windows PowerShell's native module discovery when
launched through Bun and use the available Git Bash checksum command. The
free-catalog deadline stays referenced until settlement and clears immediately
after an early result. Fresh-process regressions and the full local Core suite
passed after this change: 1,563 passes, no failures and 5,933 assertions. Native
confirmation is still required. Deferred-uninstall fixtures now use the same
PowerShell environment boundary and report their disposable status files when
the child exits early. Certificate trust, hash checks, ownership checks, exact
notice bytes and existing test deadlines remain enforced.

The repository is public at this checkpoint. The previous account-level Actions
block is no longer the observed state: source `12c3ffd78` passed
[Verify](https://github.com/scr1pter/Vectordev.ai/actions/runs/37042607157),
[typecheck](https://github.com/scr1pter/Vectordev.ai/actions/runs/37042607079), and
[production schema checks](https://github.com/scr1pter/Vectordev.ai/actions/runs/37042860451).
The [test workflow](https://github.com/scr1pter/Vectordev.ai/actions/runs/37042607500)
failed in Linux installer fixtures that omitted `gzip` from their restricted PATH
and a Windows app assertion that waited a fixed 10 ms. Both test-only repairs
passed focused local checks; native CI confirmation on the new branch is still
required. No payment, spending-limit change, or credit purchase is required or
authorized by this preparation.

The browser run also exposed stale fixtures: timeline and presence event streams
were mixed together, terminal routes omitted directory query parameters, and
several selectors described earlier UI behavior. These fixtures now exercise the
current contracts. The four public-viewer security cases run against the built,
pruned website in a separate Playwright configuration, included by
`bun run test:e2e:local`. A real duplicate syntax-theme registration found by the
console-error smoke check was removed. Focused browser checks pass; the complete
local rerun now passes **103 app cases and four public-viewer cases**, with one
existing skip. Both event fixtures keep global envelopes and directory presence
payloads in separate queues; their regression checks also pass repeated parallel
runs. Native CI remains required before application publication.

The native run on `47984948d` confirmed the Linux installer and Windows app fixes
(Windows app: 1,264 passing unit cases). Linux engine tests found one remaining
cold-start cancellation failure; Windows unit tests reached the existing
20-minute timeout without a diagnostic identifying the unfinished package.
Streamed unit logs now preserve that diagnostic information for subsequent runs.
The Linux browser failure was the event-queue issue fixed after that source.
These native results are not an all-green release check.

The cold-start cache fix in `85053bbfe` protects successful cache publication as
well as loading. Core passed 1,561 tests, and the affected engine configuration,
instance-state and review groups passed 136 tests. The original review case
passed 50 repetitions and each deterministic cancellation regression passed 20.
All 22 package typechecks passed. Concurrent callers waiting on the first cache
load now defer cancellation until that load publishes; existing catalog lock
and HTTP limits remain unchanged. Model execution itself stays interruptible.
After integration at `c901d471f`, Core again passed 1,561 tests. The focused
provider, authentication and compliance groups passed 544 tests, Schema passed
27, and the native typecheck workflow passed all four jobs. The complete local
Engine run remains **failed**: 3,752 passed, 21 skipped, one todo and seven CLI
subprocess timeouts. The unchanged isolated CLI group passed all 14 cases;
the full-run timeout cause is not established, so the isolated pass does not
replace that failed result.

Native Linux browser validation on `c901d471f` succeeded with 98 app cases passing
initially, five passing on retry, one existing skip and all four public-viewer
cases passing. Its Vite logs exposed incorrect optimization of the local ONNX
asset URLs. The repair at `3c3c32652` excludes only those asset imports from
dependency optimization and retains local speech assets in the production build.
A real empty-cache regression failed before the fix and passed after it. The
full app unit suite passed 1,265 cases, ten cold-cache browser cases passed, and
the subsequent complete local browser run passed 103 app cases plus all four
public-viewer cases with no retries and one existing skip.

Windows CI also exposed test assumptions about LF line endings, file URL paths
and POSIX subprocess signals. The repaired fixtures retain exact output,
credential-preservation and cancellation-cleanup checks. Actual OS signal cases
remain on POSIX; portable asynchronous handler cases cover every platform.
Forty-one focused CLI cases passed locally. Native verification of the final
candidate remains required; no timeout increases or release-gate bypasses were
used to obtain these results.

The completed native Linux unit step on `c901d471f` passed Engine with 3,747
passes, 33 skips, one todo and zero failures, and Core with 1,556 passes, six
skips and zero failures. Generated-client verification also passed. The job then
stopped at the HTTP coverage inventory: 21 public routes had no registered
scenario. That inventory did not execute HTTP requests. New scenarios now cover
those routes, including local file and Git changes, disabled LSP behavior,
passive transcript import, private share previews, rejected continuation,
credential presence, MCP removal, and usage from a local synthetic model.
Authentication probes also use the isolated test directory, preventing valid
probes from writing configuration into the checkout.
The completed local gate now passes all three modes: 230 coverage registrations,
230 authentication probes and 230 actual request scenarios, covering all 209
public routes with zero failures, skips, missing routes or extra routes. Existing
file-read and legacy-sharing fixtures were corrected to require exact newline
preservation and explicit consent rejection while sharing is disabled.

The same source's Windows unit step reached its existing 20-minute timeout with
34 observed Engine failures and no final Engine or Core totals. Further repairs
keep audited license/provenance bytes at LF, avoid relocated dependency links,
use Git Bash paths in real installer tests, preserve Git review fixture bytes,
and exercise Windows permission and deferred-uninstall contracts. No license
hash or notice exception was relaxed. A simulated Windows checkout preserved all
205 audited files byte for byte; the shell, audit and review groups passed 47
tests, and the review groups also passed all 33 cases with autocrlf enabled.
Permission and ownership groups passed 18 cases locally; two new native Windows
uninstall cases remain unexecuted on this Mac.

The SDK resolver repair at `b007feffa` converts file URL parents to native paths
before Bun resolution, preserving an installed plugin SDK's authority on Windows
and in paths containing spaces or escaped characters. Two regressions failed
before the repair. SDK/dependency checks passed 17 tests and packaging checks
passed 14. Full Core verification after the repair passed 1,561 tests with zero
failures. Final native Windows execution is still required.

The `c901d471f` Windows browser step also reached its existing 30-minute timeout,
with 21 numbered failures observed and no final totals; the viewer command was
not reached. Its load timeouts followed the ONNX optimizer errors repaired in
`3c3c32652`. That earlier run does not validate the repaired Vite configuration.

## Publication order and unsigned policy

1. Prepare the immutable catalog and record its digest and fork provenance. Build
   and audit all artifacts from the reviewed source and these same catalog bytes.
2. Publish the matching plugin, CLI, and all six npm platform packages, then the
   standalone CLI archives required by desktop and WSL. See the
   [plugin](npm-plugin.md) and [standalone CLI](standalone-cli-release.md) procedures.
3. Dispatch the desktop workflow from the exact candidate ref with tag
   `v1.99.99`, `allow_unsigned=true`, and the stable channel. A plain tag push uses
   the signed path and does not select the approved unsigned policy.
4. Verify all six installers, checksums, sizes, CLI provenance, and the public
   download manifest before advancing `publishedDesktopVersion` or describing the
   release as available. Update the public notes and the more detailed system
   design notes to match the actual published result.
5. Keep a recoverable copy of the existing local Mac app, install the verified
   candidate, and launch it. The owner handles any operating-system password or
   keychain prompt; the agent must not enter those credentials.

Unsigned releases update manual downloads, not the signed automatic-update feed.
Preserve the existing signed feed and the workflow's complete-platform gate. Do
not advertise a partial upload as the latest release.

## Free-model scope

Personal access uses each user's own free OpenRouter account. Keep the shared
service off; do not buy credits, enable automatic top-ups, attach paid upstream
BYOK keys, or enable default or enforced paid plugins. The guarded route stops
when eligible zero-price endpoints or the account allowance are unavailable.
See [free-model setup](openrouter.md) for account requirements and the owner-run
acceptance checks. No live account billing acceptance is claimed from fixture or
local mock tests. Other hosted services and disabled OAuth registrations remain
subject to their existing owner setup requirements.
