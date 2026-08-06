import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { AmbientSky } from "./onboarding"
import { padRect, placeCard, rectsDiffer, type SpotPlacement, type SpotRect } from "./spotlight-geometry"
import "./onboarding.css"

// The interactive first-run tour: instead of narrating over the app from a
// static card, each step spotlights the real control it teaches — the app dims
// around a cut-out that tracks the live element, and the card docks beside it.
// Steps prepare their own surface (navigate, open panels/dialogs), so the tour
// walks the whole product screen by screen.

export type SpotlightStep = {
  id: string
  /** Eyebrow label grouping steps by surface ("Home", "Composer", "Sidebar", …). */
  section: string
  title: string
  body: string
  tip?: string
  /** CSS selector or resolver for the element this step teaches. Centered card when absent. */
  target?: string | (() => Element | null | undefined)
  placement?: SpotPlacement | "auto"
  /**
   * Steps sharing a group describe one surface (e.g. the workspace shell). When
   * the group's sentinel step can't find its element, the surface doesn't exist
   * in this install (no repository yet, web build, …) and every later step of
   * the group skips instantly instead of each waiting out its own deadline.
   */
  group?: string
  /** Marks the step whose missing target declares the whole group unavailable. */
  sentinel?: boolean
  /** Put the app in the right state before highlighting: navigate, open panels. Must be idempotent. */
  prepare?: () => void
  /** Runs once per activation when the target resolves (e.g. select the tab being highlighted). */
  onFound?: (element: HTMLElement) => void
}

const HOLE_PAD = 6
// Sentinel steps cover route changes and lazy-loaded surfaces; the rest of a
// living surface resolves fast, so missing one-off controls skip quickly.
const SENTINEL_DEADLINE = 3500
const STEP_DEADLINE = 1200

function resolveTarget(step: SpotlightStep): HTMLElement | undefined {
  if (!step.target) return undefined
  const found = typeof step.target === "string" ? document.querySelector(step.target) : step.target()
  if (!(found instanceof HTMLElement)) return undefined
  const rect = found.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return undefined
  return found
}

export function SpotlightTour(props: {
  open: boolean
  steps: SpotlightStep[]
  step: number
  onStep: (step: number) => void
  onFinish: () => void
  onSkip: () => void
}) {
  const [rect, setRect] = createSignal<SpotRect>()
  const [viewport, setViewport] = createSignal({ width: 1280, height: 800 })
  const [cardSize, setCardSize] = createSignal({ width: 380, height: 240 })
  let cardEl: HTMLDivElement | undefined

  const active = createMemo(() => (props.open ? props.steps[Math.min(props.step, props.steps.length - 1)] : undefined))
  const last = createMemo(() => props.step >= props.steps.length - 1)

  // Non-reactive per-run state: travel direction, dead surface groups, and the
  // current step's seek bookkeeping. None of it should trigger renders.
  const run = {
    direction: 1,
    dead: new Set<string>(),
    activatedAt: 0,
    found: false,
    scrolled: false,
  }

  const go = (next: number) => {
    if (next >= props.steps.length) {
      props.onFinish()
      return
    }
    run.direction = next < props.step ? -1 : 1
    props.onStep(Math.max(0, next))
  }

  const skipUnavailable = () => {
    // Jump past every consecutive step of dead groups in one hop, so a whole
    // unavailable surface (no repository yet, web build) skips silently instead
    // of flashing each of its cards for a frame.
    let next = props.step + run.direction
    while (next >= 0 && next < props.steps.length) {
      const candidate = props.steps[next]
      if (!candidate.group || !run.dead.has(candidate.group)) break
      next += run.direction
    }
    // Skipping backward off the start means everything before is unavailable;
    // resume forward from here instead of finishing a tour the user rewound.
    if (next < 0) {
      run.direction = 1
      go(props.step + 1)
      return
    }
    go(next)
  }

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) run.dead.clear()
      },
    ),
  )

  createEffect(
    on([() => props.open, () => props.step], () => {
      const step = active()
      if (!step) return
      run.activatedAt = performance.now()
      run.found = false
      run.scrolled = false
      if (step.group && run.dead.has(step.group)) {
        requestAnimationFrame(skipUnavailable)
        return
      }
      step.prepare?.()
    }),
  )

  // One rAF loop does all live measurement: viewport, the target's rect (which
  // follows layout shifts, scrolling, and element replacement without observer
  // bookkeeping), the card's own size, and the seek deadline for missing
  // targets. Reading a couple of rects per frame is well under budget.
  createEffect(() => {
    if (!props.open) return
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const step = active()
      if (!step) return

      const width = window.innerWidth
      const height = window.innerHeight
      if (viewport().width !== width || viewport().height !== height) setViewport({ width, height })

      if (cardEl) {
        const measured = { width: cardEl.offsetWidth, height: cardEl.offsetHeight }
        if (
          measured.width > 0 &&
          (Math.abs(measured.width - cardSize().width) > 1 || Math.abs(measured.height - cardSize().height) > 1)
        ) {
          setCardSize(measured)
        }
      }

      if (!step.target) {
        if (rect()) setRect(undefined)
        return
      }

      const element = resolveTarget(step)
      if (!element) {
        if (run.found) return
        const deadline = step.sentinel ? SENTINEL_DEADLINE : STEP_DEADLINE
        if (performance.now() - run.activatedAt < deadline) return
        if (step.sentinel && step.group) run.dead.add(step.group)
        skipUnavailable()
        return
      }

      if (!run.found) {
        run.found = true
        step.onFound?.(element)
      }
      if (!run.scrolled) {
        run.scrolled = true
        element.scrollIntoView({ block: "nearest", inline: "nearest" })
      }
      const measured = element.getBoundingClientRect()
      const next = { top: measured.top, left: measured.left, width: measured.width, height: measured.height }
      if (rectsDiffer(rect(), next)) setRect(next)
    }
    raf = requestAnimationFrame(frame)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  createEffect(() => {
    if (!props.open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The dialog stack also listens for Escape on window; the tour owns the
        // key while it is open so skipping doesn't also tear down the settings
        // dialog mid-highlight.
        event.preventDefault()
        event.stopImmediatePropagation()
        props.onSkip()
        return
      }
      if (event.key === "ArrowRight" || event.key === "Enter") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (last()) props.onFinish()
        else go(props.step + 1)
        return
      }
      if (event.key === "ArrowLeft" && props.step > 0) {
        event.preventDefault()
        event.stopImmediatePropagation()
        go(props.step - 1)
      }
    }
    window.addEventListener("keydown", handler, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", handler, { capture: true }))
  })

  const hole = createMemo(() => {
    const current = rect()
    if (!current) return undefined
    return padRect(current, HOLE_PAD)
  })

  const cardPosition = createMemo(() =>
    placeCard({
      viewport: viewport(),
      target: hole(),
      card: cardSize(),
      placement: active()?.placement,
    }),
  )

  return (
    <Show when={props.open && active()}>
      {(step) => (
        // Portal to body: the layout shell creates its own stacking context, so
        // an in-tree overlay could never paint above the body-level dialog
        // portals (z 300) no matter its z-index. The tour must cover dialogs —
        // it spotlights settings tabs inside one.
        <Portal>
          <div
            class="vspot"
            role="dialog"
            aria-modal="true"
            aria-label="Vector guided tour"
            data-centered={hole() ? "false" : "true"}
          >
            <Show when={!hole()}>
              <AmbientSky />
            </Show>
            <div
              class="vspot-hole"
              data-centered={hole() ? "false" : "true"}
              style={
                hole()
                  ? {
                      top: `${hole()!.top}px`,
                      left: `${hole()!.left}px`,
                      width: `${hole()!.width}px`,
                      height: `${hole()!.height}px`,
                    }
                  : {
                      top: `${viewport().height / 2}px`,
                      left: `${viewport().width / 2}px`,
                      width: "0px",
                      height: "0px",
                    }
              }
            />
            <button type="button" class="vspot-skip" onClick={props.onSkip}>
              Skip tour
            </button>
            <div
              ref={cardEl}
              class="vspot-card"
              data-placement={cardPosition().placement}
              style={{ top: `${cardPosition().top}px`, left: `${cardPosition().left}px` }}
            >
              <div class="vtour-eyebrow">
                <span class="vtour-eyebrow-dot" />
                {step().section}
              </div>
              <h2 class="vspot-title">{step().title}</h2>
              <p class="vspot-body">{step().body}</p>
              <Show when={step().tip}>
                <p class="vspot-tip">
                  <span class="vguide-tip-label">Tip</span>
                  {step().tip}
                </p>
              </Show>
              <div class="vspot-footer">
                <div class="vspot-progress" aria-hidden="true">
                  <span class="vspot-count">
                    {String(props.step + 1).padStart(2, "0")} / {String(props.steps.length).padStart(2, "0")}
                  </span>
                  <span class="vspot-bar">
                    <span
                      class="vspot-bar-fill"
                      style={{ width: `${((props.step + 1) / props.steps.length) * 100}%` }}
                    />
                  </span>
                </div>
                <div class="vtour-actions">
                  <Show when={props.step > 0}>
                    <button type="button" class="vtour-back" onClick={() => go(props.step - 1)}>
                      Back
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="vtour-next"
                    onClick={() => (last() ? props.onFinish() : go(props.step + 1))}
                  >
                    {last() ? "Start building" : "Next"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  )
}
