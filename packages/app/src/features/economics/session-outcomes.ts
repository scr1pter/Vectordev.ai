// Records a model outcome when an ordinary session finishes.
//
// The engine originally learned only from parallel-workspace runs that ran
// validation, which is a small fraction of real use — so it never accumulated
// enough samples to recommend anything and the feature appeared dead. Ordinary
// sessions carry the same evidence that matters: which model ran, what it
// actually cost, how long it took, and how many files it touched.

import { categorizeTask } from "./task-categorizer"
import { measureUsage, type UsageBearingMessage } from "./token-usage"
import type { ModelOutcome } from "./economics-types"

type MessageEntry = {
  info?: UsageBearingMessage & { id?: string; role?: string; time?: { created?: number; completed?: number } }
}
type PartEntry = { type?: string; tool?: string; state?: { input?: Record<string, unknown> } }

function firstUserText(parts: Record<string, PartEntry[] | undefined>, messages: MessageEntry[]) {
  for (const message of messages) {
    if (message.info?.role !== "user") continue
    const id = message.info.id
    const text = (parts[id ?? ""] ?? []).find((part) => part.type === "text") as { text?: string } | undefined
    if (text?.text?.trim()) return text.text
  }
  return ""
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
}): ModelOutcome | undefined {
  const infos = input.messages.map((entry) => entry.info).filter((info): info is NonNullable<typeof info> => Boolean(info))
  const measured = measureUsage(infos)
  // No reported usage means nothing worth learning from — a session that never
  // reached a provider tells us nothing about that model.
  if (!measured?.provider || !measured.model) return undefined

  const assistant = infos.filter((info) => info.role === "assistant")
  const started = assistant[0]?.time?.created
  const finished = assistant[assistant.length - 1]?.time?.completed ?? assistant[assistant.length - 1]?.time?.created
  const latencyMs = typeof started === "number" && typeof finished === "number" ? Math.max(0, finished - started) : 0

  return {
    // The session id keeps this idempotent: recordOutcome dedupes on id, so a
    // session that goes idle several times records once.
    id: `session:${input.sessionID}`,
    projectId: input.projectId,
    provider: measured.provider,
    model: measured.model,
    category: categorizeTask(firstUserText(input.parts, input.messages)),
    createdAt: Date.now(),
    hadChecks: false,
    latencyMs,
    changedFiles: changedFileCount(input.parts),
    usage: measured.usage,
    costUsd: measured.costUsd,
  }
}
