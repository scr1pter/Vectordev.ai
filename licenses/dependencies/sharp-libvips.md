# sharp-libvips notice provenance

The `@img/sharp-libvips-*@1.2.4.txt` overrides distinguish the native libraries' licenses from the Apache-2.0 packaging scripts in the publisher's repository and preserve both sets of supplied terms.

Each published npm tarball was downloaded over HTTPS and its SHA-512 integrity was checked against the exact package/version in `bun.lock`. The artifact's `package.json` declares `LGPL-3.0-or-later`. Its `README.md` supplies the bundled-library licensing notice and its `versions.json` supplies the bundled component versions. No individual component authors or copyright notices have been inferred from the npm package author.

The artifact licensing notice matches `THIRD-PARTY-NOTICES.md` at the npm metadata's publisher commit, [20b5e899954907a3039d6e3d4c200aaa0ec52c4c](https://github.com/lovell/sharp-libvips/tree/20b5e899954907a3039d6e3d4c200aaa0ec52c4c). The full LGPL version 3 and incorporated GPL version 3 terms come from [SPDX license-list-data v3.27.0](https://github.com/spdx/license-list-data/blob/d46e94e2c78ceede1cfc63cfa0396472d2798d4c/text/LGPL-3.0-or-later.txt). The publisher's Apache-2.0 packaging-script license is retained in a separately labelled section from the same publisher commit. Each override records the artifact integrity, source URLs and source-text SHA-256 hashes.

When upgrading these packages:

1. Fetch the exact locked npm artifacts using HTTPS and verify their lockfile integrity before inspecting or extracting them.
2. Preserve the licensing notice and component versions from those artifacts. Verify any supplemental publisher notice against the exact `gitHead` reported by the version's npm metadata. Do not copy a moving `main` branch's license or treat the packaging scripts' Apache license as the libraries' license.
3. Preserve the full applicable license texts, including the GPL terms incorporated by LGPL version 3. Reconcile changes in bundled components and their notices against the new publisher artifacts.
4. Update the overrides, then run `bun run script/dependency-notices.ts --update-platform-notices` from the repository root with frozen-lockfile dependencies installed. Review the refreshed platform inventory and `DEPENDENCY_NOTICES.md` together. Run `bun test test/compliance/platform-notices.test.ts test/compliance/dependency-notices.test.ts` from `packages/engine`.

These records repair the incorrect Apache-only fallback and preserve the publisher's bundled-library notice. They do not establish compliance with every component's distribution conditions. Before publishing native binaries, reconcile component-specific copyright/license notices, preserve the corresponding source and build information, and verify the applicable LGPL replacement/relinking and installation requirements for the actual packaged artifacts. The publisher's license table and generic license text alone do not establish those release conditions.
