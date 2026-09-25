# Vector release workflow

Vector's canonical source repository is `scr1pter/Vectordev.ai`. The `main`
branch is connected to the production `vectordev-ai` project on Vercel.

## Publish source and website changes

1. Review the working tree and make sure local secrets, generated installers,
   and build output are not staged.
2. Run the relevant tests and the production web build.
3. Commit the reviewed source changes locally.
4. Push `main` to GitHub.
5. GitHub Actions verifies the web build, while Vercel automatically builds
   and deploys the same commit.
6. Confirm both checks succeeded before treating the release as complete.

Desktop installers use the separate release workflow in
`.github/workflows/vector-desktop-release.yml`; ordinary website pushes do not
rebuild every desktop installer.

## Publish matching release artifacts

Choose and approve one release version before preparing artifacts. Set that version in
`packages/desktop/package.json` and pass the same `VECTOR_CLI_VERSION` to the CLI
publisher. Plugin staging derives its public version from the desktop version; the
CLI publisher explicitly passes its selected version as `VECTOR_PLUGIN_VERSION` to
both compilation and plugin staging. Internal workspace manifest versions do not
set the public plugin artifact version.

1. Build and verify the plugin package and its clean-consumer checks.
2. Publish `@vectordevai/plugin`, then all CLI platform packages, then the
   `@vectordevai/cli` umbrella at that exact version. The CLI publisher performs
   this order and stops on plugin failure. Run it from an interactive terminal so
   npm can request two-factor authentication. A retry keeps the same version and
   skips packages already published.
3. Verify the packages can be installed from the registry. Only then create the
   matching desktop release tag and run the desktop workflow. Its prepare job
   refuses to build installers if any matching CLI or plugin package is absent.
4. Confirm all platform installers, manifests and update channels before marking
   the release available. Unsigned downloads must not advance signed update feeds.

The prototype workspace `@vectordevai/cli-dev` and its platform outputs are private;
they are never npm release artifacts.
