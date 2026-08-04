import { useNavigate } from "@solidjs/router"
import { For } from "solid-js"
import { VectorAsciiField } from "@/components/vector-ascii-field"

type Product = {
  id: "code" | "work" | "cloud"
  name: string
  eyebrow: string
  description: string
  detail: string
  href: string
}

const products: Product[] = [
  {
    id: "code",
    name: "Vector Code",
    eyebrow: "Build software",
    description: "Code beside one agent or coordinate an isolated team.",
    detail: "Editor, terminal, browser, review, MCP and parallel workspaces.",
    href: "/code",
  },
  {
    id: "work",
    name: "Vector Work",
    eyebrow: "Run projects",
    description: "Turn outcomes into tasks that agents can execute together.",
    detail: "Optional repository context, approvals, browser work and integrations.",
    href: "/work",
  },
  {
    id: "cloud",
    name: "Vector Cloud",
    eyebrow: "Ship and operate",
    description: "Connect a project, deploy it and manage its runtime.",
    detail: "Deployments, domains, environment, databases and observability.",
    href: "/cloud",
  },
]

const ProductIcon = (props: { id: Product["id"] }) => {
  if (props.id === "work") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6.5h6l1.5 2H20v9H4v-11Z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round" />
        <path d="M8 13h8M12 10v6" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
      </svg>
    )
  }
  if (props.id === "cloud") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.2 18.2a4 4 0 0 1-.4-7.95 5.1 5.1 0 0 1 9.85-1.7 3.8 3.8 0 0 1 .75 7.55" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
        <path d="M12 12v6m0 0 2.2-2.2M12 18l-2.2-2.2" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 7-5 5 5 5m6-10 5 5-5 5m-1.5-13-3 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

export function ProductHome() {
  const navigate = useNavigate()

  return (
    <main data-vector-product-home class="relative min-h-0 flex-1 self-stretch overflow-hidden bg-[var(--vx-stage)] text-white">
      <VectorAsciiField />
      <div class="vector-product-home__veil" aria-hidden="true" />
      <div class="vector-product-home__content">
        <header class="vector-product-home__header">
          <div class="vector-product-home__identity">
            <img src="/vector-logo.png" alt="" draggable={false} />
            <span>Vector</span>
          </div>
          <button type="button" class="vector-product-home__vel" onClick={() => window.dispatchEvent(new CustomEvent("vector:vel-open"))}>
            <span aria-hidden="true" />
            Talk to Vel
          </button>
        </header>

        <section class="vector-product-home__intro">
          <p>Your AI-native workspace</p>
          <h1>Welcome to Vector.</h1>
          <h2>How would you like to start today?</h2>
        </section>

        <section class="vector-product-home__products" aria-label="Choose a Vector product">
          <For each={products}>
            {(product) => (
              <button type="button" class="vector-product-card" data-product={product.id} onClick={() => navigate(product.href)}>
                <span class="vector-product-card__icon"><ProductIcon id={product.id} /></span>
                <span class="vector-product-card__eyebrow">{product.eyebrow}</span>
                <strong>{product.name}</strong>
                <span class="vector-product-card__description">{product.description}</span>
                <small>{product.detail}</small>
                <span class="vector-product-card__action">
                  Open {product.name.replace("Vector ", "")}
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9m-3.2-3.2L12 8l-3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
              </button>
            )}
          </For>
        </section>

        <footer class="vector-product-home__footer">
          <span><i /> Local runtime ready</span>
          <span>Your projects and credentials stay under your control.</span>
        </footer>
      </div>
    </main>
  )
}
