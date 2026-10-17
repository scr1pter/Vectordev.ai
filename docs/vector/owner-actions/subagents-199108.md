# Subagent orchestration release 1.99.108

The desktop version, lockfile, unsigned-release policy and release notes are prepared for 1.99.108. `publishedDesktopVersion` remains 1.99.106 until installers are actually published. This work does not dispatch a release, approve production, publish npm packages or run paid models.

## Owner release steps

1. Use the reviewed `main` commit recorded in the completion report. Dispatch **Vector desktop release** with tag `v1.99.108`, `allow_unsigned=true` and `prerelease=false`, then approve the `production-release` environment. Follow the artifact, updater and install checks in [release approval](release-approval.md) before changing the published version.
2. Publish the matching standalone CLI separately using [standalone CLI release](standalone-cli-release.md). Pin its source revision and reviewed catalog digest, and complete all twelve platform targets. Do not reuse the existing 1.99.107 CLI artifacts. Complete any npm 2FA yourself. Until this is published, older installed CLI and WSL engines do not gain `vector tasks`, `/tasks`, or the new background-run behavior from the desktop release.
3. Run the matched live delegate checks from [the live efficiency guide](../../../script/agent-eval/live-efficiency.md), keeping provider invoices, cache usage, outputs and verification. The offline results below cannot establish live pricing, response time or quality parity.

## Review evidence

- [Design and migration boundaries](../design/subagents-v2.md).
- [Before/after offline benchmarks and raw artifacts](../../benchmarks/vector-subagents-2026-10/README.md).
- The completion report records package suites, typechecks, browser regressions, build and final source revision. Local validation logs are retained under `/tmp/vector-subagents-validation` for this run.

The app's current parent conversation exposes `task` and `task_manage`. Its bridge reaches desktop workers through their own execution APIs. Pure SDK-next V2 parent sessions do not automatically receive the engine task tools. External runtime capabilities remain explicit: unknown usage is unknown, and an outside runner without message support does not offer a working Talk control.
