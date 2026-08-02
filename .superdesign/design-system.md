# Vector — Design System

## Product context

Vector is a **local-first AI engineering platform** for desktop (macOS/Windows/Linux): isolated coding agents run inside the user's own repository beside a real editor, terminal, and a controlled browser, with human review before anything reaches main. Audience: professional software engineers. Brand voice: precise, calm, confident — "power without surrendering the project."

Key page: the marketing landing page (`/`) — an Apple-style single-page product story. Secondary: `/download`.

## Visual identity — "Obsidian & Violet"

**Mode**: dark only. Simple near-black gray canvas; purple is the ONLY accent family. The page should feel glossy, cinematic, and restrained — glow lives in accents, never washes the background.

### Color
- Page background: `#0a0a0b` (near-black gray, no purple tint)
- Text: `#f5f3fa` primary · `#918d9c` secondary · `#bbb6c6` tertiary
- Hairlines: `rgba(255,255,255,0.08)` (soft: `0.05`)
- Accent family (strictly purple): `#8b5cf6` core · `#a78bfa` soft · `#c4b5fd` bright · `#6d28d9` deep · `#c084fc` orchid
- Warm flash (ONLY inside animated gradient headline words, never elsewhere): coral `#ff8a4c`, pink `#f472b6`, rose `#fda4af`
- Glass surfaces: `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.035))`

### Typography (slim, Apple-like)
- Family: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI", sans-serif`
- Display H1: clamp(46–108px), **weight 500**, tracking −0.04em, line-height 1.01
- Chapter H2: clamp(38–64px), weight 500, tracking −0.03em, white→#c3bcd4 gradient clip
- Card H3: 20–24px, weight 520, tracking −0.015em
- Body: 17px lede / 13.5px card copy, `#918d9c`
- Labels: 11–12px uppercase, letterspaced 0.08–0.22em
- Big stat numbers: 40–84px, **weight 400**, white→violet gradient clip + purple glow drop-shadow
- Mono accents (chips, captions): `ui-monospace, SFMono-Regular, Menlo`
- NEVER use heavy weights (>600), serifs, or decorative fonts.

### Shape, gloss, glow
- Radii: 7px chips · 20px cards · 28px stages/bento · 999px pill buttons
- Every glass card carries a gloss line: `inset 0 1px 0 rgba(255,255,255,0.07)` + 1px hairline border
- Glow is purple only: shadows `rgba(139,92,246, 0.1–0.6)`; ambient blooms = blurred radial ellipses at 0.16–0.2 alpha behind hero/closing only
- Screenshots: 28px radius, 1px `rgba(255,255,255,0.1)` border; hero screenshot fades to page via bottom mask

### Signature elements
- `.eyebrow`: tiny uppercase violet label with glowing 5px dot
- Mono chips (`01`, `INDEX`): violet text, violet-tinted bg + border, soft glow
- Primary CTA: purple gradient pill (`#9d74f8→#7c3aed`), white text, glow + animated shine sweep, hover lift
- Animated gradient words: violet-dominant gradient with a warm coral/pink band sweeping through on a 9s loop (hero line 2, closing line 2)
- Pulsing signal dots (5–7px, purple variants, staggered delays)
- Purple cursor-follow glow (600px radial, screen blend, subtle)

### Motion
- Scroll reveal: fade + 24px rise, 700ms `cubic-bezier(0.16,1,0.3,1)`, staggered via delay
- Micro: hover scale 1.01–1.015 on cards, 150–300ms transitions, dot pulses 2–2.8s
- Ambient: bloom-breathe 8–9s, gradient sheen 9s, button shine 5s
- Everything disabled under `prefers-reduced-motion`

### Layout
- Container: 1120px; spacious spacing scale (chapter padding 150px desktop / 104px mobile)
- Structure: full-width centered "chapters" — Exaggerated Minimalism + Apple bento grids
- No horizontal page scroll (intentional snap rails inside contained elements are allowed)

## Anti-patterns (never do)
- Light mode, colored backgrounds, or non-purple accent colors (except the gradient-word warm flash)
- Heavy font weights, emoji as icons, generic stock imagery
- Glow washes over large background areas; neon saturation
- Replacing the real product screenshots or the real Vector logo with placeholders
