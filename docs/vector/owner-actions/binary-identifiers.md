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

The development artifact is not a published release or an installed replacement. Its final audit is recorded at `/Users/Krishna/.cache/vector-rebuild-evidence/part1-binary-audit.json`, with exact occurrence attribution in `part1-final-native-attribution.json` beside it. Repeat the audit for each later release artifact. Until the owner decides, report the strict binary check as unresolved rather than claiming complete removal.
