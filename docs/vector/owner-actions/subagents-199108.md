# Subagent orchestration release 1.99.108

The desktop version, lockfile, unsigned-release policy and release notes are prepared for 1.99.108. The desktop ships first and keeps required CLI 1.99.99, which is already published on npm and as standalone archives, so the desktop workflow's CLI checks pass without a new CLI release. This work did not dispatch a release, approve production, publish npm packages or run paid models.

**Status, 17 October 2026:** desktop 1.99.108 is published (release run #88), all four update feeds report 1.99.108, and `publishedDesktopVersion` is 1.99.108. Step 1's dispatch and approval are done; CLI 1.99.108 (step 2) and the matched live checks (step 3) are not.

## Owner release steps

1. Dispatch **Vector desktop release** from the reviewed `main` commit with tag `v1.99.108`, `allow_unsigned=true` and `prerelease=false`, then approve the `production-release` environment. Follow the artifact, updater and install checks in [release approval](release-approval.md) before changing the published version.
2. Publish CLI **1.99.108** afterwards as its own release, using [standalone CLI release](standalone-cli-release.md): the immutable catalog, all twelve standalone targets, and `@vectordevai/plugin`, `@vectordevai/cli` and the six npm platform packages from the same source and catalog; complete npm 2FA yourself, and do not reuse or relabel the existing 1.99.107 CLI artifacts. A later desktop release can then raise `vectorRequiredCliVersion` to 1.99.108. Until then, separately installed CLIs and WSL engines keep 1.99.99 and do not gain `vector tasks`, `/tasks` or the new background-run behavior.
3. Run the matched live delegate checks from [the live efficiency guide](../../../script/agent-eval/live-efficiency.md), keeping provider invoices, cache usage, outputs and verification. The offline results below cannot establish live pricing, response time or quality parity.

## Review evidence

- [Design and migration boundaries](../design/subagents-v2.md).
- [Before/after offline benchmarks and raw artifacts](../../benchmarks/vector-subagents-2026-10/README.md).
- [Package checks, independent review and build evidence](../../benchmarks/vector-subagents-2026-10/validation.md). The completion report records the final source revision. Local validation logs are retained under `/tmp/vector-subagents-validation` for this run.

The app's current parent conversation exposes `task` and `task_manage`. Its bridge reaches desktop workers through their own execution APIs. Pure SDK-next V2 parent sessions do not automatically receive the engine task tools. External runtime capabilities remain explicit: unknown usage is unknown, and an outside runner without message support does not offer a working Talk control.
