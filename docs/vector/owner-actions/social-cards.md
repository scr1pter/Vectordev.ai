# Optional documentation social cards

The prepared `/api/og?title=Install%20Vector` endpoint renders a 1200 × 630 PNG with the Vector name and a public documentation title. It is disabled by default. This guide does not claim that the route is enabled or deployed in production.

## Enable and verify

1. Use a Node.js 22 or newer Vercel function runtime. Set `VECTOR_OG_ENABLED=true` in the website build environment and the hosted API environment. This is a public feature flag, not a credential.
2. Configure the existing persistent abuse protection service (`KV_REST_API_URL`, `KV_REST_API_TOKEN` and `VECTOR_ABUSE_SECRET`) through the hosting environment. Do not put these values in website source or browser configuration. The route fails closed if persistent rate protection is unavailable.
3. Build and deploy the website and API together. Astro captures only the boolean flag through its public metadata constant at build time. Changing the flag requires a fresh website build; changing the runtime flag alone does not rewrite published metadata.
4. Verify `/api/og?title=Install%20Vector` returns a PNG with dimensions 1200 × 630, `Content-Type: image/png`, `Referrer-Policy: no-referrer` and the expected image. Verify `/docs/install` has an `og:image` and `twitter:image` on the fixed `https://vectordev.ai/api/og` origin. Login and account pages retain the static Vector logo.
5. Verify duplicate title parameters, unsupported characters, arbitrary `url` or size parameters and requests with bodies fail. The optional local HTTP integration tests require an explicitly supplied disposable loopback `VECTOR_TEST_REDIS_URL`; they never connect to a default local Redis service.

Only documentation layouts opt in. Titles are limited to 1–120 printable ASCII characters; common English curly quotes, dashes and ellipses are normalized by the metadata helper. Empty, long or unsupported titles use the existing static logo. Do not place private content, tokens, account identifiers or other personal data in social titles or URLs.

The renderer accepts plain text only. It cannot accept HTML, image URLs, archive bytes, custom fonts, styles or dimensions. Printable ASCII keeps rendering on the bundled Geist font and avoids remote emoji or fallback-font requests. Local tests render ordinary text, maximum-length text and HTML-looking text as PNGs. A Node.js 24 render of all printable ASCII characters observed no outbound HTTP requests.

Successful images may be cached publicly for 24 hours. Errors are not cached. Persistent protection limits uncached origin requests to 30 per IP per minute. To disable, remove or set `VECTOR_OG_ENABLED=false` in both environments, rebuild and redeploy; existing CDN or social-network cached cards may persist until their caches expire.

## Reviewed packages and notices

The exact renderer is `@vercel/og@1.0.1`. The reviewed newer 1.0.3 archive failed a real local render because it referenced a missing `hb.wasm`; no unpublished package patch or version-age bypass is used. The selected version renders successfully under both Bun and Node.js. React reuses the repository's existing 19.2.8 version.

The new optional Sharp dependency resolves to 0.35.4, which fixes [GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c). A narrow `fflate@0.8.3` override updates the installed font parser dependency past [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98). The renderer also contains prebundled font inflation code: the override does not rewrite those published bytes. Review found no affected `unzipSync`/ZIP64 routine there, and this endpoint accepts no fonts, images or archives.

The published renderer also embeds Tailwind CSS 3.1.8, `postcss-selector-parser` 6.0.10, cssesc 3.0.0 and twrnc 3.4.0. They have separate notices even though they are absent from the installed dependency graph. The parser predates the upstream [CVE-2026-9358 recursion fix](https://github.com/postcss/postcss-selector-parser/pull/316). This route supplies fixed React styles and treats the title as text; it never accepts CSS selectors, Tailwind classes or styles from a request. Consequently the attacker-controlled selector input required by that issue is not exposed here. The exact-version OSV query returned no advisories for these four packages on 2026-09-26; that database result alone is not a claim that the embedded code has no known issues. Future custom CSS, fonts or assets require a fresh dependency and input review.

Older Sharp versions remain in unrelated existing dependency paths: `@huggingface/transformers@4.2.0` used by the App's local audio-transcription worker resolves to Sharp 0.34.5; Astro 5.7.13 and Miniflare 4.20251118.1 resolve to Sharp 0.33.5. The advisory concerns processing attacker-controlled images on affected platforms. Presence in the audio worker's dependency graph alone does not establish that vulnerable image processing is reachable from an audio request. Those existing consumers need separate review; this change does not silently upgrade them.

Full server license texts, publisher notices, source archive links and integrity hashes are recorded in [social-card-notices.md](../../../licenses/server/social-card-notices.md) and [social-card-sources.json](../../../licenses/server/social-card-sources.json), and displayed on `/legal/third-party`. The renderer is server-only and unmodified; PNG recipients do not receive its library code. The MPL-2.0, font OFL-1.1 and optional native dependency notices remain separate from Vector's commercial license. These packages are not included in desktop or standalone CLI bundles.
