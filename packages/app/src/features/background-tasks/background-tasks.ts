import { createComputed, createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Session } from "@vectordevai/sdk/v2"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import type { Task } from "@vectordevai/schema/task"
import type { DirectorySync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { modelDisplayName } from "@/utils/provider-brand"
import { isInternalSession } from "@/utils/internal-sessions"
import { loadDismissed, saveDismissed } from "./background-tasks-state"
import { mergeTaskBoard, stoppableAgents } from "./task-board-model"
import {
  buildTaskCards,
  freshestSession,
  idleLiveSessions,
  isDismissed,
  isLive,
  liveAgentCount,
  runningAgentCount,
  taskPartLocations,
  waitingAgentCount,
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
  /** Agents with an unanswered permission or question. */
  waitingCount: Accessor<number>
  /** A shared one-second clock that only ticks while something is live. */
  now: Accessor<number>
  locate(partID: string): TaskLocation | undefined
  stop(card: TaskCard): Promise<void>
  /** Task identities of stoppable background agents, including desktop runners. */
  liveBackground: Accessor<readonly string[]>
  /** Stops every background agent still running in this session's family. */
  stopAllBackground(): Promise<void>
  openAgent(agent: TaskAgent): void
  canOpenAgent(agent: TaskAgent): boolean
  clearFinished(): void
  /** Brings back a card the trash hid, when a chip asks for it. */
  undismiss(cardKey: string): void
  /** While the caller is mounted, keep these agents' sessions cached and load old ones that have no usage record. */
  hold(agents: Accessor<readonly TaskAgent[]>): void
  inspect(agent: TaskAgent): Promise<Task.InspectResult>
  message(agent: TaskAgent, text: string): Promise<Task.MessageResult>
  stopAgent(agent: TaskAgent): Promise<void>
  ask(agent: TaskAgent): void
  refreshing: Accessor<boolean>
  error: Accessor<string | undefined>
  draft(agent: TaskAgent): string
  setDraft(agent: TaskAgent, text: string): void
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
  ask?(agent: TaskAgent, rootID: string): void
  openDesktop?(task: Task.Info): void
  desktop?: {
    api: NonNullable<NonNullable<Window["api"]>["agentTasks"]>
    sourcePath: Accessor<string>
  }
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
  const [board, setBoard] = createStore<{
    tasks: readonly Task.Info[]
    desktop: readonly Task.Info[]
    refreshing: boolean
    truncated: boolean
    error?: string
  }>({
    tasks: [],
    desktop: [],
    refreshing: false,
    truncated: false,
  })
  const [drafts, setDrafts] = createStore<Record<string, string>>({})
  let boardRequest = 0
  const refreshBoard = async () => {
    const sessionID = rootID()
    if (!sessionID) return
    const request = ++boardRequest
    setBoard("refreshing", true)
    const [result, desktop] = await Promise.all([
      input
        .client()
        .experimental.task.list({ sessionID, descendants: "true" })
        .catch(() => undefined),
      input.desktop?.api
        .list({ parentSessionID: sessionID, sourcePath: input.desktop.sourcePath() })
        .catch(() => undefined),
    ])
    if (request !== boardRequest || rootID() !== sessionID) return
    setBoard("refreshing", false)
    if (desktop) setBoard("desktop", desktop.tasks)
    if (result?.data) setBoard("truncated", result.data.truncated || desktop?.truncated === true)
    if (input.desktop && !desktop && board.desktop.length) {
      setBoard("error", "Desktop task updates unavailable. Showing the last known state.")
      if (result?.data) setBoard("tasks", result.data.tasks)
      return
    }
    if (!result?.data) {
      if (board.tasks.length) setBoard("error", "Task updates unavailable. Showing the last known state.")
      return
    }
    setBoard("tasks", result.data.tasks)
    setBoard(
      "error",
      result.data.truncated ? "Showing the most recent tasks. Open a child session for more." : undefined,
    )
  }
  createEffect(
    on(rootID, () => {
      boardRequest += 1
      setBoard({ tasks: [], desktop: [], refreshing: false, truncated: false, error: undefined })
    }),
  )

  const children = createMemo(() => {
    const root = rootID()
    if (!root) return [] as Session[]
    const found = new Map<string, Session>()
    // Vector's helpers (a Vectorscope review, autocomplete) are children too, but they are not the user's background
    // work; their spend is in the session's cost instead.
    for (const session of fetched())
      if (session.parentID === root && !isInternalSession(session)) found.set(session.id, session)
    for (const session of input.sync().data.session)
      if (session.parentID === root && !isInternalSession(session)) found.set(session.id, session)
    // The store follows live events and the fetch is a snapshot: whichever the engine updated last is current.
    return [...found.values()].map(
      (session) => freshestSession(input.sync().session.get(session.id), fetchedByID().get(session.id)) ?? session,
    )
  })
  // Refresh on engine events and reconnects, never on a polling interval. Batch
  // simultaneous child updates so a provider turn makes one observation request.
  createEffect(() => {
    const parent = rootID()
    if (parent) input.sync().session.get(parent)?.time.updated
    input.reconnects()
    children().forEach((child) => {
      child.time.updated
      input.sync().data.session_status[child.id]
      input.sync().data.permission[child.id]?.length
      input.sync().data.question[child.id]?.length
    })
    const timer = setTimeout(() => void refreshBoard(), 150)
    onCleanup(() => clearTimeout(timer))
  })
  onCleanup(() => {
    boardRequest += 1
  })
  if (input.desktop) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = input.desktop.api.onChange(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refreshBoard(), 150)
    })
    onCleanup(() => {
      stop()
      if (timer) clearTimeout(timer)
    })
  }

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
      next = root ? mergeTaskBoard(buildTaskCards(source(root)), [...board.tasks, ...board.desktop]) : []
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
  const waitingCount = createMemo(() => waitingAgentCount(state.cards))
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

  const stop = async (card: TaskCard) => {
    const results = await Promise.allSettled(stoppableAgents(card.agents).map(stopAgent))
    if (results.some((result) => result.status === "rejected"))
      showToast({
        variant: "error",
        title: "Could not stop every subagent",
        description: "Open its details to retry. Partial work has been kept.",
      })
  }
  const liveBackground = createMemo(() => [
    ...new Set(
      state.cards
        .flatMap((card) => card.agents)
        .filter((agent) => agent.background && isLive(agent.status) && agent.task?.controls.stop !== false)
        .flatMap((agent) => agent.task?.id ?? agent.sessionID ?? []),
    ),
  ])
  const stopAllBackground = async () => {
    if (board.truncated) {
      showToast({
        variant: "error",
        title: "The task list is incomplete",
        description: "Stop the visible tasks individually, or open a child session to manage its workers.",
      })
      return
    }
    const agents = state.cards
      .flatMap((card) => card.agents)
      .filter((agent) => agent.background && isLive(agent.status) && agent.task?.controls.stop !== false)
    const stopped = await Promise.allSettled(stoppableAgents(agents).map(stopAgent))
    if (stopped.some((result) => result.status === "rejected"))
      showToast({
        variant: "error",
        title: "Could not stop every subagent",
        description: "Open its details to retry. Partial work has been kept.",
      })
  }

  const desktopAgent = (agent: TaskAgent) => agent.task && /^(workspace|swarm):/.test(agent.task.id)
  const canOpenAgent = (agent: TaskAgent) =>
    desktopAgent(agent) ? Boolean(input.desktop && input.openDesktop) : Boolean(agent.sessionID)
  const openAgent = (agent: TaskAgent) => {
    if (desktopAgent(agent)) {
      if (input.desktop && agent.task) input.openDesktop?.(agent.task)
      return
    }
    if (!agent.sessionID) return
    input.open(agent.sessionID)
  }

  const inspect = async (agent: TaskAgent) => {
    const sessionID = rootID()
    const taskID = agent.task?.id ?? agent.sessionID
    if (!sessionID || !taskID) throw new Error("This task is not available yet.")
    if (input.desktop && board.desktop.some((task) => task.id === taskID))
      return input.desktop.api.inspect({ parentSessionID: sessionID, sourcePath: input.desktop.sourcePath(), taskID })
    const result = await input.client().experimental.task.inspect({ sessionID, taskID }, { throwOnError: true })
    if (!result.data) throw new Error("The task details are unavailable.")
    return result.data
  }
  const message = async (agent: TaskAgent, text: string) => {
    const sessionID = rootID()
    const taskID = agent.task?.id ?? agent.sessionID
    if (!sessionID || !taskID) throw new Error("This task is not available yet.")
    if (input.desktop && board.desktop.some((task) => task.id === taskID)) {
      const result = await input.desktop.api.message({
        parentSessionID: sessionID,
        sourcePath: input.desktop.sourcePath(),
        taskID,
        text,
      })
      await refreshBoard()
      return result
    }
    const result = await input
      .client()
      .experimental.task.message({ sessionID, taskID, text, delivery: "steer" }, { throwOnError: true })
    if (!result.data) throw new Error("The message was not accepted. Your draft has been kept.")
    await refreshBoard()
    return result.data
  }
  async function stopAgent(agent: TaskAgent) {
    const sessionID = rootID()
    if (!sessionID) return
    if (!agent.task) {
      if (agent.sessionID) await stopSessions([agent.sessionID])
      return
    }
    if (input.desktop && board.desktop.some((task) => task.id === agent.task?.id)) {
      await input.desktop.api.stop({
        parentSessionID: sessionID,
        sourcePath: input.desktop.sourcePath(),
        taskID: agent.task.id,
      })
      await refreshBoard()
      return
    }
    await input
      .client()
      .experimental.task.stop(
        { sessionID, taskIDs: [agent.task.id], reason: "Stopped by the user" },
        { throwOnError: true },
      )
    await refreshBoard()
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
    waitingCount,
    now,
    locate: (partID) => index().get(partID),
    stop,
    liveBackground,
    stopAllBackground,
    openAgent,
    canOpenAgent,
    clearFinished,
    undismiss,
    hold,
    inspect,
    message,
    stopAgent,
    ask: (agent) => {
      const root = rootID()
      if (root) input.ask?.(agent, root)
    },
    refreshing: () => board.refreshing,
    error: () => board.error,
    draft: (agent) => drafts[agent.task?.id ?? agent.sessionID ?? agent.key] ?? "",
    setDraft: (agent, text) => setDrafts(agent.task?.id ?? agent.sessionID ?? agent.key, text),
  }
}
