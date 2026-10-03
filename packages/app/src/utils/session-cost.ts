// A session's recorded cost, said honestly. A step on a model that lists no price adds nothing to the cost, so a
// total that includes such steps is only a lower bound, and one made of nothing else is unknown rather than $0.00.
export function formatSessionCost(input: {
  cost: number | undefined
  unpricedSteps: number | undefined
  format: (value: number) => string
  t: (key: "session.cost.unknown" | "session.cost.partial", params: { cost: string }) => string
}) {
  const cost = input.format(input.cost ?? 0)
  if (!input.unpricedSteps) return cost
  if (!input.cost) return input.t("session.cost.unknown", { cost })
  return input.t("session.cost.partial", { cost })
}
