import { Show, createMemo } from "solid-js"
import { TooltipV2 } from "@vectordevai/ui/v2/tooltip-v2"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionTokenTotal } from "@/components/session/session-context-metrics"
import {
  SPEND_TOOLTIP,
  capTooltip,
  formatSpend,
  formatUsd,
  lastAssistantModel,
  spendKind,
} from "@/features/economics/format-spend"

/**
 * Live BYOK cost readout for the active session. It reads the aggregated `cost`
 * and `tokens` the backend records on every assistant message, and the run
 * guard's cap from `session.spend`, surfaced always-visible instead of hidden
 * in a hover tooltip.
 */
export function SessionCostReadout() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const cost = createMemo(() => info()?.cost ?? 0)
  const tokens = createMemo(() => getSessionTokenTotal(info()?.tokens) ?? 0)
  // The guard keys a run by its root session, so a subagent's pill shows its root's cap.
  const spend = createMemo(() => {
    const session = info()
    if (!session) return undefined
    return sync().data.session_spend[session.id] ?? (session.parentID ? sync().data.session_spend[session.parentID] : undefined)
  })
  const kind = createMemo(() => {
    const model = lastAssistantModel(params.id ? (sync().data.message[params.id] ?? []) : [])
    return spendKind(providers.all(), model?.providerID, model?.modelID)
  })
  const label = createMemo(() => formatSpend({ usd: cost(), tokens: tokens(), kind: kind() }))
  // A cap is a dollar figure, so it only follows an amount, never "free" or "unpriced".
  const cap = createMemo(() => {
    const capUsd = spend()?.capUsd
    if (capUsd === undefined || !label().includes("$")) return ""
    return ` of ${formatUsd(capUsd)}`
  })
  const warn = createMemo(() => spend()?.state === "warn")

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
          <div class="flex w-[220px] flex-col gap-1.5">
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Session cost</span>
              <span class="text-v2-text-text-base">{label()}</span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Tokens</span>
              <span class="text-v2-text-text-base">{tokens().toLocaleString(language.intl())}</span>
            </div>
            <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">{SPEND_TOOLTIP[kind()]}</div>
            <Show when={spend()?.capUsd} keyed>
              {(capUsd) => <div class="text-[11px] leading-4 text-v2-text-text-faint">{capTooltip(capUsd)}</div>}
            </Show>
          </div>
        }
      >
        <div
          data-component="session-cost-readout"
          data-state={spend()?.state}
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--vx-line)] bg-white/[0.03] px-2.5 text-[11px] font-medium tabular-nums text-white/62 transition-colors duration-150 hover:border-[color:var(--vx-line)] hover:text-white/80"
        >
          <span classList={{ "text-[#a78bfa]": !warn(), "text-amber-300": warn() }}>
            {label()}
            {cap()}
          </span>
          <span class="text-white/25">·</span>
          <span>{compactTokens()}</span>
        </div>
      </TooltipV2>
    </Show>
  )
}
