import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { TaskSize } from "@vectordevai/core/task-size"

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
  freeModel?: { source: "shared" | "openrouter" }
  capabilities?: {
    reasoning?: boolean
    toolcall?: boolean
    input?: Partial<Record<"text" | "image" | "audio" | "video" | "pdf", boolean>>
  }
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  variants?: Record<string, unknown>
}

export function supportsImageInput(model: RoutableModel) {
  if (model.capabilities?.input?.image === true) return true
  return model.modalities?.input?.includes("image") === true
}

export function isFreeModelSelection(model: RoutableModel) {
  return (
    model.provider.id === "vector" ||
    !!model.freeModel ||
    (model.provider.id === "openrouter" && model.id.toLowerCase().endsWith(":free"))
  )
}

// One classifier for the engine, the app and desktop: TaskSize sizes a request from what it says. The app's names for the
// sizes predate it.
const DIFFICULTY = {
  chat: "trivial",
  light: "simple",
  standard: "standard",
  thorough: "complex",
} as const satisfies Record<TaskSize.Tier, TaskDifficulty>

export function classifyTaskDifficulty(task: string): TaskDifficulty {
  if (!task.trim()) return "trivial"
  const result = TaskSize.classify({ text: task })
  // "ok", "yes", "continue" or "great" reply to the work before them, which only the engine can read them against.
  // Here they are never trivial (no quick lane) and never pick a model or a reasoning variant of their own.
  if (result.tier === "chat" && !TaskSize.social(result)) return "simple"
  return DIFFICULTY[result.tier]
}

function qualityScore(model: RoutableModel) {
  const label = `${model.id} ${model.name} ${model.family ?? ""}`.toLowerCase()
  const context = Math.max(1, model.limit?.context ?? 1)
  const frontier =
    /(?:opus|gpt[- ]?5[.-]?[5-9]|o[3-9](?:\b|-)|gemini.*pro|sonnet.*4|kimi.*k[23]|qwen.*coder.*(?:max|plus)|codestral)/.test(
      label,
    )
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
    .filter((model) => !isFreeModelSelection(input.current) || model.freeModel)
    .filter((model) => model.status !== "deprecated" && model.capabilities?.toolcall !== false)
    .toSorted((left, right) => qualityScore(right) - qualityScore(left))
  const strongest = candidates[0]
  if (!strongest || qualityScore(strongest) < qualityScore(input.current) + 12) {
    return { model: input.current, routed: false }
  }
  return { model: strongest, routed: strongest.id !== input.current.id }
}

export function routeModelForImages<T extends RoutableModel>(input: {
  current: T
  available: T[]
}): { model: T | undefined; routed: boolean } {
  // The guarded free route accepts text only; an image must never silently switch to paid inference.
  if (isFreeModelSelection(input.current)) return { model: undefined, routed: false }
  if (supportsImageInput(input.current)) return { model: input.current, routed: false }
  // Codium spends the account's credits, so an image never moves a prompt onto it; the person picks it themselves.
  const codium = input.current.provider.id === ModelPlanStatus.PROVIDER_ID
  const candidates = input.available
    .filter((model) => supportsImageInput(model))
    .filter((model) => codium || model.provider.id !== ModelPlanStatus.PROVIDER_ID)
    .filter((model) => model.status !== "deprecated" && model.capabilities?.toolcall !== false)
    .toSorted((left, right) => {
      const leftProvider = left.provider.id === input.current.provider.id ? 1 : 0
      const rightProvider = right.provider.id === input.current.provider.id ? 1 : 0
      return rightProvider - leftProvider || qualityScore(right) - qualityScore(left)
    })
  const selected = candidates[0]
  return { model: selected, routed: !!selected }
}

export function routeVariantForTask(input: { difficulty: TaskDifficulty; selected?: string; variants: string[] }) {
  if (input.selected && input.selected !== "default" && input.variants.includes(input.selected)) return input.selected
  const byName = (names: string[]) => names.find((name) => input.variants.includes(name))
  if (input.difficulty === "complex") return byName(["max", "ultra", "xhigh", "extra", "high"]) ?? input.selected
  if (input.difficulty === "standard") return byName(["balanced", "medium"]) ?? input.selected
  if (input.difficulty === "trivial") return byName(["light", "low"]) ?? input.selected
  return input.selected
}
