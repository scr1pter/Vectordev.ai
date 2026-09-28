import { Show, createMemo } from "solid-js"
import { TooltipV2 } from "@vectordevai/ui/v2/tooltip-v2"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionTokenTotal } from "@/components/session/session-context-metrics"
import { SPEND_TOOLTIP, capTooltip, lastAssistantModel, spendKind, spendPill } from "@/features/economics/format-spend"

/**
 * Live BYOK cost readout for the active session. It reads the aggregated `cost`
 * and `tokens` the backend records on every assistant message and, while a
 * capped run is going, the run guard's per-run figure from `session.spend`,
 * surfaced always-visible instead of hidden in a hover tooltip.
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
  // The guard keys a run by its root session, so a subagent's pill reads its root's run.
  const runID = createMemo(() => {
    const session = info()
    if (!session) return undefined
    if (sync().data.session_spend[session.id]) return session.id
    if (session.parentID && sync().data.session_spend[session.parentID]) return session.parentID
    return undefined
  })
  const kind = createMemo(() => {
    const model = lastAssistantModel(params.id ? (sync().data.message[params.id] ?? []) : [])
    return spendKind(providers.all(), model?.providerID, model?.modelID)
  })
  const pill = createMemo(() => {
    const id = runID()
    return spendPill({
      usd: cost(),
      tokens: tokens(),
      kind: kind(),
      run: id ? sync().data.session_spend[id] : undefined,
      running: id ? sync().data.session_working(id) : false,
    })
  })

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
              <span class="text-v2-text-text-base">{pill().session}</span>
            </div>
            <Show when={pill().run}>
              {(run) => (
                <div class="flex items-center justify-between gap-4">
                  <span class="text-v2-text-text-muted">This run</span>
                  <span class="text-v2-text-text-base">{run()}</span>
                </div>
              )}
            </Show>
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Tokens</span>
              <span class="text-v2-text-text-base">{tokens().toLocaleString(language.intl())}</span>
            </div>
            <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">{SPEND_TOOLTIP[pill().kind]}</div>
            <Show when={pill().capUsd} keyed>
              {(capUsd) => <div class="text-[11px] leading-4 text-v2-text-text-faint">{capTooltip(capUsd)}</div>}
            </Show>
          </div>
        }
      >
        <div
          data-component="session-cost-readout"
          data-state={pill().warn ? "warn" : undefined}
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--vx-line)] bg-white/[0.03] px-2.5 text-[11px] font-medium tabular-nums text-white/62 transition-colors duration-150 hover:border-[color:var(--vx-line)] hover:text-white/80"
        >
          <span classList={{ "text-[#a78bfa]": !pill().warn, "text-amber-300": pill().warn }}>{pill().label}</span>
          <span class="text-white/25">·</span>
          <span>{compactTokens()}</span>
        </div>
      </TooltipV2>
    </Show>
  )
}
