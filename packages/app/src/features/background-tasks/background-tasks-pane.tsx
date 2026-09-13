import "./background-tasks.css"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { SubagentAvatar, subagentIdentity } from "@opencode-ai/session-ui/subagent-identity"
import { backgroundTasksPane } from "./background-tasks-state"
import { ChevronIcon, CloseIcon, CollapseIcon, DockIcon, ExpandIcon, PopOutIcon, StopIcon, TrashIcon } from "./icons"
import {
  countAgents,
  elapsedMs,
  formatAgentCount,
  formatDuration,
  formatTokens,
  isLive,
  KIND_LABEL,
  statusWord,
  type TaskAgent,
  type TaskCard,
  type TaskPhase,
  type TaskStatus,
} from "./subagent-model"
import { TaskSquares } from "./task-squares"
import { useBackgroundTasks, type BackgroundTasks } from "./use-background-tasks"

const MAX_ROWS = 12

const domKey = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_")
const cardDomID = (cardKey: string) => `vector-bg-tasks-card-${domKey(cardKey)}`
const phaseDomID = (cardKey: string, phaseKey: string) => `${cardDomID(cardKey)}-p-${domKey(phaseKey)}`

function focusLauncher() {
  document.querySelector<HTMLElement>("[data-vector-bg-tasks-launch]")?.focus()
}

/**
 * The Background tasks pane. Docked, it is the last column of the session
 * split row (session.tsx reserves its width). Popped out, or as the sheet
 * below 768px, it is portalled to the body and floats over the window.
 */
export function BackgroundTasksPane() {
  const tasks = useBackgroundTasks()
  return (
    <Show when={tasks && tasks.rootID() && backgroundTasksPane.opened()}>
      <Pane tasks={tasks!} />
    </Show>
  )
}

function Pane(props: { tasks: BackgroundTasks }) {
  const tasks = props.tasks
  const pane = backgroundTasksPane
  const [finishedOpen, setFinishedOpen] = createSignal(false)
  const [scrolled, setScrolled] = createSignal(false)
  const [moreBelow, setMoreBelow] = createSignal(false)
  const [announcement, setAnnouncement] = createSignal("")
  const [cardOpen, setCardOpen] = createStore<Record<string, boolean>>({})
  const [phaseOpen, setPhaseOpen] = createStore<Record<string, boolean>>({})
  const [list, setList] = createSignal<HTMLUListElement>()
  let aside: HTMLElement | undefined

  const total = () => tasks.live().length + tasks.finished().length

  const measure = () => {
    const element = list()
    if (!element) return
    setScrolled(element.scrollTop > 0)
    setMoreBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 1)
  }
  // Opening a phase, a table filling in and the pane resizing all move the
  // edges without a scroll, so the list and every box in it are observed.
  createEffect(
    on([list, () => tasks.live().length, () => tasks.finished().length, finishedOpen], ([element]) => {
      queueMicrotask(measure)
      if (!element || typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      // The list items are display: contents, so their children are the boxes.
      for (const child of element.querySelectorAll(":scope > li > *")) observer.observe(child)
      onCleanup(() => observer.disconnect())
    }),
  )

  // Cards already listed when the pane opens are simply there; one that
  // arrives later eases in. For maps a new card before this effect records
  // its key, so the check in card() sees it as new exactly once.
  const seen = new Set(tasks.cards().map((card) => card.key))
  createEffect(() => {
    for (const card of tasks.cards()) seen.add(card.key)
  })

  // The session <main> is its own stacking context (z-index 1, contain:
  // strict), so a fixed pane inside it stays under the sidebar and is clipped
  // to the session column whatever its z-index. Popped out, and as the sheet
  // below 768px (the breakpoint in background-tasks.css), the same element
  // moves to the body, where z-index 40 clears the sidebar and stays under
  // dialogs and toasts. Docked, it stays in the split row.
  const wide = createMediaQuery("(min-width: 768px)")
  const detached = createMemo(() => pane.floating() || !wide())
  const [portaled, setPortaled] = createSignal(detached())
  // The move detaches the pane for a moment, which drops focus and resets the
  // list's scroll: hand focus back if nothing else took it, and measure again.
  createEffect(
    on(
      detached,
      (next) => {
        const active = document.activeElement
        const focused = active instanceof HTMLElement && aside?.contains(active) ? active : undefined
        setPortaled(next)
        requestAnimationFrame(() => {
          measure()
          const current = document.activeElement
          if (focused?.isConnected && (!current || current === document.body)) focused.focus({ preventScroll: true })
        })
      },
      { defer: true },
    ),
  )

  const close = () => {
    pane.close()
    focusLauncher()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    if (pane.floating()) {
      pane.setFloating(false)
      focusLauncher()
      return
    }
    close()
  }

  // An inline chip asks for its card: open it, expand the phase, bring it into view.
  createEffect(
    on(pane.reveal, (target) => {
      if (!target) return
      pane.clearReveal()
      const card = tasks.cards().find((item) => item.key === target.cardKey)
      if (!card) return
      if (!card.live) {
        // The Finished list leaves out cards the trash hid; bring this one back.
        tasks.undismiss(card.key)
        setFinishedOpen(true)
        setCardOpen(card.key, true)
      }
      if (target.phaseKey) setPhaseOpen(`${card.key}\n${target.phaseKey}`, true)
      requestAnimationFrame(() => {
        const element = document.getElementById(cardDomID(card.key))
        element?.scrollIntoView({ block: "nearest" })
        const toggle = target.phaseKey ? document.getElementById(phaseDomID(card.key, target.phaseKey)) : undefined
        ;(toggle ?? element)?.focus({ preventScroll: true })
      })
    }),
  )

  // Announce transitions only, never the ticking clock. A card that first
  // shows up already settled (children fetched, history loaded, another
  // session opened) is not a transition, so only keys seen before count.
  let previous: { root: string | undefined; statuses: Map<string, TaskStatus> } | undefined
  createEffect(() => {
    const root = tasks.rootID()
    const cards = tasks.cards()
    const statuses = new Map(cards.map((card) => [card.key, card.status] as const))
    if (previous && previous.root === root) {
      for (const card of cards) {
        const before = previous.statuses.get(card.key)
        if (before === undefined || before === card.status) continue
        if (card.status === "done") setAnnouncement(`${card.title}: done`)
        if (card.status === "failed") setAnnouncement(`${card.title}: failed`)
        if (card.status === "stopped") setAnnouncement(`${card.title}: stopped`)
        if (card.status === "waiting") setAnnouncement(`${card.title}: needs you`)
      }
    }
    previous = { root, statuses }
  })

  const toggleFinished = () => {
    const next = !finishedOpen()
    setFinishedOpen(next)
    if (!next) return
    requestAnimationFrame(() =>
      document.getElementById("vector-bg-tasks-finished")?.scrollIntoView({ block: "nearest" }),
    )
  }

  const phaseState = (card: TaskCard, phase: TaskPhase) => {
    const key = `${card.key}\n${phase.key}`
    return {
      open: () => phaseOpen[key] ?? (phase.status === "running" || phase.status === "waiting"),
      toggle: () => setPhaseOpen(key, !(phaseOpen[key] ?? (phase.status === "running" || phase.status === "waiting"))),
    }
  }

  const card = (item: TaskCard, finished: boolean) => (
    <li>
      <CardView
        card={item}
        finished={finished}
        fresh={!seen.has(item.key)}
        tasks={tasks}
        open={!!cardOpen[item.key]}
        onToggle={() => setCardOpen(item.key, !cardOpen[item.key])}
        phase={phaseState}
      />
    </li>
  )

  // Built once and moved between the split row and the portal, so open
  // cards, phases and the scroll measuring survive a pop-out or a resize.
  const view = (
    <aside
      ref={(element) => {
        aside = element
      }}
      id="vector-bg-tasks"
      class="vector-bg-tasks"
      data-docked={pane.floating() ? undefined : ""}
      data-floating={pane.floating() ? "" : undefined}
      data-expanded={pane.expanded() ? "" : undefined}
      data-scrolled={scrolled() ? "" : undefined}
      data-more-below={moreBelow() ? "" : undefined}
      aria-labelledby="vector-bg-tasks-title"
      onKeyDown={onKeyDown}
    >
      <header class="vector-bg-tasks-header">
        <h2 id="vector-bg-tasks-title" class="vector-bg-tasks-title">
          Background tasks
        </h2>
        <button
          type="button"
          class="vector-bg-tasks-icon-btn"
          aria-pressed={pane.floating()}
          aria-label={pane.floating() ? "Dock background tasks" : "Pop out background tasks"}
          title={pane.floating() ? "Dock" : "Pop out"}
          onClick={() => pane.setFloating(!pane.floating())}
        >
          <Show when={pane.floating()} fallback={<PopOutIcon />}>
            <DockIcon />
          </Show>
        </button>
        <button
          type="button"
          class="vector-bg-tasks-icon-btn"
          aria-pressed={pane.expanded()}
          aria-label={pane.expanded() ? "Collapse panel" : "Expand panel"}
          title={pane.expanded() ? "Collapse" : "Expand"}
          onClick={() => pane.setExpanded(!pane.expanded())}
        >
          <Show when={pane.expanded()} fallback={<ExpandIcon />}>
            <CollapseIcon />
          </Show>
        </button>
        <button
          type="button"
          class="vector-bg-tasks-icon-btn"
          aria-label="Close background tasks"
          title="Close"
          onClick={close}
        >
          <CloseIcon />
        </button>
      </header>

      <Show
        when={total() > 0}
        fallback={
          <div class="vector-bg-tasks-empty">
            <p class="vector-bg-tasks-empty-title">No background tasks</p>
            <p class="vector-bg-tasks-empty-body">Subagents and subagent specialists show up here while they work.</p>
          </div>
        }
      >
        <ul
          ref={(element) => setList(element)}
          class="vector-bg-tasks-list"
          aria-label="Running tasks"
          onScroll={measure}
        >
          <For each={tasks.live()}>{(item) => card(item, false)}</For>
          <Show when={tasks.live().length === 0}>
            <li>
              <p class="vector-bg-tasks-idle">Nothing running right now</p>
            </li>
          </Show>
          <Show when={finishedOpen() && tasks.finished().length > 0}>
            <li>
              <p class="vector-bg-tasks-finished-label">Finished</p>
              <ul id="vector-bg-tasks-finished" class="vector-bg-tasks-finished" aria-label="Finished tasks">
                <For each={tasks.finished()}>{(item) => card(item, true)}</For>
              </ul>
            </li>
          </Show>
        </ul>
        <footer class="vector-bg-tasks-footer">
          <button
            type="button"
            class="vector-bg-tasks-finished-toggle"
            aria-expanded={finishedOpen()}
            aria-controls="vector-bg-tasks-finished"
            disabled={tasks.finished().length === 0}
            onClick={toggleFinished}
          >
            Finished {tasks.finished().length}
            <ChevronIcon />
          </button>
          <button
            type="button"
            class="vector-bg-tasks-icon-btn"
            aria-label="Clear finished tasks"
            title="Clear finished tasks"
            disabled={tasks.finished().length === 0}
            onClick={() => {
              tasks.clearFinished()
              setFinishedOpen(false)
            }}
          >
            <TrashIcon />
          </button>
        </footer>
      </Show>

      <div class="vector-bg-tasks-sr" aria-live="polite">
        {announcement()}
      </div>
    </aside>
  )

  return (
    <Show when={portaled()} fallback={view}>
      <Portal>{view}</Portal>
    </Show>
  )
}

function CardView(props: {
  card: TaskCard
  finished: boolean
  /** Mounted after the pane's first render: plays the entry animation once. */
  fresh: boolean
  tasks: BackgroundTasks
  open: boolean
  onToggle: () => void
  phase: (card: TaskCard, phase: TaskPhase) => { open: () => boolean; toggle: () => void }
}) {
  const id = () => cardDomID(props.card.key)
  const [stopping, setStopping] = createSignal(false)
  // Read once: only a card's first mount can be new.
  const [entering, setEntering] = createSignal(props.fresh)
  const expanded = () => !props.finished || props.open
  const canStop = () => props.card.agents.some((agent) => isLive(agent.status) && !!agent.sessionID)

  const stop = async () => {
    if (stopping()) return
    setStopping(true)
    await props.tasks.stop(props.card).finally(() => setStopping(false))
  }

  return (
    <article
      class="vector-bg-tasks-card"
      id={id()}
      tabIndex={-1}
      data-status={props.card.status}
      data-finished={props.finished ? "" : undefined}
      data-new={entering() ? "" : undefined}
      aria-labelledby={`${id()}-title`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false)
      }}
    >
      <div class="vector-bg-tasks-card-head">
        <Show
          when={props.finished}
          fallback={
            <h3 id={`${id()}-title`} class="vector-bg-tasks-card-title" title={props.card.title}>
              {props.card.title}
            </h3>
          }
        >
          <h3 id={`${id()}-title`} class="vector-bg-tasks-card-heading">
            <button
              type="button"
              class="vector-bg-tasks-card-toggle"
              aria-expanded={props.open}
              title={props.card.title}
              onClick={props.onToggle}
            >
              <span>{props.card.title}</span>
              <ChevronIcon />
            </button>
          </h3>
        </Show>
        <Show
          when={props.card.live}
          fallback={
            <span class="vector-bg-tasks-card-status" data-status={props.card.status}>
              {statusWord(props.card.status)}
            </span>
          }
        >
          <button
            type="button"
            class="vector-bg-tasks-stop"
            aria-label={`Stop ${props.card.title}`}
            title="Stop"
            aria-busy={stopping()}
            disabled={!canStop()}
            onClick={stop}
          >
            <StopIcon />
          </button>
        </Show>
      </div>
      <p class="vector-bg-tasks-meta">
        <span>{props.card.kindLabel}</span>
        <Show when={props.card.status === "waiting"}>
          <span class="vector-bg-tasks-attention">Needs you</span>
        </Show>
        <span class="vector-bg-tasks-dim">
          <time>{formatDuration(elapsedMs(props.card, props.tasks.now()))}</time>
        </span>
      </p>
      <p class="vector-bg-tasks-meta">
        <span>{formatAgentCount(countAgents(props.card.agents))}</span>
        <Show when={props.card.tokens !== undefined}>
          <span class="vector-bg-tasks-dim">{formatTokens(props.card.tokens)} tokens</span>
        </Show>
      </p>
      <Show
        when={expanded()}
        fallback={
          <TaskSquares
            agents={props.card.agents}
            class="vector-bg-tasks-squares"
            squareClass="vector-bg-tasks-square"
            labelled
          />
        }
      >
        <Show when={props.card.description}>
          <p class="vector-bg-tasks-desc">{props.card.description}</p>
        </Show>
        <h4 id={`${id()}-phases`} class="vector-bg-tasks-phases-label">
          Phases
        </h4>
        <ol class="vector-bg-tasks-phases" aria-labelledby={`${id()}-phases`}>
          <For each={props.card.phases}>
            {(phase) => {
              const state = props.phase(props.card, phase)
              return (
                <PhaseView
                  cardKey={props.card.key}
                  phase={phase}
                  tasks={props.tasks}
                  open={state.open()}
                  onToggle={state.toggle}
                />
              )
            }}
          </For>
        </ol>
      </Show>
    </article>
  )
}

function PhaseView(props: {
  cardKey: string
  phase: TaskPhase
  tasks: BackgroundTasks
  open: boolean
  onToggle: () => void
}) {
  const toggleID = () => phaseDomID(props.cardKey, props.phase.key)
  const bodyID = () => `${toggleID()}-body`
  return (
    <li class="vector-bg-tasks-phase" data-state={props.phase.status}>
      <button
        type="button"
        id={toggleID()}
        class="vector-bg-tasks-phase-toggle"
        aria-expanded={props.open}
        aria-controls={bodyID()}
        onClick={props.onToggle}
      >
        <span class="vector-bg-tasks-phase-name">{props.phase.name}</span>
        <span class="vector-bg-tasks-phase-count">
          <span aria-hidden="true">
            {props.phase.done}/{props.phase.total}
          </span>
          <span class="vector-bg-tasks-sr">
            {props.phase.done} of {props.phase.total} done
          </span>
        </span>
        <ChevronIcon class="vector-bg-tasks-phase-chevron" />
        <TaskSquares
          agents={props.phase.agents}
          class="vector-bg-tasks-squares"
          squareClass="vector-bg-tasks-square"
          labelled
        />
      </button>
      <div class="vector-bg-tasks-phase-body" id={bodyID()} hidden={!props.open}>
        <Show when={props.open}>
          <PhaseTable phase={props.phase} tasks={props.tasks} />
        </Show>
      </div>
    </li>
  )
}

function agentTooltip(agent: TaskAgent) {
  const kind = agent.kind === "specialist" ? `${agent.label} · ${KIND_LABEL.specialist}` : KIND_LABEL.subagent
  const detail = agent.status === "failed" && agent.error ? ` · ${agent.error}` : ""
  return `${agent.title} (${kind})${detail}`
}

function modelTooltip(agent: TaskAgent) {
  if (!agent.model) return undefined
  return agent.model.variant ? `${agent.model.name} · ${agent.model.variant}` : agent.model.name
}

function PhaseTable(props: { phase: TaskPhase; tasks: BackgroundTasks }) {
  props.tasks.hold(() => props.phase.agents)
  const [all, setAll] = createSignal(false)
  const rows = () => (all() ? props.phase.agents : props.phase.agents.slice(0, MAX_ROWS))
  const hidden = () => Math.max(0, props.phase.agents.length - MAX_ROWS)
  return (
    <>
      <table class="vector-bg-tasks-table">
        <caption class="vector-bg-tasks-sr">Agents in {props.phase.name}</caption>
        <colgroup>
          <col />
          <col class="vector-bg-tasks-col-model" />
          <col class="vector-bg-tasks-col-tokens" />
          <col class="vector-bg-tasks-col-time" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Model</th>
            <th scope="col">Tokens</th>
            <th scope="col">Time</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(agent) => (
              <tr class="vector-bg-tasks-row" data-status={agent.status}>
                <td>
                  <button
                    type="button"
                    class="vector-bg-tasks-agent"
                    title={agentTooltip(agent)}
                    aria-label={`Open ${agent.title} (${KIND_LABEL[agent.kind]}, ${statusWord(agent.status)})`}
                    disabled={!agent.sessionID}
                    onClick={() => props.tasks.openAgent(agent)}
                  >
                    <Show when={agent.kind === "specialist" && subagentIdentity(agent.agent)}>
                      <SubagentAvatar id={agent.agent} size={14} />
                    </Show>
                    <span>{agent.title}</span>
                  </button>
                </td>
                <td title={modelTooltip(agent)}>{agent.model?.short ?? "—"}</td>
                <td>{formatTokens(agent.tokens)}</td>
                <td>
                  <time>{formatDuration(elapsedMs(agent, props.tasks.now()))}</time>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={!all() && hidden() > 0}>
        <button type="button" class="vector-bg-tasks-more" onClick={() => setAll(true)}>
          Show {hidden()} more
        </button>
      </Show>
    </>
  )
}
