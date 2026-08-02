# Theme — Vector marketing site

## Part 1 — Compact token summary

**Mode**: dark only (`color-scheme: dark`). Page background `#0a0a0b` (near-black gray). Strictly purple accent family; the ONLY non-purple color is a warm Lovable-style coral/pink band inside animated `.gradient-words` text.

### Colors (CSS custom properties on `.vector-marketing` and `:root`)
| Token | Value | Use |
| --- | --- | --- |
| `--page` | `#0a0a0b` | page background |
| `--ink` | `#f5f3fa` | primary text |
| `--muted` | `#918d9c` | secondary text |
| `--muted-strong` | `#bbb6c6` | tertiary text |
| `--hairline` | `rgba(255,255,255,0.08)` | borders/dividers |
| `--hairline-soft` | `rgba(255,255,255,0.05)` | subtle dividers |
| `--violet` | `#8b5cf6` | core accent |
| `--violet-soft` | `#a78bfa` | accent (chips, dots) |
| `--violet-bright` | `#c4b5fd` | accent highlight / eyebrows |
| `--violet-deep` | `#6d28d9` | accent shadow end |
| `--orchid` | `#c084fc` | accent variant |
| `--lovable-coral` | `#ff8a4c` | gradient-words flash only |
| `--lovable-pink` | `#f472b6` | gradient-words flash only |
| `--lovable-rose` | `#fda4af` | gradient-words flash only |
| `--glass` | `rgba(255,255,255,0.035)` | card bg bottom |
| `--glass-strong` | `rgba(255,255,255,0.06)` | card bg top |

### Type
- Family: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI", ui-sans-serif, sans-serif` — deliberately slim.
- H1: `clamp(46px, 8vw, 108px)`, weight 500, line-height 1.01, letter-spacing -0.04em.
- H2 (chapter): `clamp(38px, 5.4vw, 64px)`, weight 500, letter-spacing -0.03em, white→#c3bcd4 vertical gradient clip.
- H3 (cards): 20–24px, weight 520, letter-spacing -0.015em.
- Body/lede: 17px #918d9c; card copy 13.5px; captions/labels 11–12px uppercase letterspaced (0.08–0.22em).
- Big numbers (ticker/proof): clamp 40–84px, weight 400, white→violet gradient clip + purple drop-shadow glow.
- Mono (chips/captions): `ui-monospace, SFMono-Regular, Menlo, Consolas`.

### Shape & effects
- Radii: 7px (chips), 12px (row hovers), 20px (`--r-md` cards), 28px (`--r-lg` stages/bento), 999px (pills).
- Gloss: every glass card has `inset 0 1px 0 rgba(255,255,255,0.07)` top light-catch.
- Glow: purple only — box-shadows `rgba(139,92,246, .1–.6)`, blooms are blurred (70px) radial ellipses at ~0.16–0.2 alpha.
- Screenshots: 28px radius, 1px rgba(255,255,255,0.1) border; hero shot fades out via `mask-image: linear-gradient(180deg,#000 78%, transparent 100%)`.
- Motion: reveal = fade/rise 700ms; pulse-dot 2–2.8s; gradient-sheen 9s; shine sweep 5s; bloom-breathe 8–9s. `prefers-reduced-motion` disables all.

## Part 2 — Raw source

### Global stylesheet (`packages/web/src/components/marketing/MarketingLayout.astro` `<style is:global>`)
```css
:root {
    color-scheme: dark;
    --page: #0a0a0b;
    --surface: #111113;
    --surface-soft: #161618;
    --ink: #f5f3fa;
    --muted: #918d9c;
    --muted-strong: #bbb6c6;
    --line: rgba(255, 255, 255, 0.07);
    --line-strong: rgba(255, 255, 255, 0.12);
    --accent: #a78bfa;
    --accent-soft: #241b3d;
    --accent-strong: #c4b5fd;
    --success: #34d399;
  }

  * {
    box-sizing: border-box;
  }

  html {
    scroll-behavior: smooth;
    background: var(--page);
    scrollbar-color: #4a4652 var(--page);
  }

  body {
    min-width: 320px;
    margin: 0;
    color: var(--ink);
    background: var(--page);
    font-family:
      -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI", ui-sans-serif,
      sans-serif;
    font-size: 16px;
    line-height: 1.55;
    letter-spacing: 0;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }

  button,
  input,
  select {
    font: inherit;
  }

  input,
  select,
  textarea {
    color-scheme: dark;
  }

  input::placeholder,
  textarea::placeholder {
    color: #77737e;
  }

  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  ::selection {
    color: #fff;
    background: var(--accent-strong);
  }

  @media (prefers-reduced-motion: reduce) {
    html {
      scroll-behavior: auto;
    }

    *,
    *::before,
    *::after {
      animation-duration: 1ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 1ms !important;
    }
  }
```

### Lander token block (`packages/web/src/components/Lander.astro`, top of scoped `<style>`)
```css
/* ===== Tokens ===== */

  .vector-marketing {
    --page: #0a0a0b;
    --ink: #f5f3fa;
    --muted: #918d9c;
    --muted-strong: #bbb6c6;
    --hairline: rgba(255, 255, 255, 0.08);
    --hairline-soft: rgba(255, 255, 255, 0.05);
    --violet: #8b5cf6;
    --violet-soft: #a78bfa;
    --violet-bright: #c4b5fd;
    --violet-deep: #6d28d9;
    --orchid: #c084fc;
    --lovable-coral: #ff8a4c;
    --lovable-pink: #f472b6;
    --lovable-rose: #fda4af;
    --glass: rgba(255, 255, 255, 0.035);
    --glass-strong: rgba(255, 255, 255, 0.06);
    --r-md: 20px;
    --r-lg: 28px;
    --container: 1120px;
    min-width: 320px;
    position: relative;
    z-index: 0;
    overflow: clip;
    color: var(--ink);
    background: var(--page);
    font-family:
      -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI", ui-sans-serif,
      sans-serif;
    font-size: 16px;
    line-height: 1.55;
  }

  :global(.vector-marketing *) {
    box-sizing: border-box;
  }

  :global(.vector-marketing a) {
    color: inherit;
  }
```
