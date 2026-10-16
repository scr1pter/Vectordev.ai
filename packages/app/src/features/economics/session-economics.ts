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
  const active = new Map<string, Session>()
  // The engine publishes idle right after the idle status, so the two announce one settlement. Whichever the app
  // observes first refreshes the family; the other would only read the root again at the same revision.
  const settled = new Set<string>()
  const outcomes = createSessionOutcomeRecorder(async (sessionID, directory, current) => {
    const client = input.client(directory)
    const key = JSON.stringify([directory, sessionID])
    const walked = roots.get(key)
    roots.delete(key)
    const before = walked ?? (await client.session.get({ sessionID }).catch(() => undefined))?.data
    if (!current()) return
    if (!before) throw new Error("Session metadata is unavailable")
    // Child spend is recorded through the root's family refresh; its full history is not a separate sample.
    if (before.parentID || isInternalSession(before)) return
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
      if (isInternalSession(cached) && !cached?.parentID) return undefined
      // Parent links never change, so only the root, whose revision decides the refresh, is read fresh.
      if (cached?.parentID) return cached
      const session = (await input.client(directory).session.get({ sessionID })).data
      if (!session || (isInternalSession(session) && !session.parentID)) return undefined
      if (!session.parentID) roots.set(JSON.stringify([session.directory, session.id]), session)
      return session
    },
    async (sessionID, directory, revision) => {
      if (!(await outcomes.refresh(sessionID, directory, revision))) return false
      return input.workspaces(sessionID, directory)
    },
  )
  // The idle event of a run the status snapshot already settled is a repeat. When the event comes first, the run leaves
  // active here, so the snapshot after this flush does not settle it again. A session still shown working keeps its
  // place, and its snapshot settles it once the idle status arrives.
  const repeatedIdle = (sessionID: string) => {
    if (!input.working(sessionID) && active.delete(sessionID)) return false
    return settled.delete(sessionID)
  }
  return {
    // Bootstrap reconciles statuses after reconnect without replaying idle. Capture the same busy-to-idle
    // transition from that reactive snapshot, so runs completed while disconnected still become samples.
    reconcile(sessions: readonly Session[]) {
      const observed = new Map([...active, ...sessions.map((session) => [session.id, session] as const)])
      observed.forEach((session) => {
        if (session.internal === "codespace.autocomplete") return
        if (input.working(session.id)) {
          active.set(session.id, session)
          settled.delete(session.id)
          return
        }
        if (!active.delete(session.id)) return
        settled.add(session.id)
        void family.refresh(session.id, session.directory).catch(() => undefined)
      })
    },
    handle(event: { name?: string; details: Event }) {
      const directory = event.name
      if (!directory) return
      // A new run starts a new settlement, even one that goes busy and idle within a single flush of events.
      if (event.details.type === "session.status" && event.details.properties.status.type !== "idle")
        settled.delete(event.details.properties.sessionID)
      // Idle reaches the root through the family refresh too, which records each settled revision once.
      const familyID = sessionFamilyEventID(event.details, input.working)
      const repeated = event.details.type === "session.idle" && repeatedIdle(event.details.properties.sessionID)
      const cached = familyID ? input.cached(familyID) : undefined
      // Frequent autocomplete updates are included at the task's next settlement; other helpers settle their
      // parent after completion, including a review that was launched after the parent became idle.
      const helper =
        isInternalSession(cached) ||
        (event.details.type === "session.updated" && isInternalSession(event.details.properties.info))
      if (
        familyID &&
        !repeated &&
        (!helper || (event.details.type === "session.idle" && cached?.internal !== "codespace.autocomplete"))
      )
        void family.refresh(familyID, directory).catch(() => undefined)
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
      active.clear()
      settled.clear()
    },
  }
}
