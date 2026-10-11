import { For, Show, createMemo, createSignal } from "solid-js"
import { TooltipV2 } from "@vectordevai/ui/v2/tooltip-v2"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createDelegatedSpend } from "@/components/session-delegated-spend"
import { compactTokens, formatSessionCost, sessionSpend, sessionTokens } from "@/utils/session-cost"

/**
 * Live BYOK cost readout for the active session. This is real spend — it reads
 * the aggregated `cost` and `tokens` the backend records on every assistant
 * message — surfaced always-visible instead of hidden in a hover tooltip.
 * Transparency about spend is the point of a bring-your-own-key workspace.
 * Work Vector ran for the session under the hood (a Vectorscope review,
 * autocomplete) and its subagents are part of the total, each named below it.
 */
export function SessionCostReadout() {
  const sync = useSync()
  const language = useLanguage()
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

  const spend = createMemo(() =>
    formatSessionCost({
      cost: cost(),
      unpricedSteps: unpriced(),
      format: (value) => usd().format(value),
      t: language.t,
    }),
  )

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
              <span class="text-v2-text-text-base">{spend()}</span>
            </div>
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
            <div class="pt-1 text-[11px] leading-4 text-v2-text-text-faint">Billed to your own provider key.</div>
          </div>
        }
      >
        <div
          data-component="session-cost-readout"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusIn={() => setHovered(true)}
          onFocusOut={() => setHovered(false)}
          class="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--vx-line)] bg-white/[0.03] px-2.5 text-[11px] font-medium tabular-nums text-white/62 transition-colors duration-150 hover:border-[color:var(--vx-line)] hover:text-white/80"
        >
          <span class="text-[#a78bfa]">{spend()}</span>
          <span class="text-white/25">·</span>
          <span>{compactTokens(tokens())}</span>
        </div>
      </TooltipV2>
    </Show>
  )
}
