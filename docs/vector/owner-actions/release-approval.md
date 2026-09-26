# Release approval and external prerequisites

This candidate is prepared on `independence-rebuild`. The original shared checkout
is not the release workspace. Review the final commit, verification report and
unreleased notes before authorizing the main merge and production release.

## Owner decisions

1. Approve the reviewed source commit for merge/push to `main`, which deploys the
   main website to production. The current brief explicitly reserves this approval.
2. Choose the desktop release version and its exact required standalone CLI version.
   No new version was invented by the implementation. Approve the first plugin and
   SDK publishes separately, including public package licensing; see
   [plugin](npm-plugin.md) and [SDK](npm-sdk.md).
3. Resolve [native dependency identifiers](binary-identifiers.md),
   [historical public shares](old-public-shares.md), and the rare
   [ambiguous database variable](upgrade-bridge.md). They are not represented as
   automatically solved. Choose whether to maintain an [OpenTUI fork](opentui.md).
4. Approve the [privacy/terms draft](free-models-legal.md) before enabling the new
   hosted services. Complete each service's account, terms, registration, key and
   database steps in the other owner-action files. Disabled OAuth gates remain off
   until the named Vector registrations and real-account acceptance are confirmed.

## GitHub Actions is blocked before execution

The latest reviewed website run is
[36100653151](https://github.com/scr1pter/Vectordev.ai/actions/runs/36100653151),
at source `4cd516eb25784d59c2d80c4115a124b7d6a64e29`. Its Website build job
`107962212093` has **zero executed steps**. GitHub's annotation says recent account
payments failed or the spending limit needs to increase. Rechecked September 26,
2026. This is an account-level runner block, not a website build failure.

Open the repository owner's GitHub **Settings → Billing & plans**, resolve the
failed payment or authorized Actions spending limit, and then rerun the required
checks on the exact approved candidate. The agent did not change billing, buy
credits or hide these failed checks. Local passing checks do not replace the
cross-platform release jobs.

## Signing and publication

Provide Apple signing/notarization and Windows signing through the release
workflow's protected secrets. Never paste values into source, a task or logs. The
macOS workflow references `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`; inspect the Windows job's current
signing configuration before supplying its certificate. Preserve feed credentials
and immutable artifact checks already enforced by the workflow.

A signed release is required to advance the signed desktop updater feed. An
explicitly approved unsigned download is a separate manual-install path and does
not solve automatic updates. No signing store was read, no credential was copied,
and no installed app was replaced during preparation.

Follow [the release workflow](../RELEASE-WORKFLOW.md) after these decisions. Verify
all target checksums, install/upgrade behavior, website/docs/schema responses,
registry packages and release-feed versions before announcing availability.
