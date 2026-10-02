# Standalone CLI releases and package-manager channels

This implementation prepares Vector's native CLI archives and publication tooling. It has not published a release, created a Homebrew tap or Scoop bucket, registered accounts, or changed Vector's licensing. The owner must create the actual tap and bucket repositories and supply their coordinates before those channels can be published.

## Release identity and files

Every release must contain all twelve targets from `packages/schema/src/cli-release.ts`. The input is the existing Engine build's `dist/vector-<target>/` tree, plus its exact prepared `dist/api.json` catalog. Each package must carry matching `version`, `vectorCatalogSha256`, `vectorSourceRevision`, and `vectorStandalone: true` metadata. Native file headers must match the declared OS and architecture. Build the standalone identity through `packages/engine/script/build.ts`; do not rename an embedded desktop binary or relabel an older artifact.

Archives are deterministic `.tar.gz` files for macOS/Linux and `.zip` files for Windows. Each contains exactly four flat regular entries: `vector` (or `vector.exe`), `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `DEPENDENCY_NOTICES.md`. Notices must be nonempty and identical across the target matrix. Linked source files/directories are rejected. Archive output has no package.json, directories, source paths, timestamps from the build machine, or standalone receipt; installers/managers generate their own authoritative installation metadata.

The immutable manifest lives at `releases/vector-cli/v<VERSION>/manifest.json`. Archives live beside it. Mutable channel pointers are `releases/vector-cli/latest.json` and `releases/vector-cli/beta.json`. Manifest records include version, channel, source revision, catalog digest, fixed publication timestamp, and each archive's canonical Blob URL, path, size, and SHA-256. A stable channel cannot point at a prerelease.

## Manual GitHub workflow

`.github/workflows/vector-cli-release.yml` is manually dispatched only. No dispatch has been performed by this implementation. Configure the repository variable `VECTOR_CLI_BLOB_ORIGIN` to the canonical origin of Vector's public Blob store and the secret `BLOB_READ_WRITE_TOKEN` using the owner's normal GitHub/Vercel setup. Do not paste credentials into a task, source file, command argument, or build log.

Before starting, prepare/review/publish the immutable catalog using the existing catalog release tooling. This workflow reads only `releases/vector-v<VERSION>/api.json` from the configured store and requires its reviewed SHA-256. It cannot select the latest catalog or prepare fresh model data silently.

Dispatch inputs are the exact version, full reviewed lowercase source commit SHA, reviewed catalog SHA-256, publication timestamp in `YYYY-MM-DDTHH:mm:ss.sssZ` form, channel, and phase. Reuse the same identity/timestamp on retries.

1. `prepare` (default): validate identity, run packaging regression tests, download and verify the pinned catalog, build all twelve native targets, package them, and preserve the exact output as a GitHub workflow artifact. It does not receive a Blob write token or publish anything.
2. `stage`: perform the same preparation, then upload immutable objects. Previously staged objects are reused only after byte verification. No public channel pointer changes.
3. `commit`: read the immutable manifest directly from Blob, verify its requested identity, stream/hash-check all twelve remote archives, and only then write the channel pointer. It does not rebuild the release. An older version cannot overwrite a newer channel version.

The workflow serializes all publisher runs with a shared concurrency group. Keep that serialization: Blob has no compare-and-swap for channel pointers, so independently running publishers must not race commits. A failed staging attempt can leave immutable objects, but cannot advance the channel. Retry the same release after resolving the cause; do not overwrite immutable bytes.

Desktop release compatibility is a separate gate. A desktop build must verify the exact standalone CLI version recorded as its required CLI version before publication; changing the standalone channel pointer does not modify desktop updater feeds.

## Local publication entrypoints

From `packages/cloud`, `bun run release:cli prepare|stage|verify|commit|all` exposes the same implementation. `prepare` is the default when no phase is supplied. These variables are explicit:

- `VECTOR_RELEASE_VERSION`, `VECTOR_RELEASE_CHANNEL` (`latest` or `beta`), `VECTOR_SOURCE_REVISION`, `VECTOR_CATALOG_SHA256`, and `VECTOR_CLI_BLOB_ORIGIN` pin identity.
- `VECTOR_RELEASE_PUBLISHED_AT` is required when preparing archives.
- `VECTOR_CLI_RELEASE_SOURCE` defaults to `packages/engine/dist`; `VECTOR_CLI_RELEASE_DIR` defaults to `packages/engine/dist-cli`.
- `BLOB_READ_WRITE_TOKEN` is required for remote phases only. Supply it through the owner's secret environment; the scripts never print it.

`prepare` consumes already-built artifacts. `verify` performs remote integrity verification without changing pointers. `commit` reuses already-staged bytes and does not require local build output. Run local commits only while no other publisher is active. Preserve the prepared directory; packaging refuses to overwrite different bytes or a different local manifest.

## Owner-created Homebrew and Scoop repositories

Create the repositories using the owner's GitHub organization/account. Do not infer an organization from existing upstream names. The Homebrew repository must use Homebrew's `homebrew-<tap>` naming convention. A Scoop repository can use the owner's chosen name; its local bucket alias is a separate explicit input.

After a complete stable release is verified, from `packages/cloud` run `bun run release:cli:managers` with:

- `VECTOR_CLI_MANIFEST`: the verified stable release manifest file.
- `VECTOR_HOMEBREW_REPOSITORY`: actual `owner/homebrew-<tap>` repository.
- `VECTOR_SCOOP_REPOSITORY`: actual `owner/<bucket-repository>` repository.
- `VECTOR_SCOOP_BUCKET`: the chosen local bucket alias, using letters/digits/hyphens.
- `VECTOR_CLI_MANAGERS_DIR`: a local output directory for review.

The generator writes `homebrew/Formula/vector.rb`, `scoop/bucket/vector.json`, and a README with commands derived from those exact supplied coordinates. It does not create repositories, push commits, or verify owner control. Review and copy the definitions to the respective owner-created repositories after the immutable release is live; then test actual installs/upgrades/removals through each manager before advertising them.

Homebrew targets macOS/Linux ARM64 and baseline x64. Linux Homebrew uses glibc; musl users use the standalone installer. Scoop targets Windows ARM64 and baseline x64. These definitions use immutable versioned URLs and exact SHA-256 values; regenerate them for each reviewed stable release. No moving binary URL, unchecked auto-update hook, or standalone receipt is emitted. Homebrew's installed receipt and Scoop's normal `install.json`/manifest remain authoritative for upgrade/uninstall detection. Homebrew retains notices under its package share/licenses directory; Scoop keeps them adjacent to the executable.

Vector's custom commercial license is represented honestly; bundled third-party notices remain included. Formula/manifest structure follows the [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook), Homebrew's [allowed license symbols](https://github.com/Homebrew/brew/blob/master/Library/Homebrew/utils/spdx.rb), and the [Scoop manifest specification](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests).

## Validation limits

Package tests create real deterministic tar/zip archives for all target headers, inspect every entry and byte, and exercise the publisher against real local HTTP responses. Tests cover wrong/missing build identity, target/header/notice/link rejection, archive/hash/size failures, immutable retry reconciliation, pinned catalog integrity, channel downgrade prevention, generated Ruby syntax, and manager coordinates/injection rejection. These tests do not replace actual cross-platform native build/install testing, Apple/Windows distribution signing policy, or publication checks in the real owner-created repositories. End-user installers, upgrade/uninstall, and WSL are separate implementations consuming this contract.
