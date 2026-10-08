// Records a model outcome when an ordinary session finishes.
//
// The engine originally learned only from parallel-workspace runs that ran
// validation, which is a small fraction of real use — so it never accumulated
// enough samples to recommend anything and the feature appeared dead. Ordinary
// sessions carry the same evidence that matters: which model ran, what it
// actually cost, how long it took, and how many files it touched.

import { categorizeTask } from "./task-categorizer"
import { aggregateCostUsd, measureUsage, type UsageBearingMessage } from "./token-usage"
import type { ModelOutcome } from "./economics-types"

type MessageEntry = {
  info?: UsageBearingMessage & { id?: string; role?: string; time?: { created?: number; completed?: number } }
}
type PartEntry = { type?: string; text?: string; tool?: string; state?: { input?: Record<string, unknown> } }

function firstUserText(parts: Record<string, PartEntry[] | undefined>, messages: MessageEntry[]) {
  for (const message of messages) {
    if (message.info?.role !== "user") continue
    const id = message.info.id
    const text = (parts[id ?? ""] ?? []).find((part) => part.type === "text") as { text?: string } | undefined
    if (text?.text?.trim()) return text.text
  }
  return ""
}

export function categoryFromSession(messages: MessageEntry[], parts: Record<string, PartEntry[] | undefined>) {
  return categorizeTask(firstUserText(parts, messages))
}

// Distinct file paths any write-like tool touched. Counting tool calls instead
// would inflate the number every time an agent edits one file repeatedly.
function changedFileCount(parts: Record<string, PartEntry[] | undefined>) {
  const files = new Set<string>()
  for (const list of Object.values(parts)) {
    for (const part of list ?? []) {
      if (part.type !== "tool") continue
      if (!["write", "edit", "apply_patch", "patch"].includes(part.tool ?? "")) continue
      const path = part.state?.input?.filePath ?? part.state?.input?.path
      if (typeof path === "string" && path) files.add(path)
    }
  }
  return files.size
}

export function outcomeFromSession(input: {
  sessionID: string
  projectId: string
  messages: MessageEntry[]
  parts: Record<string, PartEntry[] | undefined>
  // The session's rollup of what its subagents spent; their steps are in their own sessions, not in these messages.
  subagents?: { subagentCost?: number; subagentUnpricedSteps?: number }
}): ModelOutcome | undefined {
  const infos = input.messages
    .map((entry) => entry.info)
    .filter((info): info is NonNullable<typeof info> => Boolean(info))
  const measured = measureUsage(infos)
  // No reported usage means nothing worth learning from — a session that never
  // reached a provider tells us nothing about that model.
  if (!measured?.provider || !measured.model) return undefined

  // Sum execution durations: the time a user waits between turns is not model
  // latency. History copied into a fork belongs to the original session.
  const assistant = infos.filter((info) => info.role === "assistant" && !(info as { forked?: boolean }).forked)
  const durations = assistant.map((info) => {
    const started = info.time?.created
    const finished = info.time?.completed
    return typeof started === "number" &&
      typeof finished === "number" &&
      Number.isFinite(started) &&
      Number.isFinite(finished) &&
      finished >= started
      ? finished - started
      : undefined
  })
  const latencyMeasured = durations.every((duration) => duration !== undefined)
  const latencyMs = durations.reduce<number>((total, duration) => total + (duration ?? 0), 0)
  // A model that delegates most of the work must not rank as cheap, so the task's cost includes its subagents.
  const costUsd = aggregateCostUsd(measured.costUsd, input.subagents)

  return {
    // Replace the session's cumulative sample when it goes idle again, keeping
    // one recorded run rather than inflating the evidence with every idle.
    id: `session:${input.sessionID}`,
    projectId: input.projectId,
    provider: measured.provider,
    model: measured.model,
    category: categoryFromSession(input.messages, input.parts),
    createdAt: Date.now(),
    hadChecks: false,
    latencyMs,
    latencyMeasured,
    changedFiles: changedFileCount(input.parts),
    usage: measured.usage,
    costUsd,
    ...(costUsd !== undefined ? { costPriced: true } : {}),
  }
}
