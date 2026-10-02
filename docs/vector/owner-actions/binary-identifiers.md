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

## Decision: both desktop identifier classes are allowed (1 October 2026)

The owner's rule is that the former name may appear only in license text and third-party code. Both desktop classes are third-party identifiers that contain the name by coincidence, so they are allowed in `script/artifact-audit.ts` like the Monaco and Bun entries: each matches only its exact identifier between non-identifier boundaries, is counted in the audit summary, and has a fixture test.

| Class     | Where it comes from                                                                                                             | Allowed form                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `node`    | Node.js `util.styleText` inside Electron's executable (`Electron Framework` on macOS, the main executable on Windows and Linux) | the local variable for the opening ANSI codes: the Monaco casing followed by `s`, next to `closeCodes` |
| `drizzle` | drizzle-orm 1.0.0-rc.2's no-op encoder export, carried by the engine bundle in `app.asar`                                       | `no` + the name with its third letter capitalised + `r`                                                |

Anything else that contains the name, in any casing or encoding, still fails the release. Desktop releases are no longer blocked by the audit; repeat the audit on every release artifact as before.
