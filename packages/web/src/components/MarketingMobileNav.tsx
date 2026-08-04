import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"

type ActivePage = "product" | "docs" | "releases" | "download"

const links: Array<{ label: string; href: string; id: ActivePage }> = [
  { label: "Product", href: "/", id: "product" },
  { label: "Documentation", href: "/docs", id: "docs" },
  { label: "Releases", href: "/releases", id: "releases" },
  { label: "Download Vector", href: "/download", id: "download" },
]

export function MarketingMobileNav(props: { active: ActivePage }) {
  const [open, setOpen] = createSignal(false)
  let panel: HTMLDivElement | undefined

  createEffect(() => {
    document.documentElement.style.overflow = open() ? "hidden" : ""
    if (!open()) return
    panel?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  onCleanup(() => {
    document.documentElement.style.overflow = ""
  })

  return (
    <>
      <button
        type="button"
        class="mobile-nav-trigger"
        aria-label="Open navigation"
        aria-expanded={open()}
        onClick={() => setOpen(true)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="mobile-nav-overlay" onClick={() => setOpen(false)} aria-hidden="true" />
        <div
          class="mobile-nav-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Site navigation"
          tabIndex={-1}
          ref={panel}
        >
          <div class="mobile-nav-head">
            <strong>Navigate Vector</strong>
            <button type="button" class="mobile-nav-trigger" aria-label="Close navigation" onClick={() => setOpen(false)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
          <p class="mobile-nav-copy">
            Product details, practical documentation, and installers for every supported desktop platform.
          </p>
          <nav class="mobile-nav-links" aria-label="Mobile navigation">
            <For each={links}>
              {(link) => (
                <a
                  href={link.href}
                  aria-current={props.active === link.id ? "page" : undefined}
                  class={props.active === link.id ? "current" : undefined}
                >
                  {link.label}
                </a>
              )}
            </For>
          </nav>
          <p class="mobile-nav-foot">
            Vector is a local-first AI engineering workspace for building, testing, reviewing, and shipping software.
          </p>
        </div>
      </Show>
    </>
  )
}
