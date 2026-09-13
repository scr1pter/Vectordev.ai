import { For } from "solid-js"
import { statusSummary, type TaskAgent } from "./subagent-model"

// One 8px mark per agent, coloured by status. Subagents are rounded squares
// and specialists are dots, so the two kinds stay distinct at a glance.
export function TaskSquares(props: {
  agents: readonly Pick<TaskAgent, "key" | "status" | "kind">[]
  class: string
  squareClass: string
  /** Announce the marks as one image ("2 running, 1 not started") instead of hiding them. */
  labelled?: boolean
}) {
  return (
    <span
      class={props.class}
      role={props.labelled ? "img" : undefined}
      aria-label={props.labelled ? statusSummary(props.agents.map((agent) => agent.status)) : undefined}
      aria-hidden={props.labelled ? undefined : "true"}
    >
      <For each={props.agents}>
        {(agent) => (
          <span class={props.squareClass} data-status={agent.status} data-kind={agent.kind} aria-hidden="true" />
        )}
      </For>
    </span>
  )
}
