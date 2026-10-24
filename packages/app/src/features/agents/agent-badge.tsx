import { Show } from "solid-js"
import type { ExternalAgent } from "@vectordevai/schema/external-agent"
import { agentBadge, STATUS_LABEL, type HostState } from "./host-locally-model"
import "./host-locally.css"

/** An agent's mark: the vendor's own file where the catalog switches it on, otherwise neutral letters. The name is
    always written beside it, so the badge itself is decoration. */
export function AgentBadge(props: { agent: ExternalAgent.Agent; size?: "small" | "large" }) {
  // Vector draws its dark look everywhere; the light file is kept for the day a light look returns.
  const badge = () =>
    agentBadge(props.agent, globalThis.document?.documentElement.dataset.vectorTheme === "light" ? "light" : "dark")
  const official = () => {
    const value = badge()
    return value.kind === "official" ? value : undefined
  }
  const letters = () => {
    const value = badge()
    return value.kind === "letters" ? value : undefined
  }
  return (
    <span
      data-component="agent-badge"
      data-size={props.size ?? "small"}
      data-kind={badge().kind}
      data-tone={letters()?.tone}
      aria-hidden="true"
    >
      <Show when={official()} fallback={letters()?.letters}>
        {(value) => <img src={value().src} alt="" draggable={false} />}
      </Show>
    </span>
  )
}

export function AgentStatusPill(props: { state: HostState }) {
  return (
    <span data-component="agent-status" data-state={props.state}>
      <span data-slot="agent-status-dot" />
      {STATUS_LABEL[props.state]}
    </span>
  )
}
