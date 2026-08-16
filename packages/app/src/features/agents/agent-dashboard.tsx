import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  elapsedLabel,
  isDirected,
  orderConversation,
  findClashes,
  groupAgents,
  isRunning,
  needsAttention,
  sortForDisplay,
  summarize,
  type DashboardAgentInput,
  type TeamConversation,
} from "./agent-dashboard-model"

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
          <span class="truncate text-[12.5px] font-medium text-white">{props.agent.name}</span>
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

  const summary = createMemo(() => summarize(props.agents))
  const clashes = createMemo(() => findClashes(props.agents))
  const groups = createMemo(() =>
    groupAgents(sortForDisplay(props.agents)).sort((a, b) => Number(b.swarm) - Number(a.swarm)),
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
          <div class="min-w-0 flex-1">
            <div class="text-[14px] font-semibold text-white">Agent Dashboard</div>
            <div class="text-[11px] text-white/45">Every agent in this project, live</div>
          </div>
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
            when={props.agents.length}
            fallback={
              <div class="rounded-[6px] border border-[color:var(--vx-line)] px-4 py-8 text-center text-[12.5px] text-white/45">
                No agents yet. Start one from the sidebar and it will appear here.
              </div>
            }
          >
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
        </div>
      </div>
    </Show>
  )
}
