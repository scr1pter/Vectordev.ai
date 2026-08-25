import { createMemo, createSignal, For, onMount, Show } from "solid-js"

// The tracker your team already runs on, read into Vector so a ticket can be
// handed to an agent whole — description, labels and the comments where the
// real detail usually lives — instead of being retyped into a prompt.

export type WorkItem = {
  id: string
  provider: "github" | "linear" | "jira"
  key: string
  title: string
  body: string
  url: string
  state: string
  status: "todo" | "in-progress" | "review" | "done"
  assignee?: string
  labels: string[]
  updatedAt: string
  comments: { author: string; text: string }[]
  brief: string
}

type WorkItemsApi = {
  list: (cwd: string) => Promise<{ items: WorkItem[]; problems: { provider: string; message: string }[] }>
  config: () => Promise<{ linear: boolean; jira: boolean; jiraSite?: string }>
  saveConfig: (next: {
    linear?: { token: string }
    jira?: { site: string; email: string; token: string; jql?: string }
  }) => Promise<{ linear: boolean; jira: boolean; jiraSite?: string }>
  clear: (provider: "linear" | "jira") => Promise<{ linear: boolean; jira: boolean; jiraSite?: string }>
}

function api(): WorkItemsApi | undefined {
  return (globalThis.window as unknown as { api?: { workItems?: WorkItemsApi } } | undefined)?.api?.workItems
}

const GROUPS = [
  { id: "in-progress", label: "In progress" },
  { id: "review", label: "In review" },
  { id: "todo", label: "To do" },
  { id: "done", label: "Done" },
] as const

const PROVIDER_LABEL: Record<WorkItem["provider"], string> = {
  github: "GitHub",
  linear: "Linear",
  jira: "Jira",
}

export function WorkInbox(props: {
  open: boolean
  sourcePath: string
  onClose: () => void
  onStartAgent: (item: WorkItem) => void | Promise<void>
}) {
  const [items, setItems] = createSignal<WorkItem[]>([])
  const [problems, setProblems] = createSignal<{ provider: string; message: string }[]>([])
  const [config, setConfig] = createSignal<{ linear: boolean; jira: boolean; jiraSite?: string }>()
  const [busy, setBusy] = createSignal(false)
  const [handing, setHanding] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [connecting, setConnecting] = createSignal<"linear" | "jira" | "">("")
  const [linearToken, setLinearToken] = createSignal("")
  const [jira, setJira] = createSignal({ site: "", email: "", token: "", jql: "" })

  const refresh = async () => {
    const bridge = api()
    if (!bridge || busy()) return
    setBusy(true)
    const [listed, settings] = await Promise.all([
      bridge.list(props.sourcePath).catch(() => undefined),
      bridge.config().catch(() => undefined),
    ])
    setBusy(false)
    if (listed) {
      setItems(listed.items)
      setProblems(listed.problems)
    }
    if (settings) setConfig(settings)
  }

  onMount(() => void refresh())

  const visible = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return items()
    return items().filter((item) =>
      `${item.key} ${item.title} ${item.labels.join(" ")} ${item.assignee ?? ""}`.toLowerCase().includes(needle),
    )
  })

  const hand = async (item: WorkItem) => {
    if (handing()) return
    setHanding(item.id)
    await props.onStartAgent(item)
    setHanding("")
  }

  const saveLinear = async () => {
    const bridge = api()
    if (!bridge || !linearToken().trim()) return
    setConfig(await bridge.saveConfig({ linear: { token: linearToken().trim() } }))
    setLinearToken("")
    setConnecting("")
    void refresh()
  }

  const saveJira = async () => {
    const bridge = api()
    const value = jira()
    if (!bridge || !value.site.trim() || !value.email.trim() || !value.token.trim()) return
    setConfig(
      await bridge.saveConfig({
        jira: {
          site: value.site.trim(),
          email: value.email.trim(),
          token: value.token.trim(),
          jql: value.jql.trim() || undefined,
        },
      }),
    )
    setJira({ site: "", email: "", token: "", jql: "" })
    setConnecting("")
    void refresh()
  }

  const disconnect = async (provider: "linear" | "jira") => {
    const bridge = api()
    if (!bridge) return
    setConfig(await bridge.clear(provider))
    void refresh()
  }

  return (
    <Show when={props.open}>
      <div
        data-vector-work-inbox
        role="dialog"
        aria-modal="true"
        aria-label="Work"
        class="fixed inset-0 z-[90] flex flex-col bg-[color:var(--vx-canvas)]"
      >
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] px-5">
          <span class="text-[13.5px] font-semibold text-white">Work</span>
          <span class="text-[12.5px] text-white/40">
            {items().length === 1 ? "1 item" : `${items().length} items`}
          </span>
          <input
            class="ml-3 h-8 w-64 rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-2.5 text-[12.5px] text-white/85 outline-none placeholder:text-white/30"
            placeholder="Search tickets"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="flex-1" />
          <button
            type="button"
            class="rounded-[8px] border border-[color:var(--vx-line)] px-3 py-1.5 text-[12px] text-white/60 transition hover:text-white"
            disabled={busy()}
            onClick={() => void refresh()}
          >
            {busy() ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            aria-label="Close work"
            class="grid size-8 place-items-center rounded-[8px] text-white/45 transition hover:bg-white/[0.06] hover:text-white"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div class="mx-auto w-full max-w-[900px]">
            <For each={problems()}>
              {(problem) => (
                <div class="mb-3 rounded-[10px] border border-amber-400/35 bg-amber-400/[0.06] px-3.5 py-2.5 text-[12.5px] text-amber-100/90">
                  <span class="font-medium">{PROVIDER_LABEL[problem.provider as WorkItem["provider"]] ?? problem.provider}</span>{" "}
                  could not be read — {problem.message}
                </div>
              )}
            </For>

            <div class="mb-6 flex flex-wrap items-center gap-2">
              <Show
                when={config()?.linear}
                fallback={
                  <button
                    type="button"
                    class="rounded-[8px] border border-[color:var(--vx-line)] px-3 py-1.5 text-[12px] text-white/60 transition hover:text-white"
                    onClick={() => setConnecting(connecting() === "linear" ? "" : "linear")}
                  >
                    Connect Linear
                  </button>
                }
              >
                <span class="flex items-center gap-2 rounded-[8px] border border-emerald-400/30 px-3 py-1.5 text-[12px] text-emerald-200/85">
                  Linear connected
                  <button type="button" class="text-white/40 transition hover:text-white" onClick={() => void disconnect("linear")}>
                    Disconnect
                  </button>
                </span>
              </Show>

              <Show
                when={config()?.jira}
                fallback={
                  <button
                    type="button"
                    class="rounded-[8px] border border-[color:var(--vx-line)] px-3 py-1.5 text-[12px] text-white/60 transition hover:text-white"
                    onClick={() => setConnecting(connecting() === "jira" ? "" : "jira")}
                  >
                    Connect Jira
                  </button>
                }
              >
                <span class="flex items-center gap-2 rounded-[8px] border border-emerald-400/30 px-3 py-1.5 text-[12px] text-emerald-200/85">
                  Jira connected
                  <button type="button" class="text-white/40 transition hover:text-white" onClick={() => void disconnect("jira")}>
                    Disconnect
                  </button>
                </span>
              </Show>

              <span class="text-[11.5px] text-white/35">
                GitHub issues come from your own <span class="font-mono">gh</span> sign-in — nothing to connect.
              </span>
            </div>

            <Show when={connecting() === "linear"}>
              <div class="mb-6 rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.025] p-4">
                <p class="mb-2 text-[12.5px] text-white/60">
                  Create a personal API key in Linear under Settings → Security &amp; access → Personal API keys.
                </p>
                <input
                  type="password"
                  class="w-full rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.045] px-3 py-2 text-[13.5px] text-white outline-none"
                  placeholder="lin_api_…"
                  value={linearToken()}
                  onInput={(event) => setLinearToken(event.currentTarget.value)}
                />
                <button
                  type="button"
                  class="mt-3 rounded-[9px] bg-[color:var(--vx-purple)] px-3.5 py-2 text-[12.5px] font-medium text-white"
                  onClick={() => void saveLinear()}
                >
                  Connect
                </button>
              </div>
            </Show>

            <Show when={connecting() === "jira"}>
              <div class="mb-6 rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.025] p-4">
                <p class="mb-2 text-[12.5px] text-white/60">
                  Create an API token at id.atlassian.com → Security → API tokens.
                </p>
                <div class="grid gap-2 sm:grid-cols-2">
                  <input
                    class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.045] px-3 py-2 text-[13.5px] text-white outline-none"
                    placeholder="https://your-team.atlassian.net"
                    value={jira().site}
                    onInput={(event) => setJira({ ...jira(), site: event.currentTarget.value })}
                  />
                  <input
                    class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.045] px-3 py-2 text-[13.5px] text-white outline-none"
                    placeholder="you@company.com"
                    value={jira().email}
                    onInput={(event) => setJira({ ...jira(), email: event.currentTarget.value })}
                  />
                  <input
                    type="password"
                    class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.045] px-3 py-2 text-[13.5px] text-white outline-none"
                    placeholder="API token"
                    value={jira().token}
                    onInput={(event) => setJira({ ...jira(), token: event.currentTarget.value })}
                  />
                  <input
                    class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.045] px-3 py-2 text-[13.5px] text-white outline-none"
                    placeholder="Optional JQL"
                    value={jira().jql}
                    onInput={(event) => setJira({ ...jira(), jql: event.currentTarget.value })}
                  />
                </div>
                <button
                  type="button"
                  class="mt-3 rounded-[9px] bg-[color:var(--vx-purple)] px-3.5 py-2 text-[12.5px] font-medium text-white"
                  onClick={() => void saveJira()}
                >
                  Connect
                </button>
              </div>
            </Show>

            <Show
              when={visible().length}
              fallback={
                <p class="rounded-[10px] border border-dashed border-[color:var(--vx-line)] px-4 py-10 text-center text-[13px] text-white/40">
                  {items().length
                    ? "No tickets match that search."
                    : "No open tickets assigned to you. Connect a tracker, or open an issue in this repository."}
                </p>
              }
            >
              <For each={GROUPS}>
                {(group) => {
                  const rows = createMemo(() => visible().filter((item) => item.status === group.id))
                  return (
                    <Show when={rows().length}>
                      <h2 class="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-[0.09em] text-white/40 first:mt-0">
                        {group.label} <span class="text-white/25">{rows().length}</span>
                      </h2>
                      <For each={rows()}>
                        {(item) => (
                          <div class="mb-2 rounded-[12px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-4 py-3">
                            <div class="flex items-start gap-3">
                              <div class="min-w-0 flex-1">
                                <div class="mb-1 flex flex-wrap items-center gap-2">
                                  <span class="font-mono text-[11px] text-[color:var(--vx-purple-bright)]">{item.key}</span>
                                  <span class="text-[10.5px] text-white/30">{PROVIDER_LABEL[item.provider]}</span>
                                  <Show when={item.assignee}>
                                    <span class="text-[10.5px] text-white/30">· {item.assignee}</span>
                                  </Show>
                                  <For each={item.labels.slice(0, 3)}>
                                    {(label) => (
                                      <span class="rounded-full border border-[color:var(--vx-line)] px-2 py-0.5 text-[10px] text-white/45">
                                        {label}
                                      </span>
                                    )}
                                  </For>
                                </div>
                                <p class="text-[13.5px] text-white">{item.title}</p>
                                <Show when={item.body}>
                                  <p class="mt-1 line-clamp-2 text-[12px] leading-relaxed text-white/45">{item.body}</p>
                                </Show>
                                <Show when={item.comments.length}>
                                  <p class="mt-1 text-[11px] text-white/30">
                                    {item.comments.length === 1 ? "1 comment" : `${item.comments.length} comments`} will
                                    be included in the brief
                                  </p>
                                </Show>
                              </div>
                              <div class="flex shrink-0 flex-col items-end gap-1.5">
                                <button
                                  type="button"
                                  class="rounded-[9px] bg-[color:var(--vx-purple)] px-3 py-1.5 text-[12px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                                  disabled={Boolean(handing())}
                                  onClick={() => void hand(item)}
                                >
                                  {handing() === item.id ? "Starting…" : "Start an agent"}
                                </button>
                                <a
                                  class="text-[11px] text-white/35 transition hover:text-white"
                                  href={item.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open ticket
                                </a>
                              </div>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>
                  )
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
