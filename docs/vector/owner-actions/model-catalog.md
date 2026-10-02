# Owner action: Vector model catalog and provider artwork

## Current state (2 October 2026)

The separate local desktop 1.99.91 build used a stale bundled catalog that stopped at gpt-5.5, and `https://vectordev.ai/models/api.json` returned 404, so signed-in ChatGPT users could not see gpt-6-astra, gpt-6-sol, gpt-6.1-sol or the gpt-5.6 family. Until the fork below exists, the catalog is an interim snapshot:

- Source: the Models.dev project's published `api.json`, downloaded on 2 October 2026 (MIT, attributed in `THIRD_PARTY_NOTICES.md`); source sha256 `9de50f94219793121deb6d1b6f6fc290433a82b70b7974459853d35d198ed61f`.
- Prepared with `catalogBody(text, true)` from `packages/engine/script/release-catalog.ts`, the same allowlist and bundled-SDK filtering a fork export gets: 219 providers, 8,184 models; prepared sha256 `b3477f4feb7bb439731ad20bad15772394c8a7dec65f527e8488648e5931ae8a`.
- Served as the static file `packages/web/public/models/api.json`. `vercel.json` rewrites `/models` to it, and `script/prune-vector-site.mjs` keeps the `models` folder. The Blob rewrites were removed because nothing was ever published there; restore them when `upload-model-catalog.ts --update-mirror` takes over, or that upload will be shadowed by this file.
- That separate local build used the snapshot as `VECTOR_RELEASE_CATALOG_PATH` with its sha256. The 1.999.99 cross-platform release still requires the owner-controlled fork and reviewed export below; the interim mirror does not establish that provenance.
- At runtime, catalog modes the bundled SDKs cannot send are not offered as models (`ModelCatalog.modeSupported`): the "pro" reasoning modes, the "ultrafast" tier, and priority or flex tiers the SDK drops for a model family it does not know (GPT-6 Fast). The served file keeps every mode so a build with a newer SDK can offer them.

Installed apps fetch the mirror at launch and every 60 minutes, so a refreshed file reaches them without a reinstall. To refresh the snapshot, prepare a new `api.json` the same way, replace the static file, and record the new digests here. The fork process below remains the intended long-term source.

Status: preparation, validation, runtime refresh and publication plumbing are built. The Vector data fork, its reviewed export and immutable release-catalog publication still require owner action. Provider-specific artwork is preferred; missing artwork uses a neutral server icon drawn for Vector, never another provider's logo. No repository, account or key was created for this work. A missing fork is a release error; the tools never fall back to the original live data service.

## Create and review the data repository

1. In GitHub, fork the MIT-licensed [Models.dev data repository](https://github.com/anomalyco/models.dev) into the Vector-controlled account or organization you choose. A suggested repository name is `vector-model-catalog`; this name is a proposal, not an existing repository. Make the fork public if you want the existing release workflow to read it without an additional cross-repository credential.
2. Keep its complete MIT `LICENSE`. Vector's `THIRD_PARTY_NOTICES.md` also contains the original data/artwork attribution. Provider trademarks remain their owners' marks; review their usage guidelines before adding or changing artwork.
3. Review the fork's data and build scripts before running them. Generate the catalog from that fork's TOML files using its documented local build. At the reviewed layout, `bun install --frozen-lockfile` followed by `bun run build` in `packages/web` emits `dist/_api.json`. Confirm that output exists and the fork's build uses its local data; do not substitute a download from the original live service.
4. Copy that generated JSON into `vector/api.json` inside the fork and commit it together with the data changes. The Vector release tooling deliberately reads this committed data export instead of executing the fork's code. Retain available provider artwork as `providers/<provider-id>/logo.svg`. Missing artwork may use Vector's neutral provider icon while retaining the provider's own display name. Do not replace missing providers with a misleading borrowed provider logo.
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

The placeholder values must be replaced. Preparation verifies the checkout's origin and exact HEAD, rejects modified tracked files, and reads only regular committed blobs. It records the source export digest, fork repository/commit and prepared catalog digest alongside the output. SVG import rejects active or external content and validates all supplied artwork before writing any icons. Only an absent committed artwork file is optional: symlinks, malformed SVG, invalid text and other read errors still fail. Existing committed provider artwork remains available when the fork has no replacement.

Inspect and commit the imported SVGs and regenerated sprite/type inventory in the Vector application repository. Release CI checks that existing provider names and sprite symbols agree, requires the committed neutral fallback, and reports which providers use it. The neutral icon is an original Vector-drawn server glyph, not a provider mark. To regenerate the sprite from the existing committed artwork without importing or accessing a fork, run `bun packages/ui/script/provider-catalog-icons.ts --generate`. Icon fallback changes presentation only; the fork provenance, pinned catalog digest, supported-provider list and bundled-SDK checks remain mandatory.

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

Today `/models/api.json` is the committed static file and `/models` is rewritten to it (see Current state above); the Blob rewrites this section was written for are removed. Until they are restored, the release workflow's `verify-catalog-mirror.ts` step will compare its uploaded catalog with the static file, so a CI release must ship the same bytes as `packages/web/public/models/api.json` or restore the Blob rewrites first. When restored, the rewrites need the corresponding website deployment before the public check can pass. The check requires HTTP 200, `application/json`, the same canonical catalog bytes at both URLs, supported provider identities and bundled SDKs. The release workflow runs it after mirror publication. No first publication or successful live response is claimed until this command passes against production.

Runtime defaults to `https://vectordev.ai/models`; the bundled snapshot remains available when a refresh fails. `VECTOR_DISABLE_MODELS_FETCH=1` disables refresh. `VECTOR_MODELS_PATH` selects a local file and makes no mirror requests. Operators may deliberately set `VECTOR_MODELS_URL` to an HTTP or HTTPS directory (or its `api.json` URL); Vector warns that this source is operator-maintained and records whether transport is encrypted. Embedded credentials, query strings, fragments and redirects are refused. Catalog shape and bundled-SDK checks apply equally to owned and custom mirrors. Custom mirrors cannot add executable adapters.

## Acceptance record

Before marking this owner action complete, record the fork URL, commit, imported icon count and fallback-provider list, source and prepared digests, approved release version, immutable Blob URL, production `/models` check output and matching CLI/desktop build provenance. Until the fork and reviewed export are provided, fresh catalog preparation is intentionally blocked with the setup instructions above. Missing provider artwork alone does not block release. This interim runtime mirror does not advance published application versions or satisfy the immutable release-catalog gate.
