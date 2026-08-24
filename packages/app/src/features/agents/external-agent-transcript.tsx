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

export function ExternalAgentTranscript(props: { turns: ExternalAgentTurn[]; runtimeLabel: string }) {
  return (
    <div class="mb-4 space-y-2.5">
      <For each={props.turns}>
        {(turn) => (
          <div
            class={
              turn.role === "user"
                ? "ml-10 rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.05] px-3.5 py-2.5"
                : turn.role === "vector"
                  ? "px-1 py-1 text-[11px] text-white/40"
                  : "mr-10 rounded-[12px] border border-[color:var(--vx-line)] bg-black/20 px-3.5 py-2.5"
            }
          >
            <Show when={turn.role !== "vector"}>
              <div class="mb-1 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wide text-white/38">
                <span>{turn.role === "user" ? "You" : props.runtimeLabel}</span>
                <Show when={turn.role === "agent" && turn.resumed === false}>
                  <span class="font-normal normal-case tracking-normal text-amber-200/70">
                    restarted without the previous conversation
                  </span>
                </Show>
                <Show when={turn.cost}>
                  <span class="ml-auto font-normal text-white/28">{turn.cost}</span>
                </Show>
              </div>
            </Show>
            <Show when={turn.text}>
              <p class="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-white/80">{turn.text}</p>
            </Show>
            <Show when={turn.state === "running"}>
              <div class="max-h-[160px] overflow-auto font-mono text-[10.5px] leading-4 text-white/45">
                <For each={turn.streamTail ?? []}>{(line) => <div class="truncate">{line}</div>}</For>
                <Show when={!turn.streamTail?.length}>
                  <div class="text-white/35">Working…</div>
                </Show>
              </div>
            </Show>
            <Show when={turn.state === "failed" || turn.state === "stopped"}>
              <span class="text-[11px] text-rose-300/80">{turn.state === "stopped" ? "Stopped" : "Failed"}</span>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
