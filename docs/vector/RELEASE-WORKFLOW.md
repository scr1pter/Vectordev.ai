# Vector release workflow

Vector's canonical source repository is `scr1pter/Vectordev.ai`. The `main`
branch is connected to the production `vectordev-ai` project on Vercel.

## Publish source and website changes

1. Review the working tree and make sure local secrets, generated installers,
   and build output are not staged.
2. Run the relevant tests and the production web build.
3. Commit the reviewed source changes locally.
4. Obtain the owner's approval of the reviewed commit, then merge and push `main` to GitHub.
5. GitHub Actions verifies the web build, while Vercel automatically builds
   and deploys the same commit.
6. Confirm both checks succeeded before treating the release as complete.

Desktop installers use the separate release workflow in
`.github/workflows/vector-desktop-release.yml`; ordinary website pushes do not
rebuild every desktop installer.

## Publish matching release artifacts

Choose and approve the desktop and CLI release versions before preparing artifacts.
Set the desktop version in `packages/desktop/package.json` and record the exact
compatible standalone CLI version in its `vectorRequiredCliVersion`. Pass the CLI
version as `VECTOR_CLI_VERSION` to the CLI publisher. These versions may differ;
the desktop release verifies the recorded CLI manifest and all six Linux targets.
Plugin staging derives its default public version from the desktop version; the
CLI publisher explicitly passes its selected version as `VECTOR_PLUGIN_VERSION` to
both compilation and plugin staging. Internal workspace manifest versions do not
set the public plugin artifact version.

1. Obtain the first-publication approval, build and verify the plugin package and
   its clean-consumer checks. Review public package licensing before publication.
2. Publish `@vectordevai/plugin`, then all CLI platform packages, then the
   `@vectordevai/cli` umbrella at that exact version. The CLI publisher performs
   this order and stops on plugin failure. Run it from an interactive terminal so
   npm can request two-factor authentication. A retry keeps the same version and
   skips packages already published.
3. Publish the reviewed catalog and standalone CLI archives with
   `.github/workflows/vector-cli-release.yml`. Prepare, immutable staging and
   channel activation are separate phases; reuse the reviewed version, commit,
   catalog digest and timestamp on retries. Verify every archive before activating
   its channel. See [standalone CLI releases](owner-actions/standalone-cli-release.md).
4. Verify packages can be installed from the registry and the required standalone
   CLI release is complete. Only then create the desktop release tag and run the
   desktop workflow. Its prepare job rejects absent or mismatched dependencies.
5. Confirm all platform installers, manifests and update channels before marking
   the release available. Unsigned releases also advance the update feeds (owner decision,
   2 October 2026, confirmed again for 1.99.99), so installed copies are offered them through
   Check for Updates; the app verifies publisher signatures only for signed builds.

Container preparation uses the same verified musl archives and commit. Publishing
additionally requires the owner-controlled namespace and explicit enablement; see
[container registry](owner-actions/container-registry.md). The first public SDK
release has its own approval and clean-consumer check; see
[SDK publication](owner-actions/npm-sdk.md).

Update public release notes only with capabilities actually available in that
deployment. Keep candidate notes explicitly unversioned and unreleased until a
version is approved and its full matrix is verified. A website deployment alone
does not activate disabled account services or publish desktop/CLI artifacts.

After publication, install the verified macOS artifact over the previous app,
launch it, confirm its version and update channel, and check that existing local
sessions and settings remain available. Do not replace the user's app with a
development binary or claim Windows/Linux runtime validation from a Mac build.

The prototype workspace `@vectordevai/cli-dev` and its platform outputs are private;
they are never npm release artifacts.
