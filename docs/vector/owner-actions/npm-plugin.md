# First publication of the Vector plugin SDK

Status: preparation only. No package has been published by this work. The owner must explicitly approve the first public publication of `@vectordevai/plugin`; choosing a release version or approving a CLI release alone does not substitute for that approval.

The public SDK is built from `packages/plugin`. Its workspace manifest version is not its release version. The plugin and the CLI share one version: publish the plugin before the CLI packages at the CLI's approved version. Staging uses `VECTOR_PLUGIN_VERSION` when supplied (the CLI publisher always passes its CLI version), otherwise `vectorRequiredCliVersion` in `packages/desktop/package.json`.

The desktop app installs the plugin SDK at its `vectorRequiredCliVersion`, not at its own version, and the desktop release requires the plugin at that version. A desktop release whose required CLI is already published, such as desktop 1.99.100 requiring CLI 1.99.99, needs no new plugin publication.

## Owner decisions before publication

- Approve the public package name and selected version, and confirm control of the `@vectordevai` npm scope.
- Approve the SDK license and the bundled `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `DEPENDENCY_NOTICES.md`. The current package says `SEE LICENSE IN LICENSE`; this checklist does not change the licensing decision.
- Complete npm authentication and any two-factor challenge in your own terminal. Do not send credentials to an agent or add an npm token to source.
- Explicitly authorize the first `@vectordevai/plugin` publication after reviewing the staged tarball and validation results.

## Reviewable preparation

From `packages/plugin`, set `VECTOR_PLUGIN_VERSION` to the approved CLI release version, then run:

```sh
bun run stage
bun run test:package -- --skip-build
bun run pack -- --skip-build
```

The stage is `packages/plugin/dist-publish`. Check its manifest, all exported JavaScript/declaration entry points, and the three required notices. The isolated consumer check installs the tarball into a temporary consumer, verifies every export, checks types and runtime imports, and rejects a private SDK dependency or workspace symlink. Its test-only npm configuration does not use the owner's npm login. It downloads public dependencies, so run it when network access is available.

`pack` creates a local tarball; it does not publish. Confirm the staged package has no workspace/catalog dependency ranges, no runtime import of the private SDK, and the exact selected version. Archive the tarball digest and test output with the release evidence. Repeat preparation after changes to public SDK source, declarations, notices, or version.

## After explicit first-publication approval

The owner, or an agent explicitly authorized for this publication, runs from `packages/plugin`:

```sh
bun ./script/publish.ts --publish --skip-build
```

The script verifies the staged identity and required files before publication. If that exact version is already present, it leaves it unchanged. A publication is immutable: do not reuse a version for different content. Verify registry availability and install/import the package from a clean consumer before publishing the matching platform CLI packages and umbrella package. The release publisher already enforces plugin-first ordering; never bypass its failed plugin check.

No publication, account creation, registration, npm login, token read, or licensing change is authorized by this document itself.
