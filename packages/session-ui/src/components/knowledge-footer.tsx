import type { Part as PartType } from "@vectordevai/sdk/v2"
import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useI18n } from "@vectordevai/ui/context/i18n"
import { Icon } from "@vectordevai/ui/v2/icon"
import { useData } from "../context"
import { recallOf, used, type KnowledgeCard } from "./knowledge-citations"

// A turn's "Used from memory" footer: what recall put in its request, collapsed to one line ("3 document cards (API
// spec p.14, p.22; SLA §2), 1 lesson · 214 tokens"), and, opened, each item with why Vector chose it. The transcript
// holds ids only, so names and lines come from the owner's engine; documents are named at once, memory entries when
// the footer is opened.
export function KnowledgeFooter(props: { parts: readonly PartType[] }) {
  const data = useData()
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const recall = createMemo(() => props.parts.map(recallOf).find((item) => item !== undefined && item.ids.length > 0))
  const [cards] = createResource(
    () => {
      const current = recall()
      if (!current || !data.knowledge) return false
      const ids = open() ? current.ids : current.cards
      return ids.length > 0 ? ids.join(",") : false
    },
    (ids) =>
      data.knowledge!(ids.split(","))
        .then((found) => new Map(found.map((card) => [card.id, card] as const)))
        .catch(() => new Map<string, KnowledgeCard>()),
  )
  const summary = createMemo(() => {
    const current = recall()
    return current ? used(current, cards.latest ?? new Map()) : undefined
  })

  return (
    <Show when={summary()}>
      {(value) => (
        <div data-component="knowledge-footer" data-open={open() ? "" : undefined}>
          <button
            type="button"
            data-slot="knowledge-footer-trigger"
            aria-expanded={open()}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="chevron-down" data-slot="knowledge-footer-chevron" />
            <span data-slot="knowledge-footer-label">{i18n.t("ui.knowledge.used")}</span>
            <span data-slot="knowledge-footer-summary">{value().summary}</span>
          </button>
          <Show when={open()}>
            <ul data-slot="knowledge-footer-items">
              <For each={value().items}>
                {(item) => (
                  <li data-slot="knowledge-footer-item">
                    <div data-slot="knowledge-footer-item-head">
                      <span data-slot="knowledge-footer-id">{item.id}</span>
                      <span data-slot="knowledge-footer-item-label">{item.label}</span>
                    </div>
                    <Show when={item.text}>
                      <p data-slot="knowledge-footer-text">{item.text}</p>
                    </Show>
                    <p data-slot="knowledge-footer-reason">{item.reason}</p>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      )}
    </Show>
  )
}
