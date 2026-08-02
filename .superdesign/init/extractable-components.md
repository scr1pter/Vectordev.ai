# Extractable components

#### Layout Components

## NavBar
- Source: `packages/web/src/components/marketing/MarketingNav.astro`
- Category: layout
- Description: Sticky frosted-glass top nav — logo+wordmark left, center links (Product/Workflow/Intelligence/Compare/Docs), purple gradient pill Download button right.
- Extractable props: activeItem (string, default: "product")
- Hardcoded: logo `/vector-logo.png`, link labels/hrefs, all CSS.

## Footer
- Source: `packages/web/src/components/marketing/MarketingFooter.astro`
- Category: layout
- Description: Purple gradient hairline top, brand block left, 4 links right, copyright line.
- Extractable props: none (static)
- Hardcoded: logo, links, copy, all CSS.

#### Basic Components
None extractable — buttons/chips/cards are CSS pattern classes inside `Lander.astro` (see `components.md`), too simple to warrant extraction.
