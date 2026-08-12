import { ApiError } from "./http.js"

export type ProviderDefinition = {
  id: string
  name: string
  env: string
  host: string
  header: string
  scheme?: string
  models: string[]
}

export type SavedProviderSecret = {
  apiKey: string
  models: string[]
}

export const PROVIDER_CATALOG: ProviderDefinition[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    env: "ANTHROPIC_API_KEY",
    host: "api.anthropic.com",
    header: "x-api-key",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    name: "OpenAI",
    env: "OPENAI_API_KEY",
    host: "api.openai.com",
    header: "Authorization",
    scheme: "Bearer",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  {
    id: "google",
    name: "Google Gemini",
    env: "GOOGLE_GENERATIVE_AI_API_KEY",
    host: "generativelanguage.googleapis.com",
    header: "x-goog-api-key",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
  {
    id: "groq",
    name: "Groq",
    env: "GROQ_API_KEY",
    host: "api.groq.com",
    header: "Authorization",
    scheme: "Bearer",
    models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3-32b"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    host: "openrouter.ai",
    header: "Authorization",
    scheme: "Bearer",
    models: ["openrouter/free", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro"],
  },
  {
    id: "xai",
    name: "xAI",
    env: "XAI_API_KEY",
    host: "api.x.ai",
    header: "Authorization",
    scheme: "Bearer",
    models: ["grok-code-fast-1", "grok-4", "grok-3-mini"],
  },
  {
    id: "mistral",
    name: "Mistral",
    env: "MISTRAL_API_KEY",
    host: "api.mistral.ai",
    header: "Authorization",
    scheme: "Bearer",
    models: ["codestral-latest", "devstral-medium-latest", "mistral-large-latest"],
  },
  {
    id: "togetherai",
    name: "Together AI",
    env: "TOGETHER_API_KEY",
    host: "api.together.xyz",
    header: "Authorization",
    scheme: "Bearer",
    models: ["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "deepseek-ai/DeepSeek-V3.1"],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    env: "DEEPINFRA_API_KEY",
    host: "api.deepinfra.com",
    header: "Authorization",
    scheme: "Bearer",
    models: ["Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3.1"],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    env: "CEREBRAS_API_KEY",
    host: "api.cerebras.ai",
    header: "Authorization",
    scheme: "Bearer",
    models: ["qwen-3-coder-480b", "llama-3.3-70b"],
  },
]

export function providerDefinition(id: string) {
  const provider = PROVIDER_CATALOG.find((item) => item.id === id)
  if (!provider) throw new ApiError(400, "PROVIDER_INVALID", "Choose a supported model provider.")
  return provider
}

export function cleanProviderModels(providerId: string, values: unknown) {
  const source = Array.isArray(values) ? values : []
  const models = source
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(new RegExp(`^${providerId}/`), ""))
    .filter((value) => value.length > 0 && value.length <= 180 && !/\s/.test(value))
  return [...new Set(models)].slice(0, 40)
}

export function providerModelId(providerId: string, model: string) {
  const cleaned = cleanProviderModels(providerId, [model])[0]
  if (!cleaned) throw new ApiError(400, "CLOUD_MODEL_INVALID", "Choose a valid model for this provider.")
  return `${providerId}/${cleaned}`
}

export function providerAuthorization(provider: ProviderDefinition, apiKey: string) {
  return provider.scheme ? `${provider.scheme} ${apiKey}` : apiKey
}
