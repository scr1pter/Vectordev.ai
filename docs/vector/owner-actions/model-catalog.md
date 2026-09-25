# Owner action: Vector model catalog and provider artwork

Status: preparation, validation, runtime refresh and publication plumbing are built. The Vector data fork, its reviewed export, complete logo import and first mirror publication still require owner action. No repository, account or key was created for this work. A missing fork is a release error; the tools never fall back to the original live data service.

## Create and review the data repository

1. In GitHub, fork the MIT-licensed [Models.dev data repository](https://github.com/anomalyco/models.dev) into the Vector-controlled account or organization you choose. A suggested repository name is `vector-model-catalog`; this name is a proposal, not an existing repository. Make the fork public if you want the existing release workflow to read it without an additional cross-repository credential.
2. Keep its complete MIT `LICENSE`. Vector's `THIRD_PARTY_NOTICES.md` also contains the original data/artwork attribution. Provider trademarks remain their owners' marks; review their usage guidelines before adding or changing artwork.
3. Review the fork's data and build scripts before running them. Generate the catalog from that fork's TOML files using its documented local build. At the reviewed layout, `bun install --frozen-lockfile` followed by `bun run build` in `packages/web` emits `dist/_api.json`. Confirm that output exists and the fork's build uses its local data; do not substitute a download from the original live service.
4. Copy that generated JSON into `vector/api.json` inside the fork and commit it together with the data changes. The Vector release tooling deliberately reads this committed data export instead of executing the fork's code. Retain provider artwork as `providers/<provider-id>/logo.svg`. Supply a reviewed SVG for every ID in Vector's `SUPPORTED_PROVIDER_IDS`, including providers which do not currently expose usable models. Do not replace missing providers with a misleading borrowed provider logo.
5. Record the fork's `OWNER/REPOSITORY` and full 40-character commit SHA. Confirm the repository is controlled by Vector. These are nonsecret provenance settings, not credentials. New providers still require a Vector code review and release because the provider and bundled-SDK allowlists remain enforced.

## Import the reviewed data and artwork

Clone the owner's fork normally, check out the recorded commit, and leave its tracked files clean. Set these values explicitly in your shell using the actual owner-selected repository and SHA:

```sh
export VECTOR_CATALOG_FORK_PATH="$(cd ../vector-model-catalog && pwd)"
export VECTOR_CATALOG_FORK_REPOSITORY="OWNER/vector-model-catalog"
export VECTOR_CATALOG_FORK_REVISION="FULL_40_CHARACTER_COMMIT_SHA"
export VECTOR_CATALOG_FILE="$PWD/tmp/release-catalog.json"
bun packages/engine/script/generate.ts --fresh-catalog
bun packages/ui/script/provider-catalog-icons.ts --import
```

The placeholder values must be replaced. Preparation verifies the checkout's origin and exact HEAD, rejects modified tracked files, and reads only regular committed blobs. It records the source export digest, fork repository/commit and prepared catalog digest alongside the output. SVG import rejects active or external content and validates the full set before writing any icons. Inspect and commit the imported SVGs and regenerated sprite/type inventory in the Vector application repository. A release CI step fails if an allowlisted provider lacks a registered sprite symbol.

For CLI and desktop builds, pass the same reviewed prepared file and digest:

```sh
export VECTOR_RELEASE_CATALOG_PATH="$VECTOR_CATALOG_FILE"
export VECTOR_RELEASE_CATALOG_SHA256="$(bun -e 'console.log(new Bun.CryptoHasher("sha256").update(await Bun.file(process.env.VECTOR_RELEASE_CATALOG_PATH).text()).digest("hex"))')"
```

These build inputs are separate from runtime `VECTOR_MODELS_PATH` and `VECTOR_MODELS_URL`. A release retry reuses its exact prepared artifact or immutable per-version mirror; it never silently regenerates it from a moving branch. Set repository Actions variables `VECTOR_CATALOG_FORK_REPOSITORY` and `VECTOR_CATALOG_FORK_REVISION` to the same reviewed values before the next new release. The workflow checks that exact commit out under its ignored temporary directory.

## Publish and verify the mirror

The owner supplies `BLOB_READ_WRITE_TOKEN` in the approved server/release environment. Do not paste it into a command argument, Git, the app, a screenshot or a log. Set `VECTOR_RELEASE_VERSION` to the approved release version and `VECTOR_CATALOG_FILE` to the exact prepared file already used by the binaries.

```sh
bun packages/cloud/src/upload-model-catalog.ts --update-mirror
bun packages/engine/script/verify-catalog-mirror.ts
```

This first verifies or creates the immutable `releases/vector-v<version>/api.json`, then explicitly updates `models/api.json` with the same bytes. Re-running the uploader without `--update-mirror` only verifies/publishes the immutable release; an old release retry cannot silently roll the shared mirror back. Use `--update-mirror` only when that snapshot is the intended current catalog.

The application site's `/models` and `/models/api.json` rewrites target the existing Vector-owned Blob bucket. They need the corresponding website deployment before the public check can pass. The check requires HTTP 200, `application/json`, the same canonical catalog bytes at both URLs, supported provider identities and bundled SDKs. The release workflow runs it after mirror publication. No first publication or successful live response is claimed until this command passes against production.

Runtime defaults to `https://vectordev.ai/models`; the bundled snapshot remains available when a refresh fails. `VECTOR_DISABLE_MODELS_FETCH=1` disables refresh. `VECTOR_MODELS_PATH` selects a local file and makes no mirror requests. Operators may deliberately set `VECTOR_MODELS_URL` to an HTTP or HTTPS directory (or its `api.json` URL); Vector warns that this source is operator-maintained and records whether transport is encrypted. Embedded credentials, query strings, fragments and redirects are refused. Catalog shape and bundled-SDK checks apply equally to owned and custom mirrors. Custom mirrors cannot add executable adapters.

## Acceptance record

Before marking this owner action complete, record the fork URL, commit, imported icon count, source and prepared digests, approved release version, immutable Blob URL, production `/models` check output and matching CLI/desktop build provenance. Until the fork and complete artwork are provided, catalog/icon preparation is intentionally blocked with the setup instructions above. Existing published application/catalog versions are unchanged.
