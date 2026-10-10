import { createComputed, createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Session } from "@vectordevai/sdk/v2"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import type { DirectorySync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { modelDisplayName } from "@/utils/provider-brand"
import { loadDismissed, saveDismissed } from "./background-tasks-state"
import {
  buildTaskCards,
  freshestSession,
  idleLiveSessions,
  isDismissed,
  isLive,
  liveAgentCount,
  liveBackgroundSessions,
  runningAgentCount,
  taskPartLocations,
  type TaskAgent,
  type TaskCard,
  type TaskLocation,
  type TaskSource,
} from "./subagent-model"

export type BackgroundTasks = {
  /** The top of the open session's family: its own id, or its parent's when a subagent is open. */
  rootID: Accessor<string | undefined>
  cards: Accessor<readonly TaskCard[]>
  live: Accessor<readonly TaskCard[]>
  /** Finished cards the trash has not hidden. */
  finished: Accessor<readonly TaskCard[]>
  /** Agents running, waiting or queued: what keeps the clock ticking. */
  liveCount: Accessor<number>
  /** Agents running or waiting on you, for the header badge. Queued ones have not started. */
  runningCount: Accessor<number>
  /** A shared one-second clock that only ticks while something is live. */
  now: Accessor<number>
  locate(partID: string): TaskLocation | undefined
  stop(card: TaskCard): Promise<void>
  /** Sessions of the background agents still running, which Stop on the main turn leaves alone. */
  liveBackground: Accessor<readonly string[]>
  /** Stops every background agent still running in this session's family. */
  stopAllBackground(): Promise<void>
  openAgent(agent: TaskAgent): void
  clearFinished(): void
  /** Brings back a card the trash hid, when a chip asks for it. */
  undismiss(cardKey: string): void
  /** While the caller is mounted, keep these agents' sessions cached and load old ones that have no usage record. */
  hold(agents: Accessor<readonly TaskAgent[]>): void
}

export type BackgroundTasksInput = {
  /** The open session. */
  sessionID: Accessor<string | undefined>
  sync: Accessor<DirectorySync>
  client: Accessor<VectorClient>
  /** Counts the event stream's reconnects; whatever happened while it was down never arrives as events. */
  reconnects: Accessor<number>
  /** Keeps a session cached while something shows it. */
  pin(sessionID: string): void
  unpin(sessionID: string): void
  /** Opens a session's page. */
  open(sessionID: string): void
}

/** The Background tasks state for the open session's family, built from the session store and kept current. */
export function createBackgroundTasks(input: BackgroundTasksInput): BackgroundTasks {
  const rootID = createMemo(() => {
    let id = input.sessionID()
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      const parent = input.sync().session.get(id)?.parentID
      if (!parent) return id
      id = parent
    }
    return id
  })

  // With a subagent open, the task parts live in the parent's history.
  createEffect(
    on(rootID, (root) => {
      if (!root || root === input.sessionID() || input.sync().data.message[root]) return
      void input
        .sync()
        .session.sync(root)
        .catch(() => undefined)
    }),
  )

  // The children route covers subagents whose task parts sit in history pages
  // that are not loaded. A reconnected stream fetches it again, since the
  // records it missed only arrive that way for children nothing else loads.
  const [fetched, setFetched] = createSignal<readonly Session[]>([])
  createEffect(
    on([rootID, input.reconnects], (current, previous) => {
      const root = current[0]
      if (root !== previous?.[0]) setFetched([])
      if (!root) return
      let alive = true
      onCleanup(() => {
        alive = false
      })
      Promise.resolve(input.client().session.children({ sessionID: root }))
        .then((result) => {
          if (alive) setFetched(result?.data ?? [])
        })
        .catch(() => undefined)
    }),
  )
  const fetchedByID = createMemo(() => new Map(fetched().map((session) => [session.id, session])))

  const children = createMemo(() => {
    const root = rootID()
    if (!root) return [] as Session[]
    const found = new Map<string, Session>()
    for (const session of fetched()) if (session.parentID === root) found.set(session.id, session)
    for (const session of input.sync().data.session) if (session.parentID === root) found.set(session.id, session)
    // The store follows live events and the fetch is a snapshot: whichever the engine updated last is current.
    return [...found.values()].map(
      (session) => freshestSession(input.sync().session.get(session.id), fetchedByID().get(session.id)) ?? session,
    )
  })

  const source = (root: string): TaskSource => ({
    rootID: root,
    messages: (id) => input.sync().data.message[id],
    parts: (id) => input.sync().data.part[id],
    session: (id) => freshestSession(input.sync().session.get(id), fetchedByID().get(id)),
    children: children(),
    status: (id) => input.sync().data.session_status[id],
    waiting: (id) =>
      (input.sync().data.permission[id]?.length ?? 0) > 0 || (input.sync().data.question[id]?.length ?? 0) > 0,
    modelName: (providerID, modelID) => {
      const provider = input.sync().data.provider?.all?.get(providerID)
      const model = provider?.models?.[modelID]
      return provider && model ? modelDisplayName({ ...model, provider }) : undefined
    },
  })

  // Reconciled by key so cards, phases and agents keep their identity across
  // updates: the list never remounts and open phases stay open.
  const [state, setState] = createStore({ cards: [] as TaskCard[] })
  // This runs inside the session page, so a part in a shape nobody expected
  // keeps the last good list instead of taking the page down.
  createComputed(() => {
    const root = rootID()
    let next: TaskCard[] = []
    try {
      next = root ? buildTaskCards(source(root)) : []
    } catch (error) {
      console.error("[background-tasks] could not read subagents", error)
      return
    }
    setState("cards", reconcile(next, { key: "key" }))
  })

  // A card left live by an engine restart, or by events lost while the
  // stream was down, only settles from a fresh copy of the child: its record
  // and its last reply. After a reload an idle child has no session_status
  // entry, and messages already cached can be the stale part, so reload each
  // such agent once, pane open or not, and once more after each reconnect.
  const settling = new Set<string>()
  let settlingRound = 0
  createEffect(() => {
    const round = input.reconnects()
    if (round !== settlingRound) settling.clear()
    settlingRound = round
    const agents = state.cards.flatMap((card) => card.agents)
    for (const id of idleLiveSessions(agents, (sessionID) => input.sync().data.session_status[sessionID]?.type)) {
      if (settling.has(id)) continue
      settling.add(id)
      void input
        .sync()
        .session.sync(id, { force: true })
        .catch(() => undefined)
    }
  })

  // The open session, its family's root (whose history holds the task parts)
  // and the children whose messages are loaded all missed whatever happened
  // while the stream was down.
  createEffect(
    on(
      input.reconnects,
      () => {
        const loaded = children().flatMap((child) => (input.sync().data.message[child.id] ? [child.id] : []))
        for (const id of new Set([input.sessionID(), rootID(), ...loaded])) {
          if (!id) continue
          void input
            .sync()
            .session.sync(id, { force: true })
            .catch(() => undefined)
        }
      },
      { defer: true },
    ),
  )

  const index = createMemo(() => taskPartLocations(state.cards))

  const liveCount = createMemo(() => liveAgentCount(state.cards))
  const runningCount = createMemo(() => runningAgentCount(state.cards))
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (liveCount() === 0) return
    setNow(Date.now())
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return
      setNow(Date.now())
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })

  const [dismissed, setDismissed] = createSignal<Record<string, number>>({})
  createEffect(on(rootID, (root) => setDismissed(root ? loadDismissed(root) : {})))

  const live = createMemo(() => state.cards.filter((card) => card.live))
  const finished = createMemo(() => {
    const hidden = dismissed()
    return state.cards.filter((card) => !card.live && !isDismissed(card, hidden[card.key]))
  })

  const clearFinished = () => {
    const root = rootID()
    if (!root) return
    const at = Date.now()
    const next = { ...dismissed() }
    for (const card of finished()) next[card.key] = Math.max(at, card.endedAt ?? 0)
    setDismissed(next)
    saveDismissed(root, next)
  }

  const undismiss = (cardKey: string) => {
    const root = rootID()
    const current = dismissed()
    if (!root || !(cardKey in current)) return
    const next = { ...current }
    delete next[cardKey]
    setDismissed(next)
    saveDismissed(root, next)
  }

  const stopSessions = async (ids: readonly string[]) => {
    const client = input.client()
    const results = await Promise.allSettled(
      ids.map((sessionID) =>
        Promise.resolve(client.session.abort({ sessionID })).then((result) => {
          const error = (result as { error?: unknown } | undefined)?.error
          if (error) throw error
        }),
      ),
    )
    // Reload what the cards are built from, so Stop always shows where each
    // agent really is, even with the event stream down. An agent whose run the
    // engine lost (it restarted mid-run) is settled as stopped by the abort.
    const root = rootID()
    await Promise.allSettled(
      [...ids, ...(root ? [root] : [])].map((sessionID) => input.sync().session.sync(sessionID, { force: true })),
    )
    if (results.every((result) => result.status === "fulfilled")) return
    showToast({
      variant: "error",
      title: "Could not stop every subagent",
      description: "Try again, or stop the whole session from the composer.",
    })
  }

  const stop = (card: TaskCard) =>
    stopSessions(
      card.agents.filter((agent) => isLive(agent.status) && agent.sessionID).map((agent) => agent.sessionID!),
    )
  const liveBackground = createMemo(() => liveBackgroundSessions(state.cards))
  const stopAllBackground = () => stopSessions(liveBackground())

  const openAgent = (agent: TaskAgent) => {
    if (!agent.sessionID) return
    input.open(agent.sessionID)
  }

  const attempted = new Set<string>()
  const hold = (agents: Accessor<readonly TaskAgent[]>) => {
    const ids = createMemo(() =>
      [...new Set(agents().flatMap((agent) => (agent.sessionID ? [agent.sessionID] : [])))].sort().join("\n"),
    )
    createEffect(
      on(ids, (value) => {
        const list = value ? value.split("\n") : []
        for (const id of list) input.pin(id)
        onCleanup(() => {
          for (const id of list) input.unpin(id)
        })
      }),
    )
    // Sessions from before the lifecycle record only know their tokens from
    // their own messages, which the cache may have evicted.
    createEffect(() => {
      for (const agent of agents()) {
        const id = agent.sessionID
        if (!id || isLive(agent.status) || agent.tokens !== undefined || attempted.has(id)) continue
        if (input.sync().data.message[id]) continue
        attempted.add(id)
        void input
          .sync()
          .session.sync(id)
          .catch(() => undefined)
      }
    })
  }

  return {
    rootID,
    cards: () => state.cards,
    live,
    finished,
    liveCount,
    runningCount,
    now,
    locate: (partID) => index().get(partID),
    stop,
    liveBackground,
    stopAllBackground,
    openAgent,
    clearFinished,
    undismiss,
    hold,
  }
}
