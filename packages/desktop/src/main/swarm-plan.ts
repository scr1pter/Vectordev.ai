export type SwarmStrategy = "economy" | "balanced" | "quality"

export type SwarmAgentRole = "explore" | "implement" | "debug" | "test" | "review" | "security" | "docs"

export type SwarmModelTier = "fast" | "balanced" | "strong"

export type SwarmPlanTask = {
  id: string
  title: string
  prompt: string
  role: SwarmAgentRole
  dependsOn: string[]
  fileHints: string[]
  modelTier: SwarmModelTier
}

export type SwarmPlan = {
  summary: string
  tasks: SwarmPlanTask[]
}

export type SwarmModelCandidate = {
  provider: string
  model: string
  label?: string
}

export type RoutedSwarmPlanTask = SwarmPlanTask & {
  provider: string
  model: string
}

const ROLES = new Set<string>(["explore", "implement", "debug", "test", "review", "security", "docs"])
const TIERS = new Set<string>(["fast", "balanced", "strong"])

export function parseSwarmPlan(value: string, objective: string, maxTasks = 12): SwarmPlan {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const firstBrace = value.indexOf("{")
  const lastBrace = value.lastIndexOf("}")
  const objectText = firstBrace >= 0 && lastBrace > firstBrace ? value.slice(firstBrace, lastBrace + 1) : undefined
  const parsed = [fenced, objectText]
    .filter((item): item is string => Boolean(item?.trim()))
    .map((item) => {
      try {
        return JSON.parse(item) as unknown
      } catch {
        return undefined
      }
    })
    .find(isRecord)

  if (!parsed) throw new Error("The planning agent did not return a JSON task graph.")
  const root = parsed
  if (!Array.isArray(root.tasks)) throw new Error("The planning agent returned no task list.")

  const limit = Math.max(2, Math.min(32, Math.floor(maxTasks)))
  const raw = root.tasks
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .slice(0, limit)
  if (raw.length < 2) throw new Error("A swarm plan needs at least two coordinated tasks.")

  const ids = raw.map((item, index) => safeTaskID(typeof item.id === "string" ? item.id : `task-${index + 1}`, index))
  if (new Set(ids).size !== ids.length) throw new Error("The planning agent returned duplicate task IDs.")
  const originalIDs = new Map(
    raw.map((item, index) => [typeof item.id === "string" ? item.id.trim() : `task-${index + 1}`, ids[index]]),
  )
  const known = new Set(ids)
  const tasks = raw.map((item, index): SwarmPlanTask => {
    const role = isRole(item.role) ? item.role : "implement"
    const modelTier = isTier(item.modelTier)
      ? item.modelTier
      : role === "explore" || role === "docs"
        ? "fast"
        : role === "security" || role === "debug"
          ? "strong"
          : "balanced"
    const id = ids[index]
    const dependsOn = Array.isArray(item.dependsOn)
      ? [
          ...new Set(
            item.dependsOn
              .filter((dependency): dependency is string => typeof dependency === "string")
              .map((dependency) => originalIDs.get(dependency.trim()) ?? safeTaskID(dependency, 0))
              .filter((dependency) => dependency !== id && known.has(dependency)),
          ),
        ]
      : []
    return {
      id,
      title: stringValue(item.title) || `Task ${index + 1}`,
      prompt:
        stringValue(item.prompt) || stringValue(item.description) || `Complete task ${index + 1} for: ${objective}`,
      role,
      dependsOn,
      fileHints: Array.isArray(item.fileHints)
        ? item.fileHints
            .filter((file): file is string => typeof file === "string" && Boolean(file.trim()))
            .map((file) => file.trim())
            .slice(0, 24)
        : [],
      modelTier,
    }
  })

  assertAcyclic(tasks)
  return {
    summary: stringValue(root.summary) || `Vector decomposed the objective into ${tasks.length} coordinated tasks.`,
    tasks,
  }
}

export function fallbackSwarmPlan(objective: string, maxTasks = 4): SwarmPlan {
  const tasks = (
    [
      {
        id: "map-project",
        title: "Map the relevant project surface",
        prompt: `Inspect the repository for the smallest set of files, dependencies, conventions, and risks needed to complete this objective. Do not edit files. Objective: ${objective}`,
        role: "explore",
        dependsOn: [],
        fileHints: [],
        modelTier: "fast",
      },
      {
        id: "implement-objective",
        title: "Implement the objective",
        prompt: `Implement the complete objective using the project map from the dependency task. Keep the change focused and production-ready. Objective: ${objective}`,
        role: "implement",
        dependsOn: ["map-project"],
        fileHints: [],
        modelTier: "strong",
      },
      {
        id: "validate-result",
        title: "Validate the implementation",
        prompt: `Run the most relevant tests, type checks, builds, or focused runtime checks for this objective. Repair defects you find without expanding scope. Objective: ${objective}`,
        role: "test",
        dependsOn: ["implement-objective"],
        fileHints: [],
        modelTier: "balanced",
      },
      {
        id: "review-result",
        title: "Review risk and completeness",
        prompt: `Review the implementation for regressions, security issues, missing edge cases, and incomplete requirements. Make only necessary fixes. Objective: ${objective}`,
        role: "review",
        dependsOn: ["implement-objective"],
        fileHints: [],
        modelTier: "strong",
      },
    ] satisfies SwarmPlanTask[]
  ).slice(0, Math.max(2, Math.min(4, Math.floor(maxTasks))))

  if (tasks.length === 2) {
    tasks[1] = {
      ...tasks[1],
      prompt: `${tasks[1].prompt}\nAlso run the most relevant validation and review the final diff before finishing.`,
    }
  }
  return {
    summary:
      "Vector created a conservative inspect, implement, validate, and review workflow because the model plan could not be validated.",
    tasks,
  }
}

export function routeSwarmModels(
  tasks: SwarmPlanTask[],
  candidates: SwarmModelCandidate[],
  strategy: SwarmStrategy,
): RoutedSwarmPlanTask[] {
  if (!candidates.length) throw new Error("Connect at least one model provider before launching a swarm.")
  const usage = new Map(candidates.map((candidate) => [modelKey(candidate), 0]))
  return tasks.map((task) => {
    const target = desiredStrength(task, strategy)
    const selected = [...candidates].sort((left, right) => {
      const leftDistance = Math.abs(modelStrength(left) - target)
      const rightDistance = Math.abs(modelStrength(right) - target)
      if (leftDistance !== rightDistance) return leftDistance - rightDistance
      const load = (usage.get(modelKey(left)) ?? 0) - (usage.get(modelKey(right)) ?? 0)
      if (load !== 0) return load
      return modelKey(left).localeCompare(modelKey(right))
    })[0]
    usage.set(modelKey(selected), (usage.get(modelKey(selected)) ?? 0) + 1)
    return { ...task, provider: selected.provider, model: selected.model }
  })
}

export function selectSwarmPlannerModel(candidates: SwarmModelCandidate[], strategy: SwarmStrategy) {
  if (!candidates.length) throw new Error("Connect at least one model provider before launching a swarm.")
  const target = strategy === "economy" ? 2 : 3
  return [...candidates].sort((left, right) => {
    const distance = Math.abs(modelStrength(left) - target) - Math.abs(modelStrength(right) - target)
    if (distance !== 0) return distance
    return modelKey(left).localeCompare(modelKey(right))
  })[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isRole(value: unknown): value is SwarmAgentRole {
  return typeof value === "string" && ROLES.has(value)
}

function isTier(value: unknown): value is SwarmModelTier {
  return typeof value === "string" && TIERS.has(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function safeTaskID(value: string, index: number) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || `task-${index + 1}`
  )
}

function assertAcyclic(tasks: SwarmPlanTask[]) {
  const byID = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    const valid = (byID.get(id)?.dependsOn ?? []).every(visit)
    visiting.delete(id)
    visited.add(id)
    return valid
  }
  if (!tasks.every((task) => visit(task.id))) throw new Error("The planning agent returned a cyclic dependency graph.")
}

function modelKey(candidate: SwarmModelCandidate) {
  return `${candidate.provider}/${candidate.model}`
}

function modelStrength(candidate: SwarmModelCandidate) {
  const name = `${candidate.label ?? ""} ${candidate.model}`.toLowerCase()
  if (/(opus|gpt-5|o3|o4|pro|max|reasoning|large|ultra)/.test(name)) return 3
  if (/(haiku|flash|mini|lite|small|fast|free|instant|groq)/.test(name)) return 1
  return 2
}

function desiredStrength(task: SwarmPlanTask, strategy: SwarmStrategy) {
  if (strategy === "quality") return 3
  if (strategy === "economy") return task.role === "security" || task.role === "debug" ? 2 : 1
  if (task.modelTier === "strong") return 3
  if (task.modelTier === "fast") return 1
  return 2
}
