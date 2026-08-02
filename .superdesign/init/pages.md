# Pages — component dependency trees

## `/` (Home / Landing)
Entry: `packages/web/src/pages/index.astro`
Dependencies:
- `packages/web/src/components/Lander.astro`  (2040 lines — THE page; all sections + scoped styles + reveal/cursor-glow script)
  - `packages/web/src/components/marketing/MarketingNav.astro`  (sticky glass nav)
  - `packages/web/src/components/marketing/MarketingFooter.astro`  (footer)
  - `packages/web/src/assets/lander/vector-agent-current.png`  (hero screenshot)
  - `packages/web/src/assets/lander/vector-workspaces-current.png`  (workspaces stage)
  - `packages/web/src/assets/lander/vector-browser-current.png`  (browser feature stage)
  - `packages/web/src/assets/lander/vector-editor-current.png`  (codespace duo card)
  - `packages/web/src/assets/lander/vector-cloud-current.png`  (cloud duo card)
- `packages/web/src/components/marketing/MarketingLayout.astro`  (html shell + global tokens)

Context-selection note: `Lander.astro` is over the ~900-line threshold — line-range it: template/markup is roughly the first ~640 lines; design tokens sit at the top of the `<style>` block; per-section styles follow in labeled `/* ===== Section ===== */` groups.

## `/download`
Entry: `packages/web/src/pages/download.astro` (self-contained styles)
Dependencies:
- `packages/web/src/components/marketing/MarketingNav.astro`
- `packages/web/src/components/marketing/MarketingFooter.astro`
- `packages/web/src/components/marketing/MarketingLayout.astro`
