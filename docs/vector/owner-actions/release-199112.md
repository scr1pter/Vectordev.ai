# Desktop 1.99.112: preparation and publication checklist

Prepared on 28 October 2026 from `main` at `b3669a6b`. The owner authorized this
desktop release in the handoff. This record does not assert publication.

## Source and changes

The preparation bumps only the desktop version to 1.99.112, adds that version to
the unsigned release allowlist, and supplies the shared website/desktop changelog
entry. The required CLI remains 1.99.99. `publishedDesktopVersion` stays at
1.99.111 until the new downloads and update feeds have been verified.

The candidate contains the approved release-112 merge: agent terminal/browser
controls, Deep research cleanup when memory is erased, explicit research keep
requests, Vector Local error reporting and retry, one Keychain read per macOS
launch, first-launch documentation, website account/privacy fixes, and test
reliability fixes. No Codium billing, new multi-agent phase, Hands or cloud GitHub
session implementation is included.

## Evidence checked

- `main` contains merge `b3669a6b` and the approved legal commit `4e7ce1ef`.
- General test runs [40768433585](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40768433585)
  and [40769076055](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40769076055)
  were still running when preparation started. Do not dispatch a duplicate merely
  because these notes previously asked to start CI.
- The 1.99.111 release workflow [40236084221](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40236084221)
  passed, including staging, account-gate checks, pointer publication and production
  download verification. Its GitHub release being a draft does not establish the
  status of Vector's separate downloads and updater storage.
- `production-release` still requires the owner's GitHub review. Its required
  review must be completed in GitHub; do not remove or bypass the protection.
- The current credential cannot list Actions variables (HTTP 403), so this session
  has not independently established the configured catalog fork revision.

## Before dispatch

1. Run the focused release metadata, changelog and web-copy checks. Run the
   pre-push typecheck without bypassing the hook. Push the reviewed preparation
   branch; keep its exact SHA in the release evidence.
2. Require green full general CI for the integrated source, including Linux and
   Windows engine shards. General CI does not include all desktop release tests;
   those also run in the release workflow under Node 24.
3. Land this preparation from a clean main checkout only, with no unrelated work
   or force push. Recheck the actual main SHA immediately before dispatch.
4. Confirm the reviewed catalog fork revision and that its prepared bytes equal
   `packages/web/public/models/api.json`. A mismatching mirror must be corrected
   through the reviewed fork process, never by weakening the release check.
5. Dispatch **Vector desktop release** (`vector-desktop-release.yml`) from `main`
   at that exact commit, with `tag=v1.99.112`, `allow_unsigned=true` and
   `prerelease=false`. Do not push a tag to publish. The owner approves the
   `production-release` environment in GitHub.

Do not change account settings, buy signing credentials, publish npm packages or
ship a later desktop version as part of this authorization.

## Publication verification

Record the workflow URL, attempt, source SHA and immutable catalog digest. Require
all platform builds, native checks, immutable artifact verification, production
account gate and publication checks to pass. If artifacts are named for the run
attempt, rerunning only publish cannot retrieve an earlier attempt's artifacts;
use the documented complete retry path.

Verify all six download targets and the four stable feeds (`latest.yml`,
`latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`) describe 1.99.112.
Only then update `publishedDesktopVersion`, remove this entry's `availability`,
advance the shipped-version copy fixtures, and regenerate the changelog. Preserve
the distinction between desktop publication and the separately published CLI.

## Remaining follow-ups

Restore the reviewed Codium OpenRouter entries through the catalog fork and
re-enable the skipped canonical catalog assertion once the committed mirror
contains them. Keep Deep research labelled Preview until its behavior/fit gates
pass. macOS/Windows installation and owner acceptance still require the relevant
machines; this cloud workspace is not evidence of those checks.
