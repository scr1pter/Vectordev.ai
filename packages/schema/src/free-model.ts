// Price metadata and the explicit free variant must agree; an unpriced model is not free.
export function isFreeModel(model: { providerID: string; id: string; cost?: { input: number; output: number } }) {
  return (
    (model.providerID === "vector" || model.providerID === "openrouter") &&
    model.id.endsWith(":free") &&
    model.cost?.input === 0 &&
    model.cost.output === 0
  )
}
