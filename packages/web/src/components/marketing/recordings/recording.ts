// The timeline runner behind the landing page's recordings (CliRecording, ModelsRecording, ReviewRecording).
//
// A recording is live DOM, not video: the markup is server-rendered in its FINAL frame (so it reads correctly with
// no script, and under reduced motion), and this runner resets it to the first frame and plays a list of steps.
//
// - Every piece of state is an attribute: `data-on` shows a `data-hidden` element, `data-off` hides a visible one,
//   `data-caret` shows a typing caret. Reset clears them all, so a loop can never leak state into the next one.
// - Only transforms and opacity animate (CSS transitions keyed on those attributes, or the cursor's transform),
//   beyond text content. Everything a step reveals is already laid out, so nothing shifts while it plays.
// - Playback starts once a recording is at least 35% visible and pauses when it leaves the viewport or the tab is
//   hidden. One requestAnimationFrame loop per playing recording, none while paused.
// - After the last step it holds for 3s, fades, resets and plays again.
// - Under prefers-reduced-motion the final frame is shown and nothing moves.
// - The entrance (fade in, scale 0.96 to 1 over 800ms) is built in: `data-entrance` on the figure. A page that
//   already reveals its sections should not wrap a recording in a second fade.

export interface Context {
  root: HTMLElement
  /** The window: the coordinate space the cursor moves in. */
  stage: HTMLElement
  cursor: HTMLElement | null
  /** The first element named `name` ([data-rec="name"]). */
  el<T extends HTMLElement = HTMLElement>(name: string): T
  /** Every element named `name`. */
  all(name: string): HTMLElement[]
  /** Where the cursor is, in stage pixels. */
  pointer: { x: number; y: number }
  /** A stage-relative point on an element: fx and fy are fractions of its box. */
  point(target: HTMLElement, fx?: number, fy?: number): { x: number; y: number }
}

export interface Step {
  /** Runs once when the step starts. */
  begin?(ctx: Context): void
  /** Runs each frame with the milliseconds since `begin`; returns true when done. Without it the step lasts `ms`. */
  frame?(ctx: Context, elapsed: number): boolean
  ms?: number
  /** The step's end state, applied at once for the static final frame. Defaults to `begin`. */
  end?(ctx: Context): void
  /** Pointer choreography with no end state (cursor moves and clicks): skipped in the final frame. */
  motion?: boolean
}

const HOLD_MS = 3000
const FADE_MS = 480
const STATE_ATTRS = ["data-on", "data-off", "data-caret", "data-active"] as const

// ---------------------------------------------------------------------------------------------------------------
// Steps

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const jitter = (min: number, max: number) => min + Math.random() * (max - min)

export const wait = (ms: number): Step => ({ ms })

/** Shows every element named `name` (they carry `data-hidden`), then waits `ms`. */
export const show = (name: string, ms = 0): Step => ({
  ms,
  begin: (ctx) => ctx.all(name).forEach((node) => node.setAttribute("data-on", "")),
})

/** Hides every element named `name` (a visible element gets `data-off`; a shown one loses `data-on`). */
export const hide = (name: string, ms = 0): Step => ({
  ms,
  begin: (ctx) =>
    ctx.all(name).forEach((node) => {
      if (node.hasAttribute("data-hidden")) node.removeAttribute("data-on")
      else node.setAttribute("data-off", "")
    }),
})

/** Sets or clears one state attribute on every element named `name`. */
export const flag = (name: string, attr: (typeof STATE_ATTRS)[number], on: boolean, ms = 0): Step => ({
  ms,
  begin: (ctx) => ctx.all(name).forEach((node) => node.toggleAttribute(attr, on)),
})

/** Runs a function, then waits `ms`. `end` is the state for the final frame, when it differs. */
export const call = (begin: (ctx: Context) => void, ms = 0, end?: (ctx: Context) => void): Step => ({
  ms,
  begin,
  end: end ?? begin,
})

function typedParts(node: HTMLElement) {
  const typed = node.querySelector<HTMLElement>("[data-typed]")
  const rest = node.querySelector<HTMLElement>("[data-rest]")
  return { typed, rest, text: node.dataset.text ?? "" }
}

function setTyped(node: HTMLElement, count: number) {
  const { typed, rest, text } = typedParts(node)
  if (typed) typed.textContent = text.slice(0, count)
  if (rest) rest.textContent = text.slice(count)
}

/**
 * Types an element made by Typed.astro, one character every 35–55ms. The untyped rest of the text stays in the
 * layout, invisible, so wrapping never changes as it types. The caret stays until `caretOff`.
 */
export const type = (name: string, options: { min?: number; max?: number; lead?: number } = {}): Step => {
  const min = options.min ?? 35
  const max = options.max ?? 55
  let due: number[] = []
  let shown = -1
  return {
    begin(ctx) {
      const node = ctx.el(name)
      const text = node.dataset.text ?? ""
      let at = options.lead ?? 0
      due = Array.from(text, () => (at += jitter(min, max)))
      shown = -1
      node.setAttribute("data-caret", "")
      node.setAttribute("data-typing", "")
      setTyped(node, 0)
    },
    frame(ctx, elapsed) {
      const node = ctx.el(name)
      let count = shown < 0 ? 0 : shown
      while (count < due.length && due[count] <= elapsed) count++
      if (count !== shown) {
        setTyped(node, count)
        shown = count
      }
      const done = count >= due.length
      if (done) node.removeAttribute("data-typing")
      return done
    },
    end(ctx) {
      const node = ctx.el(name)
      setTyped(node, (node.dataset.text ?? "").length)
    },
  }
}

export const caretOff = (name: string, ms = 0): Step => flag(name, "data-caret", false, ms)

/** Empties a typed element again (the text is sent), keeping its space reserved. */
export const clearTyped = (name: string, ms = 0): Step => ({
  ms,
  begin: (ctx) => {
    const node = ctx.el(name)
    node.removeAttribute("data-caret")
    setTyped(node, 0)
  },
})

/** Reveals the words of an element made by Words.astro in small bursts, like streamed tokens. */
export const stream = (name: string, options: { every?: number } = {}): Step => {
  const every = options.every ?? 70
  let due: number[] = []
  let words: HTMLElement[] = []
  let shown = 0
  return {
    begin(ctx) {
      words = Array.from(ctx.el(name).querySelectorAll<HTMLElement>("[data-word]"))
      due = []
      let at = 0
      for (let index = 0; index < words.length; ) {
        const burst = 1 + Math.floor(Math.random() * 3)
        at += jitter(every * 0.7, every * 1.5) * burst * 0.8
        for (let taken = 0; taken < burst && index < words.length; taken++, index++) due.push(at)
      }
      shown = 0
    },
    frame(_ctx, elapsed) {
      while (shown < words.length && due[shown] <= elapsed) words[shown++].setAttribute("data-on", "")
      return shown >= words.length
    },
    end(ctx) {
      ctx.el(name).querySelectorAll("[data-word]").forEach((word) => word.setAttribute("data-on", ""))
    },
  }
}

/** Moves the pointer to a point on `name` (fractions of its box), easing in and out. */
export const move = (name: string, options: { ms?: number; fx?: number; fy?: number } = {}): Step => {
  const ms = options.ms ?? 720
  let from = { x: 0, y: 0 }
  let to = { x: 0, y: 0 }
  return {
    motion: true,
    begin(ctx) {
      from = { ...ctx.pointer }
      to = ctx.point(ctx.el(name), options.fx ?? 0.5, options.fy ?? 0.5)
      ctx.cursor?.setAttribute("data-on", "")
    },
    frame(ctx, elapsed) {
      const t = ease(Math.min(1, elapsed / ms))
      placePointer(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
      return elapsed >= ms
    },
  }
}

/** A click: the pointer presses, a ring spreads, and the target dips. */
export const click = (name?: string, ms = 260): Step => ({
  ms,
  motion: true,
  begin(ctx) {
    const cursor = ctx.cursor
    const arrow = cursor?.querySelector<HTMLElement>("[data-cursor-arrow]")
    const ring = cursor?.querySelector<HTMLElement>("[data-cursor-ring]")
    arrow?.animate([{ transform: "scale(1)" }, { transform: "scale(0.84)" }, { transform: "scale(1)" }], {
      duration: 240,
      easing: "ease-out",
    })
    ring?.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.2)", opacity: 0.55 },
        { transform: "translate(-50%, -50%) scale(1)", opacity: 0 },
      ],
      { duration: 520, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    )
    if (name)
      ctx.el(name).animate([{ transform: "scale(1)" }, { transform: "scale(0.96)" }, { transform: "scale(1)" }], {
        duration: 220,
        easing: "ease-out",
      })
  },
})

/** Hides the pointer. */
export const pointerAway = (ms = 0): Step => ({
  ms,
  motion: true,
  begin: (ctx) => ctx.cursor?.removeAttribute("data-on"),
})

/**
 * Scrolls `scroller` (translated inside its parent, which clips it) so `target` sits `offset` pixels below the top
 * of the viewport, clamped to the content.
 */
export const scroll = (scroller: string, target: string, options: { ms?: number; offset?: number } = {}): Step => {
  const ms = options.ms ?? 900
  let from = 0
  let to = 0
  const measure = (ctx: Context) => {
    const node = ctx.el(scroller)
    const view = node.parentElement ?? node
    const scale = stageScale(ctx)
    const current = Number(node.dataset.scroll ?? 0)
    const top = (ctx.el(target).getBoundingClientRect().top - node.getBoundingClientRect().top) / scale
    const room = Math.max(0, node.offsetHeight - view.clientHeight)
    return { current, next: Math.round(Math.max(0, Math.min(room, top - (options.offset ?? 16)))) }
  }
  const apply = (ctx: Context, y: number) => {
    const node = ctx.el(scroller)
    node.dataset.scroll = String(y)
    node.style.transform = y ? `translate3d(0, ${-y}px, 0)` : ""
  }
  return {
    begin(ctx) {
      const { current, next } = measure(ctx)
      from = current
      to = next
    },
    frame(ctx, elapsed) {
      const t = ease(Math.min(1, elapsed / ms))
      apply(ctx, from + (to - from) * t)
      return elapsed >= ms
    },
    end(ctx) {
      apply(ctx, measure(ctx).next)
    },
  }
}

function stageScale(ctx: Context) {
  const width = ctx.stage.offsetWidth
  return width ? ctx.stage.getBoundingClientRect().width / width : 1
}

function placePointer(ctx: Context, x: number, y: number) {
  ctx.pointer = { x, y }
  if (ctx.cursor) ctx.cursor.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
}

// ---------------------------------------------------------------------------------------------------------------
// The player

interface Player {
  destroy(): void
}

function createContext(root: HTMLElement): Context {
  const stage = root.querySelector<HTMLElement>("[data-rec-stage]") ?? root
  const cache = new Map<string, HTMLElement[]>()
  const all = (name: string) => {
    let found = cache.get(name)
    if (!found) {
      found = Array.from(root.querySelectorAll<HTMLElement>(`[data-rec="${name}"]`))
      if (!found.length) throw new Error(`recording "${root.dataset.recording}": nothing named "${name}"`)
      cache.set(name, found)
    }
    return found
  }
  const ctx: Context = {
    root,
    stage,
    cursor: root.querySelector<HTMLElement>("[data-rec-cursor]"),
    el: <T extends HTMLElement>(name: string) => all(name)[0] as T,
    all,
    pointer: { x: 0, y: 0 },
    point(target, fx = 0.5, fy = 0.5) {
      const scale = stageScale(ctx)
      const box = target.getBoundingClientRect()
      const origin = stage.getBoundingClientRect()
      return {
        x: (box.left - origin.left + box.width * fx) / scale,
        y: (box.top - origin.top + box.height * fy) / scale,
      }
    },
  }
  return ctx
}

/** Returns the recording to its first frame. */
function reset(ctx: Context) {
  const { root } = ctx
  for (const attr of STATE_ATTRS)
    root.querySelectorAll(`[${attr}]`).forEach((node) => {
      // The pointer's own attributes are handled below.
      if (node !== ctx.cursor) node.removeAttribute(attr)
    })
  root.querySelectorAll<HTMLElement>("[data-type]").forEach((node) => {
    node.removeAttribute("data-typing")
    setTyped(node, 0)
  })
  root.querySelectorAll<HTMLElement>("[data-scroll]").forEach((node) => {
    node.dataset.scroll = "0"
    node.style.transform = ""
  })
  if (ctx.cursor) {
    ctx.cursor.removeAttribute("data-on")
    // The pointer waits just inside the lower right of the window.
    placePointer(ctx, ctx.stage.offsetWidth * 0.82, ctx.stage.offsetHeight * 0.92)
  }
}

/** The last frame, all at once. */
function finish(ctx: Context, steps: readonly Step[]) {
  reset(ctx)
  for (const step of steps) {
    if (step.motion) continue
    ;(step.end ?? step.begin)?.(ctx)
  }
  ctx.root.querySelectorAll("[data-caret]").forEach((node) => node.removeAttribute("data-caret"))
}

function mount(root: HTMLElement, steps: readonly Step[]): Player {
  const ctx = createContext(root)
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)")

  let index = 0
  let begun = false
  let elapsed = 0
  let phase: "play" | "hold" | "out" | "in" = "play"
  let phaseTime = 0

  let inView = false
  let raf = 0
  let last = 0

  const restart = () => {
    index = 0
    begun = false
    elapsed = 0
    phase = "play"
    phaseTime = 0
    reset(ctx)
  }

  const advance = (dt: number) => {
    if (phase === "play") {
      let budget = dt
      // Zero-length steps run in the same frame; the guard stops a bad timeline from spinning.
      for (let guard = 0; guard < 64; guard++) {
        const step = steps[index]
        if (!step) {
          phase = "hold"
          phaseTime = 0
          return
        }
        if (!begun) {
          step.begin?.(ctx)
          begun = true
          elapsed = 0
        }
        elapsed += budget
        budget = 0
        const done = step.frame ? step.frame(ctx, elapsed) : elapsed >= (step.ms ?? 0)
        if (!done) return
        if (!step.frame) budget = elapsed - (step.ms ?? 0)
        index++
        begun = false
      }
      return
    }
    phaseTime += dt
    if (phase === "hold" && phaseTime >= HOLD_MS) {
      phase = "out"
      phaseTime = 0
      root.setAttribute("data-fade", "")
    } else if (phase === "out" && phaseTime >= FADE_MS) {
      restart()
      phase = "in"
      phaseTime = 0
      root.removeAttribute("data-fade")
    } else if (phase === "in" && phaseTime >= FADE_MS * 0.6) {
      phase = "play"
      phaseTime = 0
    }
  }

  const loop = (now: number) => {
    // A long gap (a background tab, a slow frame) must not skip half the timeline.
    advance(Math.min(64, Math.max(0, now - last)))
    last = now
    raf = requestAnimationFrame(loop)
  }

  const playing = () => raf !== 0
  const update = () => {
    const want = inView && !document.hidden && !motion.matches
    if (want && !playing()) {
      last = performance.now()
      raf = requestAnimationFrame(loop)
    } else if (!want && playing()) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  const applyMotionPreference = () => {
    if (motion.matches) {
      if (playing()) cancelAnimationFrame(raf)
      raf = 0
      root.removeAttribute("data-fade")
      root.removeAttribute("data-entrance")
      finish(ctx, steps)
      root.setAttribute("data-final", "")
      return
    }
    root.removeAttribute("data-final")
    restart()
    update()
  }

  // Below the fold, the recording waits to make its entrance.
  const box = root.getBoundingClientRect()
  if (!motion.matches && (box.top > window.innerHeight || box.bottom < 0)) root.setAttribute("data-entrance", "wait")

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const viewport = entry.rootBounds?.height ?? window.innerHeight
        const needed = Math.min(entry.boundingClientRect.height, viewport)
        const seen = entry.isIntersecting ? entry.intersectionRect.height : 0
        if (root.getAttribute("data-entrance") === "wait" && seen >= needed * 0.12)
          root.setAttribute("data-entrance", "in")
        if (seen >= needed * 0.35) inView = true
        else if (!entry.isIntersecting) inView = false
      }
      update()
    },
    { threshold: Array.from({ length: 21 }, (_, step) => step / 20) },
  )

  // A resize moves what the final frame measured (the scrolled page), so it is measured again.
  let width = root.offsetWidth
  const resized = new ResizeObserver(() => {
    if (root.offsetWidth === width) return
    width = root.offsetWidth
    if (motion.matches) finish(ctx, steps)
  })

  const onVisibility = () => update()
  document.addEventListener("visibilitychange", onVisibility)
  motion.addEventListener("change", applyMotionPreference)
  applyMotionPreference()
  observer.observe(root)
  resized.observe(root)

  return {
    destroy() {
      cancelAnimationFrame(raf)
      raf = 0
      observer.disconnect()
      resized.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      motion.removeEventListener("change", applyMotionPreference)
    },
  }
}

const players = new Map<HTMLElement, Player>()

/**
 * Mounts every recording of one kind on the page ([data-recording="kind"]). Each gets its own steps, since steps
 * keep per-run state. Safe to call again after an Astro page swap.
 */
export function bootRecordings(kind: string, build: () => Step[]) {
  const start = () => {
    for (const [root, player] of players)
      if (!root.isConnected) {
        player.destroy()
        players.delete(root)
      }
    document.querySelectorAll<HTMLElement>(`[data-recording="${kind}"]`).forEach((root) => {
      if (!players.has(root)) players.set(root, mount(root, build()))
    })
  }
  start()
  document.addEventListener("astro:page-load", start)
}
