import { For, Show } from "solid-js"

export type ExternalAgentTurn = {
  id: string
  role: "user" | "agent" | "vector"
  text: string
  at: string
  state: "running" | "done" | "failed" | "stopped"
  resumed?: boolean
  cost?: string
  streamTail?: string[]
}

export function restartedConversation(turns: readonly ExternalAgentTurn[], index: number) {
  const turn = turns[index]
  if (turn?.role !== "agent" || turn.resumed !== false) return false
  // The first provider turn starts a conversation; it cannot have failed to
  // resume one. `resumed: false` is meaningful only after an earlier agent
  // response exists and a follow-up had to restart with Vector's summary.
  return turns.slice(0, index).some((entry) => entry.role === "agent")
}

export function ExternalAgentTranscript(props: { turns: ExternalAgentTurn[]; runtimeLabel: string }) {
  return (
    <div class="mb-4 space-y-2.5">
      <For each={props.turns}>
        {(turn, index) => (
          <div
            class={
              turn.role === "user"
                ? "vx-turn vx-turn--user"
                : turn.role === "vector"
                  ? "px-1 py-1 text-[11px] text-[color:var(--vx-text-muted)]"
                  : "vx-turn vx-turn--agent"
            }
          >
            <Show when={turn.role !== "vector"}>
              <div class="vx-turn__who">
                <span>{turn.role === "user" ? "You" : props.runtimeLabel}</span>
                <Show when={restartedConversation(props.turns, index())}>
                  <span class="font-normal normal-case tracking-normal text-[color:var(--vx-amber)]">
                    restarted without the previous conversation
                  </span>
                </Show>
                <Show when={turn.cost}>
                  <span class="ml-auto font-normal tracking-normal text-[color:var(--vx-text-muted)]">{turn.cost}</span>
                </Show>
              </div>
            </Show>
            <Show when={turn.text}>
              <p class="vx-turn__body">{turn.text}</p>
            </Show>
            <Show when={turn.state === "running"}>
              <div class="vx-turn__stream">
                <For each={turn.streamTail ?? []}>{(line) => <div class="truncate">{line}</div>}</For>
                <Show when={!turn.streamTail?.length}>
                  <div>Working…</div>
                </Show>
              </div>
            </Show>
            <Show when={turn.state === "failed" || turn.state === "stopped"}>
              <span class="text-[11px] text-[color:var(--vx-red)]">
                {turn.state === "stopped" ? "Stopped" : "Failed"}
              </span>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
