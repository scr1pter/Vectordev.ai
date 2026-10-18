import type { FreeModelInfo } from "@vectordevai/schema/free-model"
import { BARRED_FREE_PROVIDERS, freeModelDataPolicy, isFreeModelID, isFreeRouter } from "./free-model-catalog.js"
import {
  FREE_MODEL_TRAINING_CONSENT_REQUIRED,
  FREE_MODEL_TRAINING_GUEST_SESSION,
  FREE_MODELS_TITLE,
} from "./free-model-choice.js"

const DISABLED_PLUGINS = [
  "web",
  "file-parser",
  "response-healing",
  "context-compression",
  "auto-router",
  "pareto-router",
]

export function serializeFreeModelRequest(body: ReturnType<typeof freeModelRequest>, shared: boolean) {
  const text = JSON.stringify(body)
  if (shared && new TextEncoder().encode(text).byteLength > 4_500_000)
    throw new Error(
      "Context too large for the shared free allowance. Compact this conversation or connect OpenRouter to continue with your own account.",
    )
  return text
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Nothing is sent to a free model whose provider may train on prompts until the user has accepted that once. */
export class FreeModelTrainingConsentError extends Error {
  override readonly name = "FreeModelTrainingConsentError"
  constructor() {
    super(FREE_MODEL_TRAINING_CONSENT_REQUIRED)
  }
}

/** Nothing from a session an invited guest has worked in goes to such a model, since the guest never accepted. */
export class FreeModelGuestSessionError extends Error {
  override readonly name = "FreeModelGuestSessionError"
  constructor() {
    super(FREE_MODEL_TRAINING_GUEST_SESSION)
  }
}

export function freeModelRequest(
  body: unknown,
  models: readonly FreeModelInfo[],
  options: { trainingConsent?: boolean; guest?: boolean } = {},
) {
  if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages) || !body.messages.length)
    throw new Error("Choose a free model and include conversation messages.")
  const selected = models.find((model) => model.id === body.model && isFreeModelID(model.id))
  if (!selected)
    throw new Error(`That free model is no longer available. Choose another model from ${FREE_MODELS_TITLE}.`)
  const policy = freeModelDataPolicy(selected)
  if (policy !== "no-training" && options.guest) throw new FreeModelGuestSessionError()
  if (policy !== "no-training" && !options.trainingConsent) throw new FreeModelTrainingConsentError()
  if (
    (body.plugins !== undefined &&
      (!Array.isArray(body.plugins) ||
        body.plugins.some(
          (plugin) =>
            !isRecord(plugin) ||
            typeof plugin.id !== "string" ||
            !DISABLED_PLUGINS.includes(plugin.id) ||
            plugin.enabled !== false ||
            Object.keys(plugin).some((key) => key !== "id" && key !== "enabled"),
        ))) ||
    body.preset !== undefined ||
    body.modalities !== undefined
  )
    throw new Error(`Paid plugins, presets, and generated media are not available through ${FREE_MODELS_TITLE}.`)
  const messages = body.messages.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.role !== "string" ||
      !["system", "developer", "user", "assistant", "tool"].includes(value.role)
    )
      throw new Error("A conversation message is invalid.")
    if (value.content !== undefined && value.content !== null && typeof value.content !== "string") {
      if (
        !Array.isArray(value.content) ||
        value.content.some((part) => !isRecord(part) || part.type !== "text" || typeof part.text !== "string")
      )
        throw new Error(
          `${FREE_MODELS_TITLE} currently accept text and tool messages. Connect a provider that supports this attachment.`,
        )
    }
    if (
      value.tool_calls !== undefined &&
      (!Array.isArray(value.tool_calls) || value.tool_calls.some((tool) => !isRecord(tool) || tool.type !== "function"))
    )
      throw new Error("A tool message is invalid.")
    return Object.fromEntries(
      Object.entries(value).filter(([key]) =>
        ["role", "content", "name", "tool_calls", "tool_call_id", "reasoning", "reasoning_details"].includes(key),
      ),
    )
  })
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some((tool) => !isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)))
  )
    throw new Error(`Only local function tools are supported by ${FREE_MODELS_TITLE}.`)
  // A fallback never weakens the chosen model's policy, and data_collection below is set once for the whole list. A
  // no-training or unreviewed choice falls back only to no-training models, all sent "deny". An accepted may-train
  // choice falls back only to may-train models served by the same provider: a different provider has its own terms,
  // and a no-training model must never receive "allow".
  // The free router picks its own model and is never a fallback for another: it has no providers to name.
  const router = isFreeRouter(selected.id)
  const providerSlugs = (model: FreeModelInfo) => model.providers.map((provider) => provider.id.split("/")[0] ?? "")
  const fallbacks = [
    selected,
    ...models.filter((model) => {
      if (router || model.id === selected.id || !isFreeModelID(model.id) || isFreeRouter(model.id)) return false
      if (policy !== "may-train") return freeModelDataPolicy(model) === "no-training"
      return (
        freeModelDataPolicy(model) === "may-train" &&
        providerSlugs(model).every((slug) => providerSlugs(selected).includes(slug))
      )
    }),
  ].slice(0, 3)
  const ceiling = Math.min(...fallbacks.map((model) => model.maxOutputTokens))
  const requested = body.max_tokens ?? body.max_completion_tokens ?? Math.min(8192, ceiling)
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1)
    throw new Error("The requested response length is invalid.")
  // The free router picks among OpenRouter's free models, so it cannot name providers; it asks OpenRouter to skip
  // barred ones instead.
  const routing: { only?: string[]; ignore?: string[] } = router
    ? { ignore: [...BARRED_FREE_PROVIDERS] }
    : { only: [...new Set(fallbacks.flatMap((model) => model.providers.map((provider) => provider.id)))] }
  // An endpoint without tool_choice still calls tools on its own; an automatic choice is the same request without it.
  const dropToolChoice =
    selected.toolChoice === false && (body.tool_choice === "auto" || body.tool_choice === undefined)
  return {
    ...Object.fromEntries(
      Object.entries(body).filter(
        ([key]) =>
          (key !== "tool_choice" || !dropToolChoice) &&
          [
            "temperature",
            "top_p",
            "stop",
            "seed",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "frequency_penalty",
            "presence_penalty",
            "reasoning",
            "response_format",
          ].includes(key),
      ),
    ),
    model: selected.id,
    models: fallbacks.map((model) => model.id),
    messages,
    max_tokens: Math.min(requested, ceiling),
    stream: true,
    stream_options: { include_usage: true },
    // Omitting plugins inherits account defaults, which can add paid services.
    // Explicit disablement survives client/server normalization; enforced account plugins must also be off.
    // https://openrouter.ai/docs/guides/features/plugins
    plugins: DISABLED_PLUGINS.map((id) => ({ id, enabled: false })),
    // Zero data retention is not requested: most free endpoints keep prompts under their own policy, and requiring it
    // would exclude them. data_collection: "deny" asks OpenRouter to exclude endpoints it records as training on
    // prompts. It is lifted only for a reviewed may-train model the user has accepted; an unreviewed model always keeps
    // it. The provider list plus zero max_price leave no paid endpoint to fall back to. OpenRouter does not document
    // whether a router honours the free router's `ignore`; the zero max_price holds either way.
    provider: {
      data_collection: policy === "may-train" ? "allow" : "deny",
      require_parameters: true,
      ...routing,
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
    },
  }
}
