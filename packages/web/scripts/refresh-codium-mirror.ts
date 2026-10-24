import { CODIUM_MODELS } from "../../../api/_lib/codium-catalog"
import { catalogBody } from "../../engine/script/release-catalog"
import snapshot from "../test/fixtures/codium-endpoints-2026-10-23.json"

// Only the reviewed Codium models' ordinary provider entries change. Codium itself is served by its account API.
const file = new URL("../public/models/api.json", import.meta.url)
const catalog = await Bun.file(file).json()
for (const configured of CODIUM_MODELS) {
  const source = snapshot.models.find((model) => model.id === configured.id)
  if (!source) throw new Error(`Missing reviewed metadata for ${configured.id}`)
  const previous = catalog.openrouter.models[source.id]
  const overrides = "overrides" in source.pricing ? (source.pricing.overrides ?? []) : []
  // Context tiers have native catalog support. Use peak prices only for time-based discounts, which do not.
  const base = Object.fromEntries(
    Object.keys(source.pricing)
      .filter((key) => key !== "overrides")
      .map((key) => [
        key,
        Math.max(
          ...[source.pricing, ...overrides.filter((item) => !("min_prompt_tokens" in item))].map((item) =>
            Number((item as Record<string, unknown>)[key] ?? (source.pricing as Record<string, unknown>)[key]),
          ),
        ),
      ]),
  )
  const tiers = overrides.flatMap((item) =>
    "min_prompt_tokens" in item
      ? [{ ...prices({ ...source.pricing, ...item }), tier: { type: "context", size: item.min_prompt_tokens } }]
      : [],
  )
  catalog.openrouter.models[source.id] = {
    ...previous,
    id: source.id,
    canonical_model_id: source.id,
    name: configured.name,
    description: configured.description.replace(/^The default: /, "").replace(/ Uses credits faster.*$/, ""),
    last_updated: snapshot.checkedAt,
    release_date: new Date(source.created * 1000).toISOString().slice(0, 10),
    open_weights: source.id.startsWith("deepseek/") || source.id.startsWith("moonshotai/"),
    tool_call: true,
    reasoning: true,
    reasoning_options: [{ type: "effort", values: source.reasoning.supported_efforts }],
    structured_output: source.supported_parameters.includes("structured_outputs"),
    temperature: source.supported_parameters.includes("temperature"),
    attachment: source.architecture.input_modalities.some((modality) => modality !== "text"),
    modalities: {
      input: source.architecture.input_modalities.map((modality) => (modality === "file" ? "pdf" : modality)),
      output: source.architecture.output_modalities,
    },
    cost: { ...prices(base), ...(tiers.length ? { tiers } : {}) },
    limit: {
      context: source.context_length,
      output: source.top_provider.max_completion_tokens,
    },
  }
}
await Bun.write(file, catalogBody(JSON.stringify(catalog)))
console.log(`Updated ${CODIUM_MODELS.length} reviewed provider models from ${snapshot.checkedAt}.`)

function prices(pricing: Record<string, unknown>) {
  const perMillion = (value: unknown) => Number((Number(value) * 1_000_000).toFixed(8))
  return {
    input: perMillion(pricing.prompt),
    output: perMillion(pricing.completion),
    ...(pricing.input_cache_read !== undefined ? { cache_read: perMillion(pricing.input_cache_read) } : {}),
    ...(pricing.input_cache_write !== undefined ? { cache_write: perMillion(pricing.input_cache_write) } : {}),
  }
}
