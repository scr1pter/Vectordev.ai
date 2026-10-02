import type { FreeModelInfo } from "@vectordevai/schema/free-model"
import { isFreeModelID } from "./free-model-catalog"

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

export function freeModelRequest(body: unknown, models: readonly FreeModelInfo[], personal = false) {
  if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages) || !body.messages.length)
    throw new Error("Choose a free model and include conversation messages.")
  const selected = models.find((model) => model.id === body.model && isFreeModelID(model.id))
  if (!selected)
    throw new Error("That free model is no longer available. Choose another model from Free models inside of Vector.")
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
    throw new Error(
      "Paid plugins, presets, and generated media are not available through Free models inside of Vector.",
    )
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
          "Free models inside of Vector currently accept text and tool messages. Connect a provider that supports this attachment.",
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
    throw new Error("Only local function tools are supported by Free models inside of Vector.")
  const fallbacks = [selected, ...models.filter((model) => model.id !== selected.id && isFreeModelID(model.id))].slice(
    0,
    3,
  )
  const ceiling = Math.min(...fallbacks.map((model) => model.maxOutputTokens))
  const requested = body.max_tokens ?? body.max_completion_tokens ?? Math.min(8192, ceiling)
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1)
    throw new Error("The requested response length is invalid.")
  return {
    ...Object.fromEntries(
      Object.entries(body).filter(([key]) =>
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
    provider: {
      data_collection: "deny",
      ...(personal ? { zdr: true } : {}),
      require_parameters: true,
      only: [...new Set(fallbacks.flatMap((model) => model.providers.map((provider) => provider.id)))],
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
    },
  }
}
