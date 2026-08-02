export type TaskDifficulty = "trivial" | "simple" | "standard" | "complex"

export type AgentTaskPreparation = {
  difficulty: TaskDifficulty
  useQuickAgent: boolean
  recommendedVariant: "light" | "balanced" | "max"
  retryLimit: number
  instruction?: string
}

type RoutableModel = {
  id: string
  name: string
  family?: string
  status?: string
  provider: { id: string }
  capabilities?: { reasoning?: boolean; toolcall?: boolean }
  limit?: { context?: number; output?: number }
  variants?: Record<string, unknown>
}

const TRIVIAL_TASK = /^(?:hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|good morning|good afternoon|good evening)[!.?\s]*$/i
const ACTION_TERMS = /\b(?:add|build|change|debug|delete|edit|fix|implement|improve|investigate|refactor|remove|rename|repair|test|update)\b/i
const COMPLEX_TERMS = [
  /\barchitecture\b/i,
  /\bmigrat(?:e|ion)\b/i,
  /\brefactor\b/i,
  /\bmulti[- ]?file\b/i,
  /\bcodebase\b/i,
  /\bend[- ]?to[- ]?end\b/i,
  /\bproduction[- ]?ready\b/i,
  /\bparallel\b/i,
  /\bperformance\b/i,
  /\bsecurity\b/i,
  /\b(?:build|implement|fix|test) (?:everything|all|the entire|the whole)\b/i,
]

export function classifyTaskDifficulty(task: string): TaskDifficulty {
  const text = task.trim()
  if (!text || TRIVIAL_TASK.test(text)) return "trivial"
  const paths = new Set(text.match(/[A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,8}/g) ?? [])
  const complexSignals = COMPLEX_TERMS.filter((pattern) => pattern.test(text)).length
  if (text.length >= 900 || paths.size >= 4 || complexSignals >= 2) return "complex"
  if (complexSignals === 1 && (text.length >= 260 || ACTION_TERMS.test(text))) return "complex"
  if (ACTION_TERMS.test(text) || text.length >= 180 || paths.size >= 2) return "standard"
  return "simple"
}

function qualityScore(model: RoutableModel) {
  const label = `${model.id} ${model.name} ${model.family ?? ""}`.toLowerCase()
  const context = Math.max(1, model.limit?.context ?? 1)
  const frontier = /(?:opus|gpt[- ]?5[.-]?[5-9]|o[3-9](?:\b|-)|gemini.*pro|sonnet.*4|kimi.*k[23]|qwen.*coder.*(?:max|plus)|codestral)/.test(label)
  const lightweight = /(?:nano|mini|flash|haiku|lite|small|free|\b[1-9]b\b)/.test(label)
  return (
    (model.capabilities?.reasoning ? 26 : 0) +
    (model.capabilities?.toolcall ? 18 : -40) +
    Math.min(30, Math.log2(context) * 1.35) +
    (frontier ? 34 : 0) -
    (lightweight ? 28 : 0) +
    (model.status === "active" ? 4 : 0) -
    (model.status === "deprecated" ? 80 : 0)
  )
}

export function routeModelForTask<T extends RoutableModel>(input: {
  difficulty: TaskDifficulty
  current: T
  available: T[]
}) {
  if (input.difficulty !== "complex") return { model: input.current, routed: false }
  const candidates = input.available
    .filter((model) => model.provider.id === input.current.provider.id)
    .filter((model) => model.status !== "deprecated" && model.capabilities?.toolcall !== false)
    .toSorted((left, right) => qualityScore(right) - qualityScore(left))
  const strongest = candidates[0]
  if (!strongest || qualityScore(strongest) < qualityScore(input.current) + 12) {
    return { model: input.current, routed: false }
  }
  return { model: strongest, routed: strongest.id !== input.current.id }
}

export function routeVariantForTask(input: {
  difficulty: TaskDifficulty
  selected?: string
  variants: string[]
}) {
  if (input.selected && input.selected !== "default") return input.selected
  const byName = (names: string[]) => names.find((name) => input.variants.includes(name))
  if (input.difficulty === "complex") return byName(["max", "ultra", "xhigh", "extra", "high"]) ?? input.selected
  if (input.difficulty === "standard") return byName(["balanced", "medium"]) ?? input.selected
  if (input.difficulty === "trivial") return byName(["light", "low"]) ?? input.selected
  return input.selected
}
