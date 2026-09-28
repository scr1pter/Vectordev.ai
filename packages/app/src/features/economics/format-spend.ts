// One wording for what a session has spent, shared by the cost pill, its hover
// and the Context tab, so the same session never reads "$0.00" in one place and
// "unpriced" in another.
//
// A model with no catalog price reports tokens but no dollars. Printing $0.00
// for it would claim the run was free when Vector simply cannot price it, so
// such a session reads "unpriced" instead.

import { isFreeModel } from "@vectordevai/schema/free-model"
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

export function formatSpend(input: { usd: number | undefined; tokens: number | undefined; kind: SpendKind }) {
  const usd = input.usd ?? 0
  if (input.kind === "free") return "free"
  if (usd > 0) return formatUsd(usd)
  // Tokens with no dollars means nothing priced them, whatever the catalog says.
  if ((input.tokens ?? 0) > 0) return "unpriced"
  return formatUsd(0)
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
  return `This run is capped at ${formatUsd(capUsd)}. Vector stops within one step of the cap.`
}
