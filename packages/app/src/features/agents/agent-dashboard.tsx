import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { SubagentAvatar, subagentIdentity } from "@/features/agents/identities"
import {
  boardColumns,
  elapsedLabel,
  filterAgents,
  hasActiveFilters,
  isDirected,
  orderConversation,
  findClashes,
  groupAgents,
  isRunning,
  needsAttention,
  summarize,
  type DashboardAgentInput,
  type DashboardAgentStatus,
  type TeamConversation,
} from "./agent-dashboard-model"

// A chip is a set membership toggle, not a radio: clicking two statuses means
// "either of these", which is what a row of chips reads as.
function toggled<T>(values: readonly T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

type FilterOption = { value: string; label: string }

// A labelled dropdown rather than a row of bare chips: with four facets the
// chips lose their heading, and "merged" on its own does not say which facet it
// belongs to.
function FilterMenu(props: {
  label: string
  options: FilterOption[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const summary = () => {
    if (!props.selected.length) return ""
    const first = props.options.find((option) => option.value === props.selected[0])?.label ?? ""
    return props.selected.length > 1 ? `${first} +${props.selected.length - 1}` : first
  }
  return (
    <div class="relative shrink-0">
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1 text-[11.5px] transition"
        classList={{
          "border-[color:var(--vx-purple)]/55 bg-[color:var(--vx-purple-soft)] text-white": props.selected.length > 0,
          "border-[color:var(--vx-line)] text-white/55 hover:text-white": props.selected.length === 0,
        }}
        aria-expanded={open()}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{props.label}</span>
        <Show when={summary()}>
          <span class="text-white/70">{summary()}</span>
        </Show>
        <svg viewBox="0 0 12 12" class="size-2.5 opacity-60" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <Show when={open()}>
        {/* Click-away closes without a document listener: the backdrop is the
            only thing that can receive the next click while the menu is open. */}
        <div class="fixed inset-0 z-[1]" onClick={() => setOpen(false)} aria-hidden="true" />
        <div
          role="menu"
          class="absolute left-0 z-[2] mt-1 min-w-[190px] overflow-hidden rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] py-1 shadow-xl"
        >
          <div class="px-2.5 py-1 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-white/35">
            {props.label}
          </div>
          <For each={props.options}>
            {(option) => (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.selected.includes(option.value)}
                class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-white/75 transition hover:bg-white/[0.06]"
                onClick={() => props.onToggle(option.value)}
              >
                <span class="min-w-0 flex-1 truncate">{option.label}</span>
                <Show when={props.selected.includes(option.value)}>
                  <svg viewBox="0 0 12 12" class="size-3 text-[color:var(--vx-purple-bright)]" aria-hidden="true">
                    <path d="m2.5 6.5 2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function ListRow(props: { agent: DashboardAgentInput; now: number; groupLabel?: string; onOpen?: (id: string) => void }) {
  return (
    <button
      type="button"
      class="flex w-full items-center gap-3 border-b border-[color:var(--vx-line)] px-3 py-2.5 text-left transition last:border-0 hover:bg-white/[0.03]"
      onClick={() => props.onOpen?.(props.agent.id)}
    >
      <span class="min-w-0 flex-1 truncate text-[12.5px] text-white">{props.agent.name}</span>
      <Show when={props.groupLabel}>
        <span class="hidden shrink-0 truncate text-[11.5px] text-white/35 sm:block">{props.groupLabel}</span>
      </Show>
      <span class="shrink-0 text-[11.5px] text-white/45">{props.agent.lastAction || props.agent.status}</span>
      <span class="shrink-0 text-[11px] text-white/30">{elapsedLabel(props.agent, props.now)}</span>
      <span
        class="size-1.5 shrink-0 rounded-full"
        classList={{
          [statusTone(props.agent.status)]: true,
          "animate-pulse": isRunning(props.agent.status),
        }}
        aria-hidden="true"
      />
    </button>
  )
}

function BoardCard(props: {
  agent: DashboardAgentInput
  now: number
  groupLabel?: string
  onOpen?: (id: string) => void
}) {
  return (
    <button
      type="button"
      class="w-full rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-3 py-2.5 text-left transition hover:border-[color:var(--vx-purple)]"
      onClick={() => props.onOpen?.(props.agent.id)}
    >
      <Show when={props.groupLabel}>
        <div class="mb-1 truncate text-[11px] text-white/35">{props.groupLabel}</div>
      </Show>
      <div class="mb-1 truncate text-[12.5px] font-medium text-white">{props.agent.name}</div>
      <div class="mb-2 line-clamp-2 text-[11.5px] leading-4 text-white/50">{props.agent.taskPrompt}</div>
      <div class="flex items-center gap-1.5 text-[11px] text-white/40">
        <span
          class="size-1.5 shrink-0 rounded-full"
          classList={{
            [statusTone(props.agent.status)]: true,
            "animate-pulse": isRunning(props.agent.status),
          }}
          aria-hidden="true"
        />
        <span class="truncate">{props.agent.lastAction || props.agent.status}</span>
        <span class="ml-auto shrink-0">{elapsedLabel(props.agent, props.now)}</span>
      </div>
      <Show when={props.agent.pullRequestUrl}>
        <div class="mt-1 text-[10.5px] text-emerald-300/80">PR is ready</div>
      </Show>
    </button>
  )
}

const statusTone = (status: DashboardAgentInput["status"]) => {
  if (status === "failed") return "bg-rose-400"
  if (status === "needs review") return "bg-amber-300"
  if (status === "complete" || status === "merged") return "bg-emerald-400"
  if (status === "stopped" || status === "discarded") return "bg-white/30"
  return "bg-[color:var(--vx-purple-bright)]"
}


function Conversation(props: { conversation: TeamConversation }) {
  return (
    <div class="mb-4 rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)]">
      <div class="flex items-center gap-2 border-b border-[color:var(--vx-line)] px-3 py-2">
        <span class="text-[12.5px] font-medium text-white">{props.conversation.teamName}</span>
        <span class="text-[11px] text-white/40">
          {props.conversation.messages.length} message{props.conversation.messages.length === 1 ? "" : "s"}
        </span>
      </div>
      <div class="max-h-[260px] overflow-y-auto px-3 py-2">
        <For each={orderConversation(props.conversation.messages)}>
          {(message) => (
            <div class="mb-2 last:mb-0">
              <div class="flex items-baseline gap-2">
                <span class="text-[11.5px] font-medium text-[color:var(--vx-purple-bright)]">{message.fromName}</span>
                <Show when={isDirected(message)}>
                  <span class="text-[10px] text-white/35">replied</span>
                </Show>
                <span class="text-[10px] text-white/30">{new Date(message.createdAt).toLocaleTimeString()}</span>
              </div>
              <p class="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-white/70">{message.text}</p>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

export function AgentDashboard(props: {
  open: boolean
  agents: DashboardAgentInput[]
  conversations?: TeamConversation[]
  onClose: () => void
  onOpenAgent?: (id: string) => void
}) {
  // Elapsed times must keep ticking while the panel is open; the records
  // themselves only refresh when the host repolls.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  const [view, setView] = createSignal<"board" | "list">("board")
  const [query, setQuery] = createSignal("")
  const [statuses, setStatuses] = createSignal<DashboardAgentStatus[]>([])
  const [runtimes, setRuntimes] = createSignal<string[]>([])
  const [teams, setTeams] = createSignal<string[]>([])
  const [pullRequest, setPullRequest] = createSignal<"open" | "merged" | "none" | undefined>()

  const filters = createMemo(() => ({
    query: query(),
    statuses: statuses(),
    runtimes: runtimes(),
    groups: teams(),
    pullRequest: pullRequest(),
  }))
  const visible = createMemo(() => filterAgents(props.agents, filters()))

  // Facets are derived from what is actually on screen, so a chip never offers
  // a status or runtime that would filter everything away.
  const statusOptions = createMemo(() => [...new Set(props.agents.map((agent) => agent.status))].sort())
  const runtimeOptions = createMemo(() => [...new Set(props.agents.map((agent) => agent.runtime))].sort())
  const teamOptions = createMemo(() =>
    groupAgents(props.agents)
      .filter((group) => group.swarm)
      .map((group) => ({ id: group.id, label: group.label })),
  )

  const clearFilters = () => {
    setQuery("")
    setStatuses([])
    setRuntimes([])
    setTeams([])
    setPullRequest(undefined)
  }

  // The label a card and a row show above the task, naming the crew the run
  // belongs to. Solo runs have none, and showing "solo" would be noise.
  const teamLabelFor = (agent: DashboardAgentInput) =>
    teamOptions().find((team) => team.id === (agent.swarmRunId ?? agent.teamId))?.label

  const summary = createMemo(() => summarize(props.agents))
  const clashes = createMemo(() => findClashes(props.agents))
  const columns = createMemo(() => boardColumns(visible()))

  return (
    <Show when={props.open}>
      <div
        data-vector-agent-dashboard
        role="dialog"
        aria-modal="true"
        aria-label="Agent Dashboard"
        class="fixed inset-0 z-[90] flex flex-col bg-[color:var(--vx-canvas)]"
      >
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] px-5">
          <div class="min-w-0 shrink-0">
            <span class="text-[13.5px] font-semibold text-white">Agent Dashboard</span>
          </div>
          <div class="flex shrink-0 items-center gap-1 rounded-[6px] border border-[color:var(--vx-line)] p-0.5">
            <For each={["board", "list"] as const}>
              {(mode) => (
                <button
                  type="button"
                  class="rounded-[4px] px-2.5 py-1 text-[11.5px] capitalize transition"
                  classList={{
                    "bg-[color:var(--vx-purple-soft)] text-white": view() === mode,
                    "text-white/45 hover:text-white": view() !== mode,
                  }}
                  onClick={() => setView(mode)}
                >
                  {mode}
                </button>
              )}
            </For>
          </div>
          <input
            class="h-7 w-52 shrink-0 rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-2.5 text-[12px] text-white/85 outline-none placeholder:text-white/30"
            placeholder="Search agents"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="flex-1" />
          <button
            type="button"
            aria-label="Close Agent Dashboard"
            class="grid size-7 place-items-center rounded-[5px] text-white/45 transition hover:bg-white/[0.06] hover:text-white"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {/* Working / Need you / Finished are the three column headings, so
              showing them again above the board is the same number twice. What
              is left is what the columns cannot say. */}
          <div class="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-white/45">
            <span>
              <span class="text-[15px] font-semibold text-white">{summary().total}</span>{" "}
              {summary().total === 1 ? "agent" : "agents"}
            </span>
            <span>
              <span class="text-[15px] font-semibold text-white">{summary().changedFiles}</span> files touched
            </span>
            <Show when={summary().teams}>
              <span>
                <span class="text-[15px] font-semibold text-white">{summary().teams}</span>{" "}
                {summary().teams === 1 ? "team" : "teams"}
              </span>
            </Show>
            <Show when={summary().clashes}>
              <span class="text-rose-300">
                <span class="text-[15px] font-semibold">{summary().clashes}</span>{" "}
                {summary().clashes === 1 ? "clash" : "clashes"}
              </span>
            </Show>
          </div>

          <div class="mb-3 flex flex-wrap items-center gap-1.5">
            <FilterMenu
              label="Status"
              options={statusOptions().map((status) => ({ value: status, label: status }))}
              selected={statuses()}
              onToggle={(value) => setStatuses((current) => toggled(current, value as DashboardAgentStatus))}
            />
            <Show when={teamOptions().length}>
              <FilterMenu
                label="Team"
                options={teamOptions().map((team) => ({ value: team.id, label: team.label }))}
                selected={teams()}
                onToggle={(value) => setTeams((current) => toggled(current, value))}
              />
            </Show>
            <FilterMenu
              label="Pull request"
              options={[
                { value: "open", label: "Open" },
                { value: "merged", label: "Merged" },
                { value: "none", label: "No pull request" },
              ]}
              selected={pullRequest() ? [pullRequest()!] : []}
              onToggle={(value) =>
                setPullRequest((current) =>
                  current === value ? undefined : (value as "open" | "merged" | "none"),
                )
              }
            />
            <FilterMenu
              label="Agent"
              options={runtimeOptions().map((runtime) => ({ value: runtime, label: runtime }))}
              selected={runtimes()}
              onToggle={(value) => setRuntimes((current) => toggled(current, value))}
            />
            <Show when={hasActiveFilters(filters())}>
              <button
                type="button"
                class="ml-auto shrink-0 text-[11.5px] text-white/45 transition hover:text-white"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            </Show>
          </div>

          <Show when={clashes().length}>
            <div class="mb-4 rounded-[6px] border border-rose-400/40 bg-rose-400/[0.07] px-3 py-2.5">
              <div class="mb-1 text-[12.5px] font-medium text-rose-200">
                {clashes().length === 1 ? "1 file has two agents working on it" : `${clashes().length} files have more than one agent working on them`}
              </div>
              <For each={clashes()}>
                {(clash) => (
                  <div class="text-[11.5px] text-white/60">
                    <span class="font-mono text-white/80">{clash.file}</span> — {clash.agentNames.join(", ")}
                  </div>
                )}
              </For>
              <div class="mt-1.5 text-[11px] text-white/45">
                Merging both will conflict. Review one before merging the other.
              </div>
            </div>
          </Show>

          <For each={props.conversations ?? []}>
            {(conversation) => (
              <Show when={conversation.messages.length}>
                <Conversation conversation={conversation} />
              </Show>
            )}
          </For>

          <Show
            when={visible().length}
            fallback={
              <div class="rounded-[6px] border border-[color:var(--vx-line)] px-4 py-8 text-center text-[12.5px] text-white/45">
                <Show
                  when={props.agents.length}
                  fallback={<>No agents yet. Start one from the sidebar and it will appear here.</>}
                >
                  No agents match these filters.
                </Show>
              </div>
            }
          >
            <Show when={view() === "board"}>
              <div class="grid grid-cols-1 items-start gap-3 md:grid-cols-3">
                <For each={columns()}>
                  {(column) => (
                    <div class="rounded-[8px] border border-[color:var(--vx-line)] bg-white/[0.015] p-2">
                      <div class="mb-2.5 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/45">
                        <span>{column.label}</span>
                        <span class="text-white/25">{column.agents.length}</span>
                      </div>
                      <div class="flex flex-col gap-2">
                        <For each={column.agents}>
                          {(item) => (
                            <BoardCard
                              agent={item}
                              now={now()}
                              groupLabel={teamLabelFor(item)}
                              onOpen={props.onOpenAgent}
                            />
                          )}
                        </For>
                      </div>
                      <Show when={!column.agents.length}>
                        <div class="px-1 py-3 text-[11px] text-white/30">Nothing here</div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={view() === "list"}>
              <div class="overflow-hidden rounded-[8px] border border-[color:var(--vx-line)]">
                <For each={columns()}>
                  {(column) => (
                    <Show when={column.agents.length}>
                      <div class="flex items-center gap-2 border-b border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/45">
                        <span>{column.label}</span>
                        <span class="text-white/25">{column.agents.length}</span>
                      </div>
                      <For each={column.agents}>
                        {(item) => (
                          <ListRow
                            agent={item}
                            now={now()}
                            groupLabel={teamLabelFor(item)}
                            onOpen={props.onOpenAgent}
                          />
                        )}
                      </For>
                    </Show>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  )
}
