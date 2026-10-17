# Subagent orchestration release 1.99.108

The desktop version, lockfile, unsigned-release policy and release notes are prepared for 1.99.108, with required CLI 1.99.108 for matching WSL behavior. `publishedDesktopVersion` remains 1.99.106 until installers are actually published. This work does not dispatch a release, approve production, publish npm packages or run paid models.

## Owner release steps

1. Publish and verify CLI **1.99.108** from the reviewed `main` commit first, using [standalone CLI release](standalone-cli-release.md). Pin the full source revision, reviewed catalog digest and publication timestamp; use `containers=skip` for this handoff. Publish the reviewed immutable catalog, then prepare, stage and commit all twelve standalone targets. Also publish `@vectordevai/plugin`, `@vectordevai/cli` and all six npm platform packages at 1.99.108 using the same source and catalog; complete npm 2FA yourself. Do not reuse or relabel existing 1.99.107 artifacts.
2. After those CLI prerequisites pass, dispatch **Vector desktop release** from the reviewed `main` commit with tag `v1.99.108`, `allow_unsigned=true` and `prerelease=false`, then approve the `production-release` environment. The desktop now pins required CLI **1.99.108**, so WSL receives the matching task controls. The workflow checks npm packages and verifies the exact standalone Linux archives before publication. Follow the artifact, updater and install checks in [release approval](release-approval.md) before changing the published version. Separately installed terminal CLIs still need their own upgrade.
3. Run the matched live delegate checks from [the live efficiency guide](../../../script/agent-eval/live-efficiency.md), keeping provider invoices, cache usage, outputs and verification. The offline results below cannot establish live pricing, response time or quality parity.

## Review evidence

- [Design and migration boundaries](../design/subagents-v2.md).
- [Before/after offline benchmarks and raw artifacts](../../benchmarks/vector-subagents-2026-10/README.md).
- [Package checks, independent review and build evidence](../../benchmarks/vector-subagents-2026-10/validation.md). The completion report records the final source revision. Local validation logs are retained under `/tmp/vector-subagents-validation` for this run.

The app's current parent conversation exposes `task` and `task_manage`. Its bridge reaches desktop workers through their own execution APIs. Pure SDK-next V2 parent sessions do not automatically receive the engine task tools. External runtime capabilities remain explicit: unknown usage is unknown, and an outside runner without message support does not offer a working Talk control.
