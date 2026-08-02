import { Show, createMemo } from "solid-js"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionTokenTotal } from "@/components/session/session-context-metrics"

/**
 * Live BYOK cost readout for the active session. This is real spend — it reads
 * the aggregated `cost` and `tokens` the backend records on every assistant
 * message — surfaced always-visible instead of hidden in a hover tooltip.
 * Transparency about spend is the point of a bring-your-own-key workspace.
 */
export function SessionCostReadout() {
  const sync = useSync()
  const language = useLanguage()
  const { params } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const cost = createMemo(() => info()?.cost ?? 0)
  const tokens = createMemo(() => getSessionTokenTotal(info()?.tokens) ?? 0)

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cost() > 0 && cost() < 0.01 ? 4 : 2,
        maximumFractionDigits: 4,
      }),
  )

  const compactTokens = createMemo(() => {
    const value = tokens()
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
    return String(value)
  })

  // Only appears once the session has actually spent something.
  return (
    <Show when={params.id && (cost() > 0 || tokens() > 0)}>
      <TooltipV2
        placement="bottom"
        value={
          <div class="flex w-[150px] flex-col gap-1.5">
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Session cost</span>
              <span class="text-v2-text-text-base">{usd().format(cost())}</span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Tokens</span>
              <span class="text-v2-text-text-base">{tokens().toLocaleString(language.intl())}</span>
            </div>
            <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">Billed to your own provider key.</div>
          </div>
        }
      >
        <div
          data-component="session-cost-readout"
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--vx-line)] bg-white/[0.03] px-2.5 text-[11px] font-medium tabular-nums text-white/62 transition-colors duration-150 hover:border-[color:var(--vx-line)] hover:text-white/80"
        >
          <span class="text-[#a78bfa]">{usd().format(cost())}</span>
          <span class="text-white/25">·</span>
          <span>{compactTokens()}</span>
        </div>
      </TooltipV2>
    </Show>
  )
}
