import type { ExternalAgent } from "@vectordevai/schema/external-agent"
import { STATUS_LABEL, type HostState } from "./host-locally-model"
import "./host-locally.css"

/** An agent's mark: two neutral letters in one of Vector's own tones, never a vendor's logo. The name is always
    written beside it, so the badge itself is decoration. */
export function AgentBadge(props: { agent: ExternalAgent.Agent; size?: "small" | "large" }) {
  return (
    <span
      data-component="agent-badge"
      data-size={props.size ?? "small"}
      data-tone={props.agent.logo.tone}
      aria-hidden="true"
    >
      {props.agent.logo.letters}
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
