# Native binary identifier decision

The final Part 1 macOS arm64 development binary has 16 case-insensitive byte matches for the former product name, zero UTF-16 matches, zero retired shared-key literals, zero checked borrowed OAuth-registration literals, and zero former-product host matches. Its SHA-256 is `3531514e590ab1b94d9e72cbebfbea40ebdf432ce5f1e01b5afb3397d54621a4`. The strict byte-level check therefore does **not** pass. No exception has been assumed.

All 16 matches have identified origins:

| Matches | Origin                                     | Meaning                                                                 |
| ------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| 2       | Embedded third-party notices               | Required legal attribution; the brief permits legal text                |
| 13      | Monaco's editor-opening method identifiers | Internal editor API names, not product branding or network destinations |
| 1       | Bun's built-in package table               | Runtime dependency metadata, not a configured Vector service            |

The same 16 attributed matches existed in the prior reviewed native build. They were previously classified as dependency provenance, not eliminated. The new brief's literal byte rule is stricter than that previous classification. The agent has asked the owner to choose between:

1. Permit these documented third-party identifiers alongside required legal attribution, while retaining the complete source/path guard, service-endpoint checks and borrowed-registration checks.
2. Expand the maintenance scope to reproducible Vector-owned runtime/editor changes that remove every non-license match. Do not patch compiled bytes or hide the name through string splitting/encoding. Keep upstream license notices intact, and verify editor navigation plus runtime/package behavior on every target after any maintained source changes.

Since the environment migration fix, `packages/core/src/flag/legacy.ts` imports `THIRD_PARTY_NOTICES.md` as text to derive the earlier product's environment prefix and default server username. The engine and TUI bundles therefore embed the notices text one more time, so the next audit will show extra "Embedded third-party notices" hits. They are expected legal-attribution hits, not new product identifiers.

The development artifact is not a published release or an installed replacement. Its final audit is recorded at `/Users/Krishna/.cache/vector-rebuild-evidence/part1-binary-audit.json`, with exact occurrence attribution in `part1-final-native-attribution.json` beside it. Repeat the audit for each later release artifact. Until the owner decides, report the strict binary check as unresolved rather than claiming complete removal.

## Automated release audit

`script/artifact-audit.ts` now enforces this rule on every release path before anything is uploaded or published:

- npm CLI: `packages/engine/script/publish-vector.ts` audits every `dist/vector-<target>` package and the `@vectordevai/cli` umbrella.
- Standalone CLI: `packages/cloud/src/upload-cli-release.ts` audits the prepared `.tar.gz` and `.zip` archives (decompressed while streaming) after `prepare` and again before a separate `stage`.
- Desktop: `packages/desktop/scripts/verify-package.ts` (macOS `.app`) and `packages/desktop/scripts/verify-notices.ts` (Windows and Linux unpacked apps) audit each app, including `app.asar` and the bundled engine, before the release workflow uploads installers.

The standalone archives that `packages/engine/script/build.ts` uploads to GitHub Releases when `VECTOR_RELEASE` is set are audited right before that upload. The CLI archives are audited inside `packageCliRelease` (before any archive reaches the output directory) and `stageCliRelease` (before the first Blob upload). Both desktop scripts reach the audit through `verifyNotices`.

It fails on the former name in any case in UTF-8 and both UTF-16 byte orders, retired upstream hosts (the former product domain and the public model catalog service URL), and borrowed OAuth registrations or shared-key literals. The Codex CLI client used for ChatGPT sign-in is allowed. Only three classes are allowed and each is counted in the output: exact notice lines from `THIRD_PARTY_NOTICES.md` and `LICENSE`, Monaco's open-code-editor method name in its one exact casing, and Bun's built-in package table entry between its pinned neighbours. Run it by hand with `bun script/artifact-audit.ts <file-or-directory>...`.

## Release blocker: two desktop identifier classes need an owner decision

Desktop releases on macOS, Windows and Linux will fail the audit as `main` stands. The failure happens in `verify:package` (macOS) and `verify-notices.ts` (Windows and Linux), which run after the signing and notarization steps, so a release attempt spends that time before stopping. Neither class below is allowlisted, and none will be without the owner's approval.

| Class | Where it comes from | Evidence |
| ----- | ------------------- | -------- |
| Node.js `util.styleText` local variable | Node.js inside Electron 42.11.4, the version `main` pins. The local variable that holds the opening ANSI codes is the former name followed by `s`. Node.js is part of the Electron executable on all three platforms (`Electron Framework` on macOS, the main executable on Windows and Linux). | 5 matches in `/Applications/Vector.app/Contents/Frameworks/Electron Framework.framework/Versions/A` from the installed 1.99.91 app. The packaged Linux and Windows Electron binaries were not audited here (no network to fetch them), but the same Node.js source ships in them. |
| Drizzle's no-op encoder export | `drizzle-orm` 1.0.0-rc.2 exports a no-op encoder helper whose name is the word `noop` directly followed by `Encoder`. Lowercased, that identifier contains the former name. `packages/desktop/electron.vite.config.ts` bundles the engine's Node build (`packages/engine/dist/node/node.js`) into the desktop main process, and `packages/engine/script/build-node.ts` does not minify, so the identifier survives into `app.asar` on every desktop platform. The standalone CLI is minified (`packages/engine/script/build.ts`), which renames it there. | 5 matches, all in `main/chunks/node-*.js`, in a September 24 desktop build output, and the same 5 in a September 1 `app.asar`. |

The owner decides for each class:

1. Approve it. Then each class gets its own tightly anchored, counted allowlist entry in `script/artifact-audit.ts`, like the Monaco and Bun entries: the exact identifier between non-identifier boundaries, reported in the audit summary, with a fixture test.
2. Remove it at the source. For Node.js, move to an Electron build whose Node.js does not carry the identifier. For Drizzle, either minify the engine Node build that the desktop bundles (and verify the desktop app after that change) or move to a Drizzle release without the identifier. Do not patch compiled bytes or hide the name through string splitting or encoding.

Until both classes are decided, report desktop releases as blocked by the artifact audit. The npm CLI and standalone CLI paths are not affected by either class.
