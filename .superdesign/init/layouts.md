# Layout components — Vector marketing site
Three shared layout files wrap every marketing page (`/`, `/download`, `/download/checksums`).

### `packages/web/src/components/marketing/MarketingLayout.astro`

```astro
---
interface Props {
  title: string
  description: string
}

const { title, description } = Astro.props
const canonical = new URL(Astro.url.pathname, Astro.site ?? "https://vectordev.ai").toString()
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content={description} />
    <meta name="theme-color" content="#0a0a0b" />
    <link rel="canonical" href={canonical} />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/png" href="/favicon-32x32-desktop-v4.png" sizes="32x32" />
    <link rel="apple-touch-icon" href="/apple-touch-icon-desktop-v4.png" sizes="180x180" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Vector" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
    <meta property="og:image" content="https://vectordev.ai/vector-logo.png" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    <meta name="twitter:image" content="https://vectordev.ai/vector-logo.png" />
    <title>{title}</title>
  </head>
  <body>
    <slot />
  </body>
</html>

<style is:global>
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
</style>

```

### `packages/web/src/components/marketing/MarketingNav.astro`

```astro
---
interface Props {
  active?: "product" | "docs" | "download"
}

const { active = "product" } = Astro.props
---

<header class="site-nav">
  <div class="site-nav-inner">
    <a class="site-brand" href="/" aria-label="Vector home">
      <img src="/vector-logo.png" alt="" width="26" height="26" />
      <span>Vector</span>
    </a>

    <nav class="site-center" aria-label="Primary navigation">
      <a class:list={{ active: active === "product" }} href="/">Product</a>
      <a href="/#workflow">Workflow</a>
      <a href="/#intelligence">Intelligence</a>
      <a href="/#comparison">Compare</a>
      <a class:list={{ active: active === "docs" }} href="/docs">Docs</a>
    </nav>

    <a class:list={["download-link", { active: active === "download" }]} href="/download">Download</a>
  </div>
</header>

<style>
  .site-nav {
    width: 100%;
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(10, 10, 11, 0.68);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
  }

  .site-nav-inner {
    width: min(1120px, calc(100% - 48px));
    height: 52px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }

  .site-brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    color: var(--ink, #f5f3fa) !important;
    font-size: 15px;
    font-weight: 560;
    letter-spacing: 0.01em;
    text-decoration: none;
  }

  .site-brand img {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    filter: drop-shadow(0 0 10px rgba(139, 92, 246, 0.45));
    transition: filter 250ms ease;
  }

  .site-brand:hover img {
    filter: drop-shadow(0 0 16px rgba(139, 92, 246, 0.75));
  }

  .site-center {
    display: flex;
    align-items: center;
    gap: 28px;
  }

  .site-center a {
    color: var(--muted, #918d9c) !important;
    font-size: 12.5px;
    font-weight: 460;
    letter-spacing: 0.01em;
    text-decoration: none;
    transition: color 180ms ease;
  }

  .site-center a:hover,
  .site-center a.active {
    color: var(--ink, #f5f3fa) !important;
  }

  .download-link {
    padding: 7px 15px;
    color: #ffffff !important;
    background: linear-gradient(180deg, #9d74f8, #7c3aed);
    border: 1px solid rgba(196, 181, 253, 0.5);
    border-radius: 999px;
    box-shadow:
      0 0 14px rgba(139, 92, 246, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.25);
    font-size: 12.5px;
    font-weight: 560;
    text-decoration: none;
    transition: box-shadow 200ms ease, filter 200ms ease;
  }

  .download-link:hover,
  .download-link.active {
    box-shadow:
      0 0 24px rgba(139, 92, 246, 0.6),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);
    filter: brightness(1.06);
  }

  @media (max-width: 820px) {
    .site-center a:nth-child(2),
    .site-center a:nth-child(3),
    .site-center a:nth-child(4) {
      display: none;
    }
  }

  @media (max-width: 640px) {
    .site-nav-inner {
      width: min(100% - 28px, 1120px);
      height: 48px;
    }

    .site-center {
      gap: 16px;
    }
  }
</style>

```

### `packages/web/src/components/marketing/MarketingFooter.astro`

```astro
<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <img src="/vector-logo.png" alt="" width="24" height="24" />
      <div>
        <strong>Vector</strong>
        <span>Local-first AI engineering.</span>
      </div>
    </div>

    <nav aria-label="Footer navigation">
      <a href="/">Product</a>
      <a href="/docs">Documentation</a>
      <a href="/download">Downloads</a>
      <a href="/download/checksums">Checksums</a>
    </nav>
  </div>
  <p class="copyright">© 2026 Vector. Built for people who ship software.</p>
</footer>

<style>
  .site-footer {
    width: min(1120px, calc(100% - 48px));
    margin: 0 auto;
    padding: 42px 0 32px;
    position: relative;
    color: var(--muted, #918d9c);
  }

  .site-footer::before {
    height: 1px;
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    content: "";
    background: linear-gradient(
      90deg,
      transparent,
      rgba(139, 92, 246, 0.5) 30%,
      rgba(196, 181, 253, 0.45) 50%,
      rgba(139, 92, 246, 0.5) 70%,
      transparent
    );
  }

  .footer-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 32px;
  }

  .footer-brand {
    display: flex;
    align-items: center;
    gap: 11px;
  }

  .footer-brand img {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    filter: drop-shadow(0 0 10px rgba(139, 92, 246, 0.4));
  }

  .footer-brand div {
    display: grid;
    gap: 2px;
  }

  .footer-brand strong {
    color: var(--ink, #f5f3fa);
    font-size: 13px;
    font-weight: 560;
  }

  .footer-brand span,
  .copyright {
    font-size: 11.5px;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 24px;
  }

  nav a {
    color: inherit !important;
    font-size: 12px;
    font-weight: 440;
    text-decoration: none;
    transition: color 180ms ease;
  }

  nav a:hover {
    color: var(--accent-strong, #c4b5fd) !important;
  }

  .copyright {
    margin: 28px 0 0;
    color: #6e6a77;
  }

  @media (max-width: 700px) {
    .site-footer {
      width: min(100% - 28px, 1120px);
    }

    .footer-inner {
      align-items: flex-start;
      flex-direction: column;
    }

    nav {
      justify-content: flex-start;
      gap: 14px 20px;
    }
  }
</style>

```
