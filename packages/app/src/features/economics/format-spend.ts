// One wording for what a session has spent, shared by the cost pill, its hover
// and the Context tab, so the same session never reads "$0.00" in one place and
// "cost unknown" in another.
//
// A model with no catalog price reports tokens but no dollars. Printing $0.00
// for it would claim the run was free when Vector simply cannot price it, so
// such a session reads "cost unknown" instead.

import { isFreeModel } from "@vectordevai/schema/free-model"
import { formatSessionCost } from "@/utils/session-cost"
import { ratesFor, type ModelRates } from "./model-pricing"

export type SpendKind = "free" | "unpriced" | "priced"

export type SpendCatalog = ReadonlyMap<
  string,
  { models?: Record<string, { cost?: ModelRates; freeModel?: { source: string } } | undefined> }
>

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function spendKind(
  providers: SpendCatalog | undefined,
  providerID: string | undefined,
  modelID: string | undefined,
): SpendKind {
  const model = providerID && modelID ? providers?.get(providerID)?.models?.[modelID] : undefined
  if (model?.freeModel) return "free"
  if (providerID && modelID && isFreeModel({ providerID, id: modelID, cost: model?.cost })) return "free"
  if (!ratesFor(providers, providerID, modelID)) return "unpriced"
  return "priced"
}

// Two decimals, except a positive amount under a cent, which would otherwise
// round down to a "$0.00" that reads as free.
export function formatUsd(usd: number) {
  if (usd > 0 && usd < 0.01) return "<$0.01"
  return money.format(usd)
}

// What a session's total reads as, and the kind its tooltip explains. The backend's own count of unpriced steps comes
// first. Tokens with no dollars on them take the catalog's word for the model the session last used: a free model
// reads "free" and anything else "cost unknown", never "$0.00". Money spent always shows, even when the latest model is
// free: the total covers every model the session used.
export function sessionReading(input: {
  cost: number
  unpricedSteps: number
  tokens: number
  kind: SpendKind
  format: (value: number) => string
  t: (key: "session.cost.unknown" | "session.cost.partial", params: { cost: string }) => string
}): { label: string; kind: SpendKind } {
  const kind: SpendKind =
    input.cost > 0
      ? "priced"
      : input.unpricedSteps > 0
        ? "unpriced"
        : input.tokens === 0 || input.kind === "free"
          ? input.kind
          : "unpriced"
  if (kind === "free" && input.cost === 0 && input.tokens > 0) return { label: "free", kind }
  if (kind === "unpriced" && input.cost === 0 && input.tokens > 0)
    return { label: input.t("session.cost.unknown", { cost: input.format(0) }), kind }
  return { label: formatSessionCost(input), kind }
}

// What the cost pill reads. The run guard's cap is per run, across the root
// session and its subagents, so it is only paired with the guard's own figure for
// that run, and only while the run is going: the session total adds up every run
// the session has had, and a finished run's reading would otherwise linger.
export function spendPill(input: {
  session: { label: string; kind: SpendKind }
  run: { spentUsd: number; capUsd?: number; state: "ok" | "warn" | "stopped" } | undefined
  running: boolean
}) {
  const session = input.session.label
  const kind = input.session.kind
  const capUsd = input.run?.capUsd
  // A cap is a dollar figure, so it never follows "free" or "unpriced" for a run that spent nothing.
  if (!input.run || capUsd === undefined || !input.running) return { label: session, session, kind, warn: false }
  if (!(input.run.spentUsd > 0) && kind !== "priced") return { label: session, session, kind, warn: false }
  const run = `${formatUsd(input.run.spentUsd)} of ${formatUsd(capUsd)}`
  return { label: run, session, run, capUsd, kind, warn: input.run.state === "warn" }
}

// The model a session last answered with decides how its spend is labelled.
export function lastAssistantModel(messages: readonly { role: string; providerID?: string; modelID?: string }[]) {
  const last = messages.filter((message) => message.role === "assistant").at(-1)
  if (!last) return undefined
  return { providerID: last.providerID, modelID: last.modelID }
}

export const SPEND_TOOLTIP: Record<SpendKind, string> = {
  priced: "Priced from the tokens your provider reported, at catalog list price. Billed to your own provider key.",
  unpriced: "This model has no catalog price, so Vector cannot put a dollar figure on it.",
  free: "Free model. No per-token charge to your key.",
}

export function capTooltip(capUsd: number) {
  return `This run is capped at ${formatUsd(capUsd)}. Vector stops within one step of the cap for each agent running at the time.`
}
