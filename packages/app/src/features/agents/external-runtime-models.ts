import type { ModelSelectorModelState } from "@/components/dialog-select-model"
import type { PickerModel } from "@/utils/provider-brand"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import type { ExternalRuntime } from "./external-runtimes"

/* The models each external agent's CLI accepts for its model flag, in the order the picker lists them after the CLI's
   default. They come from the catalog in @vectordevai/schema/external-agent, which is the one place to update when a
   vendor ships or retires a model (a live-listing agent's fallback list stands in here). Desktop passes whatever value
   is chosen straight to the CLI (packages/desktop/src/main/external-agents.ts, runtimeArguments), so a value the CLI
   refuses comes back as the CLI's own error and the workspace goes back to the default. */
export const EXTERNAL_RUNTIME_MODELS = Object.fromEntries(
  ExternalAgent.chatIds.map((id) => {
    const agent = ExternalAgent.find(id)!
    return [id, { mark: agent.modelMark ?? agent.id, models: catalogModels(agent) }]
  }),
) as Record<ExternalRuntime, { mark: string; models: readonly CliModel[] }>

type CliModel = ExternalAgent.CliModel

/** The picker row that passes no model flag, so the CLI runs the model it is set to use. Never sent to a CLI. */
export const RUNTIME_DEFAULT_MODEL = "runtime-default"

const RECENT_LIMIT = 5

/** The models an agent's catalog entry lists for its model flag: its fixed list, or the stand-in for a live list. */
export function catalogModels(agent: ExternalAgent.Agent): readonly CliModel[] {
  if (agent.models.kind === "live") return agent.models.fallback
  if (agent.models.kind === "fixed") return agent.models.models
  return []
}

/** Any catalog agent's picker rows: its own default first, then what its CLI just listed (`live`) or the catalog's
    list. A value chosen before the list changed, or typed as a custom model id, stays listed, last, so the picker can
    still show what runs. */
export function agentModels(
  id: ExternalAgent.Id,
  options: { current?: string; live?: readonly CliModel[] } = {},
): PickerModel[] {
  const agent = ExternalAgent.find(id)!
  const models = options.live?.length ? options.live : catalogModels(agent)
  const listed = [
    { id: RUNTIME_DEFAULT_MODEL, name: "Agent default" },
    ...models.filter(
      (model, index) =>
        model.id !== RUNTIME_DEFAULT_MODEL && models.findIndex((item) => item.id === model.id) === index,
    ),
  ]
  const kept =
    options.current && !listed.some((model) => model.id === options.current)
      ? [{ id: options.current, name: options.current }]
      : []
  // A provider-shaped row, so the picker draws the agent as its one section with its catalog mark. "custom" marks a
  // list the host supplies, which the picker never hides as an unsupported provider.
  const provider = { id: agent.modelMark ?? agent.id, name: agent.name, source: "custom" }
  return [...listed, ...kept].map((model) => ({ ...model, provider }))
}

/** The runtime's picker rows: its default first, then its curated models. */
export function externalRuntimeModels(runtime: ExternalRuntime, current?: string): PickerModel[] {
  return agentModels(runtime, { current })
}

/** What the composer's model control reads for a workspace's chosen value; undefined is the CLI's default. */
export function externalRuntimeModelName(runtime: ExternalRuntime, value: string | undefined) {
  return externalRuntimeModels(runtime, value).find((model) => model.id === (value ?? RUNTIME_DEFAULT_MODEL))!.name
}

/** One pick of a runtime's model. `at` (epoch ms) lets a pick made after a refusal outrank it. */
export type RuntimeModelPick = { id: string; at: number }

/** A model a runtime's CLI refused, as desktop records it on the workspace; `at` is ISO. */
export type RuntimeModelRefusal = { model: string; at: string }

/** A runtime's picks, newest first, with the default kept as its own entry. */
export function rememberRuntimeModel(
  picks: readonly RuntimeModelPick[] | undefined,
  value: string | undefined,
  at = Date.now(),
) {
  const id = value ?? RUNTIME_DEFAULT_MODEL
  return [{ id, at }, ...(picks ?? []).filter((pick) => pick.id !== id)].slice(0, RECENT_LIMIT)
}

/** A runtime's picks without a model its CLI refused, so Recently used stops offering it and no new agent starts on
    it. Only a pick made after the refusal survives it: picking the model again is the way back to it. */
export function forgetRefusedRuntimeModel(
  picks: readonly RuntimeModelPick[] | undefined,
  refusal: RuntimeModelRefusal,
) {
  const refusedAt = Date.parse(refusal.at)
  return (picks ?? []).filter((pick) => pick.id !== refusal.model || pick.at >= refusedAt)
}

/** The value a new workspace for `runtime` starts on: the one last picked for it, else the CLI's default. */
export function launchRuntimeModel(picks: readonly RuntimeModelPick[] | undefined) {
  const last = picks?.[0]?.id
  return last && last !== RUNTIME_DEFAULT_MODEL ? last : undefined
}

/** Vector's model picker over one runtime's CLI models. `current` and `set` speak the CLI's value, undefined for its
    default, so the default row never reaches desktop as a model name. */
export function externalRuntimeModelState(input: {
  runtime: () => ExternalAgent.Id
  current: () => string | undefined
  recent: () => readonly RuntimeModelPick[] | undefined
  set: (value: string | undefined) => void
  /** What the agent's CLI listed just now; without it, the catalog's list. */
  live?: () => readonly CliModel[] | undefined
}): ModelSelectorModelState {
  const list = () => agentModels(input.runtime(), { current: input.current(), live: input.live?.() })
  const row = (id: string) => list().find((model) => model.id === id)
  return {
    list,
    visible: () => true,
    current: () => row(input.current() ?? RUNTIME_DEFAULT_MODEL),
    recent: () => (input.recent() ?? []).map((pick) => row(pick.id)),
    set: (key) => input.set(!key || key.modelID === RUNTIME_DEFAULT_MODEL ? undefined : key.modelID),
  }
}
