import { createEffect, createMemo, createResource, on, onCleanup, For, Show } from "solid-js"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSync } from "@/context/sync"
import { same } from "@/utils/same"
import { listOutcomes } from "@/features/economics/economics-repository"
import { estimateCostForTokens } from "@/features/economics/model-pricing"
import { categorizeTask } from "@/features/economics/task-categorizer"
import type { ModelOutcome } from "@/features/economics/economics-types"
import { getSessionContext, getSessionTokenTotal } from "./session-context-metrics"
import { createSessionContextFormatter } from "./session-context-format"

const emptyMessages: Message[] = []

function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// Ranks recorded outcomes for one task category exactly like the recommender:
// tournament win rate first, then check-pass rate, then median latency.
function rankModelsForCategory(outcomes: ModelOutcome[], category: ModelOutcome["category"], promptTokens: number) {
  const matching = outcomes.filter((outcome) => outcome.category === category)
  const groups = new Map<string, ModelOutcome[]>()
  for (const outcome of matching) {
    const key = `${outcome.provider}::${outcome.model}`
    const list = groups.get(key) ?? []
    list.push(outcome)
    groups.set(key, list)
  }
  return [...groups.values()]
    .map((list) => {
      const checked = list.filter((outcome) => outcome.hadChecks && outcome.checksPassed !== undefined)
      const checkPassRate = checked.length
        ? checked.filter((outcome) => outcome.checksPassed === true).length / checked.length
        : undefined
      return {
        provider: list[0].provider,
        model: list[0].model,
        sampleSize: list.length,
        checkPassRate,
        medianLatencyMs: medianOf(list.map((outcome) => outcome.latencyMs)),
        cost: estimateCostForTokens(list[0].model, promptTokens),
      }
    })
    .sort((a, b) => {
      const passDiff = (b.checkPassRate ?? -1) - (a.checkPassRate ?? -1)
      if (passDiff !== 0) return passDiff
      return a.medianLatencyMs - b.medianLatencyMs
    })
}

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )
  const ctx = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const tokens = createMemo(() => info()?.tokens)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const usage = createMemo(() => Math.max(0, Math.min(100, ctx()?.usage ?? 0)))
  const totalTokens = createMemo(() => getSessionTokenTotal(tokens()) ?? 0)

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return { all: all.length, user, assistant }
  })

  // Model economics: rank the models Vector has verified for this task's
  // category, learned from real parallel-workspace outcomes.
  const [economicsOutcomes] = createResource(
    () => sdk().directory,
    (directory) => listOutcomes(directory),
  )
  const taskCategory = createMemo(() => categorizeTask(info()?.title ?? ""))
  const modelEconomics = createMemo(() => rankModelsForCategory(economicsOutcomes() ?? [], taskCategory(), totalTokens()))
  const formatPercent = (value: number | undefined) =>
    value === undefined ? "-" : `${Math.round(value * 100)}%`
  const formatLatency = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

  const ledger = createMemo(() => [
    {
      label: "Session",
      value: info()?.title || "Untitled project",
    },
    {
      label: "Messages",
      value: formatter().number(counts().all),
    },
    {
      label: "Provider",
      value: ctx()?.providerLabel ?? "No provider selected",
    },
    {
      label: "Model",
      value: ctx()?.modelLabel ?? "No model selected",
    },
    {
      label: "Context limit",
      value: formatter().number(ctx()?.limit),
    },
    {
      label: "Total tokens",
      value: formatter().number(totalTokens()),
    },
    {
      label: "Usage",
      value: formatter().percent(ctx()?.usage),
    },
    {
      label: "Input tokens",
      value: formatter().number(tokens()?.input),
    },
    {
      label: "Output tokens",
      value: formatter().number(tokens()?.output),
    },
    {
      label: "Reasoning tokens",
      value: formatter().number(tokens()?.reasoning),
    },
    {
      label: "Cache tokens (read/write)",
      value: `${formatter().number(tokens()?.cache.read)} / ${formatter().number(tokens()?.cache.write)}`,
    },
    {
      label: "User messages",
      value: formatter().number(counts().user),
    },
    {
      label: "Assistant messages",
      value: formatter().number(counts().assistant),
    },
    {
      label: "Total cost",
      value: usd().format(info()?.cost ?? 0),
    },
    {
      label: "Session created",
      value: formatter().time(info()?.time.created),
    },
    {
      label: "Last activity",
      value: formatter().time(info()?.time.updated ?? info()?.time.created),
    },
  ])

  const breakdown = createMemo(() => {
    const values = [
      { label: "Input", value: tokens()?.input ?? 0, color: "#72e2a5" },
      { label: "Output", value: tokens()?.output ?? 0, color: "#ffb49d" },
      { label: "Reasoning", value: tokens()?.reasoning ?? 0, color: "#ffd27d" },
      {
        label: "Cache",
        value: (tokens()?.cache.read ?? 0) + (tokens()?.cache.write ?? 0),
        color: "#bfa9ff",
      },
    ]
    const total = values.reduce((sum, item) => sum + item.value, 0)
    return values.map((item) => ({
      ...item,
      percentage: total ? (item.value / total) * 100 : 0,
    }))
  })

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll
    if (!el) return
    const saved = view().scroll("context")
    if (!saved) return
    if (el.scrollTop !== saved.y) el.scrollTop = saved.y
    if (el.scrollLeft !== saved.x) el.scrollLeft = saved.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      const next = pending
      pending = undefined
      if (!next) return
      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => requestAnimationFrame(restoreScroll),
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="flex flex-col gap-4 p-4 @[34rem]:p-5">
        <section class="overflow-hidden rounded-lg border border-[color:var(--vx-line)] bg-[#151517] shadow-[0_16px_44px_rgba(0,0,0,0.2)]">
          <div class="flex items-start justify-between gap-4 border-b border-[color:var(--vx-line)] px-5 py-4">
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#b99aff]">Context window</div>
              <h3 class="mt-1.5 text-base font-semibold" style={{ color: "#fff" }}>
                Live task ledger
              </h3>
              <p class="mt-1 max-w-[430px] text-xs leading-5 text-white/45">
                Model, message, token, and cost totals for this task only.
              </p>
            </div>
            <div class="flex min-w-[72px] flex-col items-end">
              <strong class="text-sm font-semibold text-[#d6c5ff]">{formatter().percent(ctx()?.usage)}</strong>
              <span class="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/32">in context</span>
            </div>
          </div>
          <div class="h-1 bg-white/[0.06]">
            <div class="h-full bg-[#9b78ff] transition-[width] duration-200" style={{ width: `${usage()}%` }} />
          </div>

          <div class="grid grid-cols-1 @[28rem]:grid-cols-2">
            <For each={ledger()}>
              {(item) => (
                <div class="min-w-0 border-b border-[color:var(--vx-line)] px-5 py-3.5 last:border-b-0 @[28rem]:odd:border-r">
                  <div class="text-xs text-white/35">{item.label}</div>
                  <div
                    class="mt-1.5 min-w-0 break-words text-sm font-medium leading-5 text-white/88"
                    title={item.value}
                  >
                    {item.value}
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="px-5 py-4">
            <div class="text-xs text-white/35">Context breakdown</div>
            <div class="mt-3 flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
              <For each={breakdown()}>
                {(segment) => (
                  <span
                    class="h-full transition-[width] duration-200"
                    style={{ width: `${segment.percentage}%`, "background-color": segment.color }}
                    title={`${segment.label}: ${formatter().number(segment.value)} tokens`}
                  />
                )}
              </For>
            </div>
            <div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
              <For each={breakdown()}>
                {(segment) => (
                  <span class="flex items-center gap-1.5 text-xs text-white/38">
                    <i class="size-2 rounded-full" style={{ "background-color": segment.color }} />
                    {segment.label} {segment.percentage.toFixed(1)}%
                  </span>
                )}
              </For>
            </div>
          </div>
        </section>

        <section class="rounded-lg border border-[color:var(--vx-line)] bg-white/[0.025] p-5">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/38">Model economics</div>
            <div class="rounded-full border border-[#9b6cff]/30 bg-[#9b6cff]/12 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#d6c5ff]">
              {taskCategory()}
            </div>
          </div>
          <Show
            when={modelEconomics().length > 0}
            fallback={
              <div class="mt-3 text-xs leading-5 text-white/38">
                No verified runs yet for this task type. As you run agents and their checks pass or fail, Vector learns
                which model performs best here.
              </div>
            }
          >
            <div class="mt-4 flex flex-col gap-2">
              <For each={modelEconomics()}>
                {(row) => (
                  <div class="rounded-md border border-[color:var(--vx-line)] bg-white/[0.025] px-4 py-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="min-w-0 truncate text-sm font-semibold text-white">{row.model}</div>
                      <div class="shrink-0 text-xs text-white/42">{row.provider}</div>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/55">
                      <span>{row.sampleSize} run{row.sampleSize === 1 ? "" : "s"}</span>
                      <span>checks {formatPercent(row.checkPassRate)}</span>
                      <span>median {formatLatency(row.medianLatencyMs)}</span>
                      <span>{row.cost ? `~${usd().format(row.cost.estimatedTotalCost)}` : "cost unknown"}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
    </ScrollView>
  )
}
