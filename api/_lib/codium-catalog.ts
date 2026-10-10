// Reviewed against OpenRouter's /models and /endpoints/zdr on 2026-10-09.
// These are routing ceilings, not a promise that every provider has this price.
export const CODIUM_CATALOG_UPDATED = "2026-10-09"
export const CODIUM_MODELS = [
  {
    id: "qwen/qwen3-coder-next",
    name: "Qwen3 Coder Next",
    category: "everyday",
    description: "A coding-focused option for everyday edits, tests and agent tool use.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    inputPrice: 0.12,
    outputPrice: 0.8,
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    category: "everyday",
    description: "An alternative for coding and tasks that use several tools.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    inputPrice: 0.3,
    outputPrice: 1.2,
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    category: "advanced",
    description: "An optional coding model for difficult tasks, with a higher usage cost.",
    contextLength: 128000,
    maxOutputTokens: 8192,
    inputPrice: 0.71,
    outputPrice: 3.5,
  },
] as const
