import {
  createComputed,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { loadDismissed, saveDismissed } from "./background-tasks-state"
import {
  buildTaskCards,
  isDismissed,
  isLive,
  liveAgentCount,
  runningAgentCount,
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
  openAgent(agent: TaskAgent): void
  clearFinished(): void
  /** Brings back a card the trash hid, when a chip asks for it. */
  undismiss(cardKey: string): void
  /** While the caller is mounted, keep these agents' sessions cached and load old ones that have no usage record. */
  hold(agents: Accessor<readonly TaskAgent[]>): void
}

const Context = createContext<BackgroundTasks>()

/** Undefined outside a session page, so shared components can fall back to their old rendering. */
export function useBackgroundTasks() {
  return useContext(Context)
}

export function BackgroundTasksProvider(props: ParentProps<{ sessionID: Accessor<string | undefined> }>) {
  const sync = useSync()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const params = useParams<{ serverKey?: string }>()

  const rootID = createMemo(() => {
    let id = props.sessionID()
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      const parent = sync().session.get(id)?.parentID
      if (!parent) return id
      id = parent
    }
    return id
  })

  // With a subagent open, the task parts live in the parent's history.
  createEffect(
    on(rootID, (root) => {
      if (!root || root === props.sessionID() || sync().data.message[root]) return
      void sync()
        .session.sync(root)
        .catch(() => undefined)
    }),
  )

  // The children route covers subagents whose task parts sit in history pages
  // that are not loaded. Live ones are in the store already and win.
  const [fetched, setFetched] = createSignal<readonly Session[]>([])
  createEffect(
    on(rootID, (root) => {
      setFetched([])
      if (!root) return
      let alive = true
      onCleanup(() => {
        alive = false
      })
      Promise.resolve(sdk().client.session.children({ sessionID: root }))
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
    for (const session of sync().data.session) if (session.parentID === root) found.set(session.id, session)
    return [...found.values()].map((session) => sync().session.get(session.id) ?? session)
  })

  const source = (root: string): TaskSource => ({
    rootID: root,
    messages: (id) => sync().data.message[id],
    parts: (id) => sync().data.part[id],
    session: (id) => sync().session.get(id) ?? fetchedByID().get(id),
    children: children(),
    status: (id) => sync().data.session_status[id],
    waiting: (id) => (sync().data.permission[id]?.length ?? 0) > 0 || (sync().data.question[id]?.length ?? 0) > 0,
    modelName: (providerID, modelID) => sync().data.provider?.all?.get(providerID)?.models?.[modelID]?.name,
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

  // A record left saying queued or running by an engine restart only settles
  // from the child's last reply. After a reload an idle child has no
  // session_status entry and nothing else loads a live agent's messages, so
  // load them once for each such agent, pane open or not.
  const settling = new Set<string>()
  createEffect(() => {
    for (const card of state.cards) {
      for (const agent of card.agents) {
        const id = agent.sessionID
        if (!id || !isLive(agent.status) || settling.has(id)) continue
        const status = sync().data.session_status[id]?.type
        if (status === "busy" || status === "retry" || sync().data.message[id]) continue
        settling.add(id)
        void sync()
          .session.sync(id)
          .catch(() => undefined)
      }
    }
  })

  const index = createMemo(() => {
    const map = new Map<string, TaskLocation>()
    for (const card of state.cards) {
      for (const phase of card.phases) {
        const first = phase.agents.findIndex((agent) => agent.partID !== undefined)
        phase.agents.forEach((agent, position) => {
          if (agent.partID) map.set(agent.partID, { card, phase, agent, first: position === first })
          // A part that only extended this agent's run renders nothing of its own.
          for (const partID of agent.extendPartIDs ?? []) map.set(partID, { card, phase, agent, first: false })
        })
      }
    }
    return map
  })

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

  const stop = async (card: TaskCard) => {
    const client = sdk().client
    const ids = card.agents.filter((agent) => isLive(agent.status) && agent.sessionID).map((agent) => agent.sessionID!)
    const results = await Promise.allSettled(
      ids.map((sessionID) =>
        Promise.resolve(client.session.abort({ sessionID })).then((result) => {
          const error = (result as { error?: unknown } | undefined)?.error
          if (error) throw error
        }),
      ),
    )
    if (results.every((result) => result.status === "fulfilled")) return
    showToast({
      variant: "error",
      title: "Could not stop every subagent",
      description: "Try again, or stop the whole session from the composer.",
    })
  }

  const href = (sessionID: string) =>
    params.serverKey
      ? sessionHref(requireServerKey(params.serverKey), sessionID)
      : legacySessionHref(sdk().directory, sessionID)

  const openAgent = (agent: TaskAgent) => {
    if (!agent.sessionID) return
    navigate(href(agent.sessionID))
  }

  const attempted = new Set<string>()
  const hold = (agents: Accessor<readonly TaskAgent[]>) => {
    const ids = createMemo(() =>
      [...new Set(agents().flatMap((agent) => (agent.sessionID ? [agent.sessionID] : [])))].sort().join("\n"),
    )
    createEffect(
      on(ids, (value) => {
        const list = value ? value.split("\n") : []
        for (const id of list) serverSync().session.pin(id)
        onCleanup(() => {
          for (const id of list) serverSync().session.unpin(id)
        })
      }),
    )
    // Sessions from before the lifecycle record only know their tokens from
    // their own messages, which the cache may have evicted.
    createEffect(() => {
      for (const agent of agents()) {
        const id = agent.sessionID
        if (!id || isLive(agent.status) || agent.tokens !== undefined || attempted.has(id)) continue
        if (sync().data.message[id]) continue
        attempted.add(id)
        void sync()
          .session.sync(id)
          .catch(() => undefined)
      }
    })
  }

  const value: BackgroundTasks = {
    rootID,
    cards: () => state.cards,
    live,
    finished,
    liveCount,
    runningCount,
    now,
    locate: (partID) => index().get(partID),
    stop,
    openAgent,
    clearFinished,
    undismiss,
    hold,
  }

  return <Context.Provider value={value}>{props.children}</Context.Provider>
}
