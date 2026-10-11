// Records ordinary sessions as economics outcomes from the server's event stream.
//
// Learning only from validated parallel runs left the engine with too few samples to ever recommend anything,
// which is why the feature looked dead. Ordinary sessions carry the same evidence.
import type { Event, Session, VectorClient } from "@vectordevai/sdk/v2/client"
import { successfulActivationFromSession } from "@/features/onboarding/onboarding-progress"
import { isInternalSession } from "@/utils/internal-sessions"
import type { recordSessionOutcome } from "./economics-repository"
import { createSessionFamilyRefresher, sessionFamilyEventID } from "./session-family"
import { createSessionOutcomeRecorder, outcomeFromSession } from "./session-outcomes"
import { measureUsage } from "./token-usage"

export function createSessionEconomics(input: {
  client: (directory: string) => VectorClient
  // The app's live session status: a running session's sample is read when it stops, not on every step.
  working: (sessionID: string) => boolean
  // Session metadata the app already holds, for the parent links of a subagent.
  cached: (sessionID: string) => Session | undefined
  save: typeof recordSessionOutcome
  // The session's history shows a prompt that got a real answer.
  activated: () => void
  // Parallel workspaces whose agent session is this root; resolves whether all of them recorded.
  workspaces: (sessionID: string, directory: string) => Promise<boolean>
}) {
  // The family walk reads a root fresh to learn its revision, then records it. That read is the sample's first
  // snapshot instead of a second one: the check after the history read still catches any change since. A retry
  // finds it taken and reads again.
  const roots = new Map<string, Session>()
  const outcomes = createSessionOutcomeRecorder(async (sessionID, directory, current) => {
    const client = input.client(directory)
    const key = JSON.stringify([directory, sessionID])
    const walked = roots.get(key)
    roots.delete(key)
    const before = walked ?? (await client.session.get({ sessionID }).catch(() => undefined))?.data
    if (!current()) return
    if (!before) throw new Error("Session metadata is unavailable")
    // Child spend is recorded through the root's family refresh; its full history is not a separate sample.
    if (before.parentID) return
    const history = await client.session.messages({ sessionID })
    if (!Array.isArray(history.data)) throw new Error("Session history is unavailable")
    if (!current()) return
    if (successfulActivationFromSession(history.data)) input.activated()
    // Missing usage is not evidence to remove a previous sample. Measured mixed-model usage is.
    if (!measureUsage(history.data.map((entry) => entry.info))) return
    const session = await client.session.get({ sessionID })
    if (!session.data) throw new Error("Session metadata is unavailable")
    if (!current()) return
    // Do not assign a newer metadata revision to history fetched before that revision existed.
    if (
      session.data.time.updated !== before.time.updated ||
      session.data.cost !== before.cost ||
      session.data.unpricedSteps !== before.unpricedSteps ||
      session.data.subagentCost !== before.subagentCost ||
      session.data.subagentUnpricedSteps !== before.subagentUnpricedSteps
    )
      throw new Error("Session changed while collecting usage")
    const parts = Object.fromEntries(history.data.map((entry) => [entry.info.id, entry.parts]))
    const outcome = outcomeFromSession({
      sessionID,
      projectId: directory,
      messages: history.data,
      parts,
      spend: session.data,
    })
    if (!outcome) {
      const models = new Set(
        history.data.flatMap((entry) => {
          const usage = measureUsage([entry.info])
          return usage?.provider && usage.model ? [JSON.stringify([usage.provider, usage.model])] : []
        }),
      )
      if (models.size < 2) return
    }
    await input.save({
      sessionID,
      projectId: directory,
      updatedAt: history.data.reduce(
        (latest, entry) =>
          Math.max(
            latest,
            entry.info.role === "assistant"
              ? (entry.info.time.completed ?? entry.info.time.created)
              : entry.info.time.created,
          ),
        session.data.time.updated,
      ),
      outcome,
    })
  })
  const family = createSessionFamilyRefresher(
    async (sessionID, directory) => {
      // A running ancestor refreshes the family itself when it goes idle, so the walk stops there.
      if (input.working(sessionID)) return undefined
      // Vector's own tool and review sessions are not the user's tasks, so they are never a sample.
      const cached = input.cached(sessionID)
      if (isInternalSession(cached)) return undefined
      // Parent links never change, so only the root, whose revision decides the refresh, is read fresh.
      if (cached?.parentID) return cached
      const session = (await input.client(directory).session.get({ sessionID })).data
      if (!session || isInternalSession(session)) return undefined
      if (!session.parentID) roots.set(JSON.stringify([session.directory, session.id]), session)
      return session
    },
    async (sessionID, directory, revision) => {
      if (!(await outcomes.refresh(sessionID, directory, revision))) return false
      return input.workspaces(sessionID, directory)
    },
  )
  return {
    handle(event: { name?: string; details: Event }) {
      const directory = event.name
      if (!directory) return
      // Idle reaches the root through the family refresh too, which records each settled revision once.
      const familyID = sessionFamilyEventID(event.details, input.working)
      if (familyID) void family.refresh(familyID, directory).catch(() => undefined)
      if (event.details.type === "session.updated") {
        const session = event.details.properties.info
        outcomes.changed(session.id, directory, session.time.updated)
        return
      }
      if (event.details.type !== "message.updated") return
      const message = event.details.properties.info
      if (message.role === "assistant" && message.time.completed)
        outcomes.changed(message.sessionID, directory, message.time.completed)
    },
    dispose() {
      family.dispose()
      outcomes.dispose()
      roots.clear()
    },
  }
}
