import { Option, Schema } from "effect"
import { configuredPlanModels, type ModelPlanModel } from "../../../api/_lib/model-plan-config"

const CatalogModel = Schema.Struct({
  id: Schema.String,
  context_length: Schema.Number,
  supported_parameters: Schema.Array(Schema.String),
  expiration_date: Schema.optional(Schema.NullOr(Schema.String)),
})
const CatalogEndpoint = Schema.Struct({
  model_id: Schema.String,
  provider_name: Schema.String,
  tag: Schema.String,
  context_length: Schema.Number,
  max_completion_tokens: Schema.NullOr(Schema.Number),
  pricing: Schema.Record(Schema.String, Schema.Unknown),
  supported_parameters: Schema.Array(Schema.String),
  status: Schema.Number,
})

// Audit the configured catalog without substituting models or changing deployment settings.
export function auditModelPlanCatalog(
  configured: readonly ModelPlanModel[],
  models: readonly unknown[],
  endpoints: readonly unknown[],
  now = Date.now(),
) {
  return configured.map((configured) => {
    const decoded = Schema.decodeUnknownOption(CatalogModel)(
      models.find((model) => record(model) && model.id === configured.id),
    )
    const failures: string[] = []
    if (Option.isNone(decoded)) failures.push("Model is missing or its catalog metadata is invalid.")
    if (Option.isSome(decoded)) {
      if (!supportsTools(decoded.value.supported_parameters)) failures.push("Model does not advertise tool calling.")
      if (
        !Number.isSafeInteger(decoded.value.context_length) ||
        decoded.value.context_length < configured.contextLength
      )
        failures.push("Model context is below the configured limit.")
      if (decoded.value.expiration_date && !(Date.parse(decoded.value.expiration_date) > now))
        failures.push("Model has expired or its expiration date is invalid.")
    }
    const rejected: string[] = []
    const providers = endpoints.flatMap((item) => {
      if (!record(item) || item.model_id !== configured.id) return []
      const decoded = Schema.decodeUnknownOption(CatalogEndpoint)(item)
      if (Option.isNone(decoded)) {
        rejected.push("An endpoint has invalid metadata.")
        return []
      }
      const endpoint = decoded.value
      const reasons = [
        ...(endpoint.status !== 0 ? ["unavailable"] : []),
        ...(!endpoint.tag.trim() || !endpoint.provider_name.trim() ? ["missing provider identity"] : []),
        ...(!supportsTools(endpoint.supported_parameters) ? ["missing tools/tool_choice"] : []),
        ...(!Number.isSafeInteger(endpoint.context_length) || endpoint.context_length < configured.contextLength
          ? ["context below configured limit"]
          : []),
        ...(endpoint.max_completion_tokens === null ||
        !Number.isSafeInteger(endpoint.max_completion_tokens) ||
        endpoint.max_completion_tokens < configured.maxOutputTokens
          ? ["output limit is unknown or below configured limit"]
          : []),
        ...(!withinPricingLimits(endpoint.pricing, configured)
          ? ["pricing exceeds ceilings or has unsupported fees"]
          : []),
      ]
      if (reasons.length) {
        rejected.push(`${endpoint.tag}: ${reasons.join(", ")}.`)
        return []
      }
      return [
        {
          id: endpoint.tag,
          name: endpoint.provider_name,
          contextLength: endpoint.context_length,
          maxOutputTokens: endpoint.max_completion_tokens,
          inputPrice: Number(endpoint.pricing.prompt) * 1_000_000,
          outputPrice: Number(endpoint.pricing.completion) * 1_000_000,
        },
      ]
    })
    if (!providers.length) failures.push("No available ZDR endpoint satisfies every configured limit.", ...rejected)
    return { model: configured.id, ok: !failures.length, providers, failures }
  })
}

function supportsTools(parameters: readonly string[]) {
  return parameters.includes("tools") && parameters.includes("tool_choice")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rate(value: unknown) {
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
    ? Number(value)
    : undefined
}

function withinPricingLimits(pricing: Readonly<Record<string, unknown>>, configured: ModelPlanModel): boolean {
  if (rate(pricing.prompt) === undefined || rate(pricing.completion) === undefined) return false
  return Object.entries(pricing).every(([key, value]) => {
    if (key === "overrides") {
      if (!Array.isArray(value)) return false
      return value.every((override: unknown) => {
        if (
          !record(override) ||
          !Number.isSafeInteger(override.min_prompt_tokens) ||
          Number(override.min_prompt_tokens) < 0
        )
          return false
        // A prompt cannot reach this threshold inside the configured total context.
        if (Number(override.min_prompt_tokens) >= configured.contextLength) return true
        return withinPricingLimits(
          Object.fromEntries(
            Object.entries({ ...pricing, ...override }).filter(
              ([key]) => key !== "overrides" && key !== "min_prompt_tokens",
            ),
          ),
          configured,
        )
      })
    }
    const price = rate(value)
    if (price === undefined) return false
    if (key === "discount") return price <= 1
    if (key === "prompt" || key.startsWith("input_cache_")) return price * 1_000_000 <= configured.inputPrice
    if (key === "completion") return price * 1_000_000 <= configured.outputPrice
    return price === 0
  })
}

if (import.meta.main) {
  const configured = configuredPlanModels()
  if (!configured.length) throw new Error("No Codium models are configured. The catalog was not changed.")
  const responses = await Promise.all(
    ["models", "endpoints/zdr"].map(async (path) => {
      const response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`OpenRouter ${path} returned ${response.status}. The catalog was not changed.`)
      return Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))(await response.json()).data
    }),
  )
  const results = auditModelPlanCatalog(configured, responses[0], responses[1])
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), models: results }, null, 2))
  if (results.some((result) => !result.ok)) process.exitCode = 1
}
