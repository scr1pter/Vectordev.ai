# OpenTUI: retain the pin or approve a Vector-owned fork

The documentation theme is now vendored locally under `packages/web/src/theme`, with its complete MIT license and source integrity recorded there. Its npm dependency is removed. This does not replace Starlight itself. Vector's terminal still uses the pinned MIT OpenTUI packages; this document is a decision and implementation estimate only. No fork, repository, npm package, native toolchain, or publishing account has been created for this option.

## Current boundary

The lockfile pins `@opentui/core`, `@opentui/keymap`, and `@opentui/solid` to **0.3.4**, with package integrity. The core package includes eight optional native targets: macOS x64/arm64, Linux x64/arm64 with glibc and musl, and Windows x64/arm64. The version's publisher commit is `9b216a58d974704ae638b3043aece2eb70b5ff19`. These libraries are part of local rendering; keeping them does not require sending Vector sessions to the library publisher. It does retain dependence on that publisher for future package releases. [Pinned package manifest](https://github.com/anomalyco/opentui/blob/9b216a58d974704ae638b3043aece2eb70b5ff19/packages/core/package.json)

The native renderer is Zig with TypeScript bindings. The pinned upstream workflow uses Zig **0.15.2**, cross-builds native libraries on macOS, then runs native and JavaScript tests on macOS arm64, Linux x64, and Windows x64. That existing test matrix is narrower than the full published target set, so Vector should add native or emulated acceptance for the remaining shipped targets rather than treating cross-compilation as execution evidence. [Pinned build workflow](https://github.com/anomalyco/opentui/blob/9b216a58d974704ae638b3043aece2eb70b5ff19/.github/workflows/build-core.yml), [project description](https://github.com/anomalyco/opentui/tree/9b216a58d974704ae638b3043aece2eb70b5ff19)

## Choices

1. **Keep the current exact pins.** Lowest immediate cost. Continue reviewing source, license changes, advisories, native package integrity, and terminal regressions before updates. Vector controls whether to accept an update.
2. **Own the maintenance fork.** Create the repository under the actual Vector-owned GitHub organization and publish under the actual owned npm scope. Proposed package names are `@vectordevai/opentui-core`, `@vectordevai/opentui-keymap`, `@vectordevai/opentui-solid`, plus corresponding native packages such as `@vectordevai/opentui-core-darwin-arm64`. These names are proposals, not verified registrations or published artifacts. Preserve upstream MIT notices and track source provenance.

A renamed npm alias would still obtain binaries from the existing publisher and would not accomplish the fork option. The complete native build and release chain must become Vector-owned.

## Work required after explicit owner approval

- Start from the reviewed pinned commit in an owner-created repository. Map package names, exports, peers, optional native dependencies, platform loader paths, build scripts, worker assets, test helpers, and downstream imports consistently. Keep ABI and public APIs unchanged for the first release.
- Own reproducible Zig/Bun toolchain inputs, package hashes, source maps, all eight native packages, and publishing automation. Use Vector's allowed CI actions; review/pin the Zig download and checksum directly rather than inheriting an additional setup action without review. Preserve native and vendored subcomponent notices.
- Update Vector's workspace/catalog pins, TUI/plugin imports, bundler externals, native copy rules, startup/package detection, and downstream adapter peers together. Review `opentui-spinner` and any plugin-facing OpenTUI type identities for compatibility with the fork. Do not simultaneously upgrade APIs.
- Run upstream native/TypeScript tests and Vector's terminal interaction suite on all supported environments: resize while streaming, keyboard shortcuts, Unicode width, scrolling, selection, copy/paste, mouse, alternate-screen cleanup, crash recovery, and shutdown. Compare startup, rendering latency, memory, and CPU against the existing release. Verify macOS/Windows desktop bundles and every standalone CLI target include the correct native bytes.
- Publish only after the owner approves the first scope/repository/package release. Record checksums and provenance, then switch exact dependency pins. Keep a rollback to the existing tested package versions.

## Planning estimate

This is an engineering estimate, not a vendor quote. For one engineer already comfortable with Bun, Zig, and native CI, budget **10–20 engineering days** for a compatible first fork: 1–2 days inventory/provenance, 3–5 days rename/build/publish automation, 4–8 days platform and Vector regression work, and 2–5 days release hardening. Some activities overlap; unavailable Windows ARM or musl test environments can extend calendar time. Budget **1–3 days per upstream update** for routine merges/validation, with extra time for Zig, FFI, ABI, terminal protocol, or security changes. Owning a fork does not eliminate upstream maintenance work.

The owner must choose keep-or-fork, provide the real organization/scope, approve the maintenance budget, and authorize the first publication. Until then, keep the existing exact dependencies. No service registration or partner contact is needed to assess the option.
