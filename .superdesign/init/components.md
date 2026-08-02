# Shared UI Components — Vector marketing site

**Framework**: Astro 5.7 (static, prerendered). Solid.js available but the marketing surface is plain Astro.
**Styling**: Scoped `<style>` blocks per component + one global stylesheet in `MarketingLayout.astro`. No Tailwind, no component library.
**Fonts**: System stack — `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI"`. Slim weights (400–580).

There is **no separate primitives library**. Reusable patterns are CSS classes defined inside `Lander.astro`'s scoped styles and reused across sections:

## Pattern classes (defined in `packages/web/src/components/Lander.astro`)

- `.eyebrow` — tiny uppercase label, letterspaced 0.22em, violet-bright (#c4b5fd), glowing 5px dot before.
- `.chip-number` / `.chip-code` — mono uppercase chips: violet text on rgba(139,92,246,.08) bg, 1px rgba(167,139,250,.26) border, 7px radius, soft purple glow shadow.
- `.cta-primary` — pill button (999px radius), purple gradient (linear-gradient(180deg,#9d74f8,#7c3aed)), white text, glow shadows + animated shine sweep, hover lift.
- `.cta-text` — plain text link with arrow that slides 4px on hover.
- `.gradient-words` — background-clipped animated gradient text: mostly violet shades with a warm Lovable-style coral/pink band sweeping through (9s linear loop).
- `.reveal` / `.in-view` — IntersectionObserver scroll reveal: fade + 24px rise + 0.995 scale, 700ms cubic-bezier(0.16,1,0.3,1), per-element `--d` transition-delay.
- `.cursor-glow` — fixed 600px purple radial that follows the pointer (mix-blend-mode: screen), fine-pointer devices only.
- Glass card recipe — `background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.035))`, 1px rgba(255,255,255,0.08) border, 20–28px radius, `inset 0 1px 0 rgba(255,255,255,0.07)` gloss line, backdrop-blur 14px, hover scale 1.01–1.015 + violet border.

The full source for these patterns is in `pages.md`'s entry file `packages/web/src/components/Lander.astro` (2040 lines — line-range it when passing as context; the token block is at the top of its `<style>`, the section markup is the template above it).
