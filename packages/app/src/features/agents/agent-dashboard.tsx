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
  sortForDisplay,
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

function FilterChip(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      class="shrink-0 rounded-[6px] border px-2 py-1 text-[11px] transition"
      classList={{
        "border-[color:var(--vx-purple)]/60 bg-[color:var(--vx-purple-soft)] text-white": props.active,
        "border-[color:var(--vx-line)] text-white/50 hover:text-white": !props.active,
      }}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

function BoardCard(props: { agent: DashboardAgentInput; now: number; onOpen?: (id: string) => void }) {
  return (
    <button
      type="button"
      class="w-full rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-3 py-2.5 text-left transition hover:border-[color:var(--vx-purple)]"
      onClick={() => props.onOpen?.(props.agent.id)}
    >
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

function Stat(props: { label: string; value: number; tone?: string }) {
  return (
    <div class="rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-3 py-2">
      <div class="text-[18px] font-semibold" classList={{ [props.tone ?? "text-white"]: true }}>
        {props.value}
      </div>
      <div class="text-[11px] text-white/45">{props.label}</div>
    </div>
  )
}

function AgentRow(props: { agent: DashboardAgentInput; now: number; onOpen?: (id: string) => void }) {
  return (
    <button
      type="button"
      class="flex w-full items-start gap-3 rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-3 py-2.5 text-left transition hover:border-[color:var(--vx-purple)]"
      onClick={() => props.onOpen?.(props.agent.id)}
    >
      <span
        class="mt-1.5 size-2 shrink-0 rounded-full"
        classList={{
          [statusTone(props.agent.status)]: true,
          "animate-pulse": isRunning(props.agent.status),
        }}
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline gap-2">
          <Show when={subagentIdentity(props.agent.agent)}>
            {(identity) => <SubagentAvatar id={identity().id} size={15} />}
          </Show>
          <span class="truncate text-[12.5px] font-medium text-white">{props.agent.name}</span>
          <Show when={subagentIdentity(props.agent.agent)}>
            {(identity) => <span class="shrink-0 text-[11px] text-white/40">{identity().name}</span>}
          </Show>
          <span class="shrink-0 text-[11px] text-white/40">{props.agent.status}</span>
          <Show when={props.agent.swarmRole}>
            <span class="shrink-0 rounded-full bg-white/[0.07] px-1.5 py-px text-[9.5px] uppercase tracking-wide text-white/50">
              {props.agent.swarmRole}
            </span>
          </Show>
        </span>
        <span class="mt-0.5 block truncate text-[11.5px] text-white/55">{props.agent.lastAction}</span>
        <span class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-white/38">
          <span>{props.agent.model}</span>
          <span>{props.agent.changedFilesCount} files</span>
          <span>{props.agent.actualCost || props.agent.estimatedCost}</span>
          <span>{elapsedLabel(props.agent, props.now)}</span>
        </span>
        <Show when={props.agent.error}>
          <span class="mt-1 block truncate text-[11px] text-rose-300">{props.agent.error}</span>
        </Show>
      </span>
      <Show when={isRunning(props.agent.status)}>
        <span class="mt-1 w-14 shrink-0">
          <span class="block h-1 rounded-full bg-white/10">
            <span
              class="block h-1 rounded-full bg-[color:var(--vx-purple-bright)]"
              style={{ width: `${Math.max(0, Math.min(100, props.agent.progress))}%` }}
            />
          </span>
        </span>
      </Show>
    </button>
  )
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
  const [pullRequest, setPullRequest] = createSignal<"with" | "without" | undefined>()

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

  const summary = createMemo(() => summarize(props.agents))
  const clashes = createMemo(() => findClashes(props.agents))
  const columns = createMemo(() => boardColumns(visible()))
  const groups = createMemo(() =>
    groupAgents(sortForDisplay(visible())).sort((a, b) => Number(b.swarm) - Number(a.swarm)),
  )

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
          <div class="min-w-0">
            <div class="text-[14px] font-semibold text-white">Agent Dashboard</div>
            <div class="text-[11px] text-white/45">Every agent in this project, live</div>
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

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div class="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Agents" value={summary().total} />
            <Stat label="Working" value={summary().running} tone="text-[color:var(--vx-purple-bright)]" />
            <Stat label="Need you" value={summary().attention} tone="text-amber-300" />
            <Stat label="Finished" value={summary().finished} tone="text-emerald-300" />
            <Stat label="Files touched" value={summary().changedFiles} />
            <Stat label="Teams" value={summary().teams} />
            <Stat label="Clashes" value={summary().clashes} tone={summary().clashes ? "text-rose-300" : "text-white"} />
          </div>

          <div class="mb-3 flex flex-wrap items-center gap-1.5">
            <For each={statusOptions()}>
              {(status) => (
                <FilterChip
                  label={status}
                  active={statuses().includes(status)}
                  onClick={() => setStatuses((current) => toggled(current, status))}
                />
              )}
            </For>
            <Show when={runtimeOptions().length > 1}>
              <span class="mx-1 h-4 w-px bg-[color:var(--vx-line)]" />
              <For each={runtimeOptions()}>
                {(runtime) => (
                  <FilterChip
                    label={runtime}
                    active={runtimes().includes(runtime)}
                    onClick={() => setRuntimes((current) => toggled(current, runtime))}
                  />
                )}
              </For>
            </Show>
            <Show when={teamOptions().length}>
              <span class="mx-1 h-4 w-px bg-[color:var(--vx-line)]" />
              <For each={teamOptions()}>
                {(team) => (
                  <FilterChip
                    label={team.label}
                    active={teams().includes(team.id)}
                    onClick={() => setTeams((current) => toggled(current, team.id))}
                  />
                )}
              </For>
            </Show>
            <span class="mx-1 h-4 w-px bg-[color:var(--vx-line)]" />
            <FilterChip
              label="Has PR"
              active={pullRequest() === "with"}
              onClick={() => setPullRequest((current) => (current === "with" ? undefined : "with"))}
            />
            <Show when={hasActiveFilters(filters())}>
              <button
                type="button"
                class="ml-auto shrink-0 text-[11px] text-white/45 transition hover:text-white"
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
                      <div class="mb-2 flex items-center gap-2 px-1 text-[11.5px] font-semibold text-white/70">
                        <span>{column.label}</span>
                        <span class="text-white/35">{column.agents.length}</span>
                      </div>
                      <div class="flex flex-col gap-2">
                        <For each={column.agents}>
                          {(item) => <BoardCard agent={item} now={now()} onOpen={props.onOpenAgent} />}
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
            <For each={groups()}>
              {(group) => (
                <div class="mb-3">
                  <Show when={group.swarm}>
                    <div class="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wide text-white/40">
                      <span>Team · {group.label}</span>
                      <span class="h-px flex-1 bg-[color:var(--vx-line)]" />
                      <span>{group.agents.length} agents</span>
                    </div>
                  </Show>
                  <div class="flex flex-col gap-1.5" classList={{ "pl-3": group.swarm }}>
                    <For each={group.agents}>
                      {(item) => <AgentRow agent={item} now={now()} onOpen={props.onOpenAgent} />}
                    </For>
                  </div>
                </div>
              )}
            </For>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  )
}
