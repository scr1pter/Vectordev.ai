import { createEffect, createMemo, on, onCleanup, For } from "solid-js"
import type { JSX } from "solid-js"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSync } from "@/context/sync"
import { same } from "@/utils/same"
import { getSessionContext, getSessionTokenTotal } from "./session-context-metrics"
import { createSessionContextFormatter } from "./session-context-format"

const emptyMessages: Message[] = []

function Metric(props: { label: string; value: JSX.Element; detail?: JSX.Element }) {
  return (
    <div class="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3">
      <div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/38">{props.label}</div>
      <div class="mt-2 text-sm font-semibold text-white">{props.value}</div>
      {props.detail && <div class="mt-1 text-xs leading-5 text-white/42">{props.detail}</div>}
    </div>
  )
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

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return { all: all.length, user, assistant }
  })

  const metrics = createMemo(() => [
    {
      label: "Model",
      value: () => ctx()?.modelLabel ?? "-",
      detail: () => ctx()?.providerLabel ?? "No model selected",
    },
    {
      label: "Context used",
      value: () => formatter().percent(ctx()?.usage),
      detail: () => `${formatter().number(getSessionTokenTotal(tokens()))} total tokens`,
    },
    {
      label: "Limit",
      value: () => formatter().number(ctx()?.limit),
      detail: () => "Current model window",
    },
    {
      label: "Cost",
      value: () => usd().format(info()?.cost ?? 0),
      detail: () => "Estimated for this task",
    },
  ])

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
      <div class="flex flex-col gap-4 p-5">
        <section class="rounded-2xl border border-white/[0.08] bg-[#171719] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#b99aff]">Context window</div>
              <h3 class="mt-2 text-lg font-semibold text-white">Task memory</h3>
              <p class="mt-1 max-w-[380px] text-sm leading-6 text-white/50">
                A quick view of the room Vector has left for this task.
              </p>
            </div>
            <div class="rounded-full border border-[#9b6cff]/30 bg-[#9b6cff]/12 px-3 py-1 text-xs font-semibold text-[#d6c5ff]">
              {formatter().percent(ctx()?.usage)}
            </div>
          </div>
          <div class="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              class="h-full rounded-full bg-gradient-to-r from-[#7f55ff] to-[#c7adff]"
              style={{ width: `${usage()}%` }}
            />
          </div>
        </section>

        <div class="grid grid-cols-1 gap-3 @[30rem]:grid-cols-2">
          <For each={metrics()}>
            {(metric) => <Metric label={metric.label} value={metric.value()} detail={metric.detail()} />}
          </For>
        </div>

        <section class="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-5">
          <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/38">Recent activity</div>
          <div class="mt-3 text-sm leading-6 text-white/62">
            {counts().user.toLocaleString(language.intl())} user prompts,{" "}
            {counts().assistant.toLocaleString(language.intl())} Vector replies,{" "}
            {counts().all.toLocaleString(language.intl())} total messages.
          </div>
          <div class="mt-3 text-xs leading-5 text-white/38">
            This panel intentionally hides raw prompt internals. Use it to decide whether a task needs a fresh session or
            a smaller file selection.
          </div>
        </section>
      </div>
    </ScrollView>
  )
}
