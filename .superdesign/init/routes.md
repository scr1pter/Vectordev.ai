# Routes — Vector marketing site (`packages/web`, Astro file-based routing)

| URL | File | Layout | Notes |
| --- | --- | --- | --- |
| `/` | `packages/web/src/pages/index.astro` | MarketingLayout | Landing page; renders `Lander.astro` (nav + 9 chapters + footer). Prerendered. |
| `/download` | `packages/web/src/pages/download.astro` | MarketingLayout | Download page with platform detection. |
| `/download/*` | `packages/web/src/pages/download/` | MarketingLayout | Checksums etc. |
| `/docs` | `packages/web/src/pages/docs.astro` | Starlight | Documentation (separate Starlight theme — out of scope for marketing design). |
| `/s/*` | `packages/web/src/pages/s/` | — | Share links (app UI, out of scope). |

## `/` (home) summary
Single-page Apple-style product story, dark (#0a0a0b) with purple accents. Chapters in order: sticky glass nav → hero (wordmark, oversized slim headline with animated gradient second line, sub, CTA pill + text link, 4 pulsing signal dots, bottom-masked product screenshot) → stat ticker (4 huge thin gradient numbers, hairline separators) → workflow rail (5 horizontal scroll-snap glass cards) → workspaces (wide screenshot card + 4-column spec list) → intelligence bento (5 asymmetric glass cards: 3+3 / 2+2+2 spans) → surfaces (full-bleed browser screenshot with floating caption card, then 2 duo cards with inset screenshots, works-with text rail) → capabilities specs table (6 hairline rows: number chip + title | copy + item pills) → trust trio (3 columns) → proof (3 huge gradient stat numbers, caveat, differences hairline list, comparison table in a details disclosure) → closing (oversized headline with gradient line, CTAs, purple bloom) → footer.

### `index.astro` (entry)
```astro
---
import Lander from "../components/Lander.astro"
import MarketingLayout from "../components/marketing/MarketingLayout.astro"

export const prerender = true
---

<MarketingLayout
  title="Vector — AI engineering inside your repository"
  description="Run isolated coding agents inside your repository, work in a real editor and terminal, verify in a controlled browser, and review every change before it reaches main."
>
  <Lander />
</MarketingLayout>

```
