import { For, Show, createMemo, createSignal } from "solid-js"
import { TooltipV2 } from "@vectordevai/ui/v2/tooltip-v2"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createDelegatedSpend } from "@/components/session-delegated-spend"
import { compactTokens, formatSessionCost, sessionSpend, sessionTokens } from "@/utils/session-cost"
import {
  SPEND_TOOLTIP,
  capTooltip,
  lastAssistantModel,
  sessionReading,
  spendKind,
  spendPill,
} from "@/features/economics/format-spend"

/**
 * Live cost readout for the active session. It reads the aggregated `cost` and
 * `tokens` the backend records on every assistant message and, while a capped
 * run is going, the run guard's per-run figure from `session.spend`, surfaced
 * always-visible instead of hidden in a hover tooltip. Work Vector ran for the
 * session under the hood (a Vectorscope review, autocomplete) and its subagents
 * are part of the total, each named below it.
 */
export function SessionCostReadout() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  // The task's spend, so a session that delegated most of its work does not read as cheap.
  const cost = createMemo(() => sessionSpend(info()).cost)
  const unpriced = createMemo(() => sessionSpend(info()).unpricedSteps)
  const tokens = createMemo(() => sessionTokens(info()))
  const [hovered, setHovered] = createSignal(false)
  const delegated = createDelegatedSpend(info, hovered)

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cost() > 0 && cost() < 0.01 ? 4 : 2,
        maximumFractionDigits: 4,
      }),
  )

  // The guard keys a run by its root session, so a subagent's pill reads its root's run.
  const runID = createMemo(() => {
    const session = info()
    if (!session) return undefined
    if (sync().data.session_spend[session.id]) return session.id
    if (session.parentID && sync().data.session_spend[session.parentID]) return session.parentID
    return undefined
  })
  const pill = createMemo(() => {
    const model = lastAssistantModel(params.id ? (sync().data.message[params.id] ?? []) : [])
    const id = runID()
    return spendPill({
      session: sessionReading({
        cost: cost(),
        unpricedSteps: unpriced(),
        tokens: tokens(),
        kind: spendKind(providers.all(), model?.providerID, model?.modelID),
        format: (value) => usd().format(value),
        t: language.t,
      }),
      run: id ? sync().data.session_spend[id] : undefined,
      running: id ? sync().data.session_working(id) : false,
    })
  })

  // Each helper by name, then whatever the subagents spent.
  const parts = createMemo(() => [
    ...delegated().helpers,
    ...(delegated().subagents
      ? [{ label: delegated().split ? "Subagents" : "Subagents and helpers", ...delegated().subagents! }]
      : []),
  ])
  const partText = (part: { cost: number; unpricedSteps: number; tokens: number }) =>
    `${formatSessionCost({
      cost: part.cost,
      unpricedSteps: part.unpricedSteps,
      format: (value) => usd().format(value),
      t: language.t,
    })} · ${compactTokens(part.tokens)}`

  // Only appears once the session has actually spent something.
  return (
    <Show when={params.id && (cost() > 0 || tokens() > 0)}>
      <TooltipV2
        placement="bottom"
        value={
          <div class="flex w-[230px] flex-col gap-1.5">
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Session cost</span>
              <span class="text-v2-text-text-base">{pill().session}</span>
            </div>
            <Show when={pill().run}>
              {(run) => (
                <div data-slot="session-cost-run" class="flex items-center justify-between gap-4">
                  <span class="text-v2-text-text-muted">This run</span>
                  <span class="text-v2-text-text-base">{run()}</span>
                </div>
              )}
            </Show>
            <div class="flex items-center justify-between gap-4">
              <span class="text-v2-text-text-muted">Tokens</span>
              <span class="text-v2-text-text-base">{tokens().toLocaleString(language.intl())}</span>
            </div>
            <Show when={parts().length > 0}>
              <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">Of which</div>
              <For each={parts()}>
                {(part) => (
                  <div data-slot="session-cost-part" class="flex items-center justify-between gap-4">
                    <span class="truncate text-v2-text-text-muted">{part.label}</span>
                    <span class="shrink-0 text-v2-text-text-base">{partText(part)}</span>
                  </div>
                )}
              </For>
            </Show>
            <Show when={unpriced() > 0}>
              <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">
                {language.t("session.cost.unpricedNote")}
              </div>
            </Show>
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
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusIn={() => setHovered(true)}
          onFocusOut={() => setHovered(false)}
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--vx-line)] bg-white/[0.03] px-2.5 text-[11px] font-medium tabular-nums text-white/62 transition-colors duration-150 hover:border-[color:var(--vx-line)] hover:text-white/80"
        >
          <span classList={{ "text-[#a78bfa]": !pill().warn, "text-[color:var(--vx-amber)]": pill().warn }}>
            {pill().label}
          </span>
          <span class="text-white/25">·</span>
          <span>{compactTokens(tokens())}</span>
        </div>
      </TooltipV2>
    </Show>
  )
}
