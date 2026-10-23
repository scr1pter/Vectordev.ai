import { For, Show, createEffect, createMemo, createResource } from "solid-js"
import type { MemoryResearchSource, ResearchNote } from "@vectordevai/sdk/v2/client"
import { ResearchSignals } from "@vectordevai/core/research/signals"
import { useSDK } from "@/context/sdk"
import { PAYWALL, highlights, segments, statusLabel } from "./research-model"
import "./research.css"

/**
 * One source as Vector saved it (section 8.3): its text chunk by chunk, always as plain text, with the quotes its notes
 * rest on highlighted. A citation opens it at its note's quote. "Open in browser" loads the page in Preview.
 */
export function ResearchSourceViewer(props: {
  runID: string
  source: MemoryResearchSource
  notes: readonly ResearchNote[]
  /** The note a citation opened the viewer at. */
  focus?: string
  onBack: () => void
  onOpenInBrowser: (url: string) => void
}) {
  const sdk = useSDK()
  const [text] = createResource(
    () => ({ runID: props.runID, sourceID: props.source.id }),
    (input) =>
      sdk()
        .client.memory.research.source(input, { throwOnError: false })
        .then((result) => result.data),
  )
  const quotes = createMemo(() => props.notes.map((note) => note.quote))
  const focused = createMemo(() => props.notes.find((note) => note.id === props.focus))
  let root: HTMLDivElement | undefined

  // Opened from a citation: scroll to the first highlight of that note's quote once the text is in.
  createEffect(() => {
    const note = focused()
    if (!note || !text.latest || !root) return
    requestAnimationFrame(() => {
      const marks = [...(root?.querySelectorAll<HTMLElement>("mark") ?? [])]
      const words = note.quote.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase()
      const mark =
        marks.find((item) => item.textContent?.toLowerCase().replace(/\s+/g, " ").includes(words)) ?? marks[0]
      mark?.scrollIntoView({ block: "center" })
    })
  })

  return (
    <div data-component="research-viewer" ref={root}>
      <div data-component="research-card">
        <div data-slot="research-row">
          <button type="button" data-slot="research-button" onClick={props.onBack}>
            Back to sources
          </button>
          <Show when={/^https?:\/\//.test(props.source.url)}>
            <button type="button" data-slot="research-button" onClick={() => props.onOpenInBrowser(props.source.url)}>
              Open in browser
            </button>
          </Show>
        </div>
        <div>
          <div data-slot="research-source-head">
            <span data-slot="research-source-id">{props.source.id}</span>
            <span data-slot="research-source-title">{props.source.title || props.source.url}</span>
          </div>
          <div data-slot="research-muted">
            {props.source.site} · {statusLabel(props.source)}
          </div>
        </div>
        <Show when={props.source.signals}>
          {(signals) => (
            <div data-slot="research-row">
              <For each={ResearchSignals.labels(signals())}>
                {(label) => <span data-slot="research-tag">{label}</span>}
              </For>
            </div>
          )}
        </Show>
        <Show when={props.source.status === "paywalled"}>
          <div data-slot="research-notice">{PAYWALL}</div>
        </Show>
        <Show when={text.latest?.private}>
          <div data-slot="research-notice">
            Read from your own computer, network or signed-in browser, so it stays private like your documents.
          </div>
        </Show>
        <Show when={props.source.forgotten}>
          <div data-slot="research-notice">This page's text was forgotten since it was read.</div>
        </Show>
        <Show
          when={text.latest}
          fallback={<div data-slot="research-muted">{text.loading ? "Reading the saved text…" : "No saved text."}</div>}
        >
          {(saved) => (
            <For each={saved().chunks}>
              {(chunk) => (
                <div>
                  <div data-slot="research-muted">
                    Chunk {chunk.chunk}
                    {chunk.page ? ` · p.${chunk.page}` : ""}
                  </div>
                  <div data-slot="research-chunk">
                    <For each={segments(chunk.text, highlights(chunk.text, quotes()))}>
                      {(segment) => (segment.mark ? <mark>{segment.text}</mark> : segment.text)}
                    </For>
                  </div>
                </div>
              )}
            </For>
          )}
        </Show>
      </div>
    </div>
  )
}
