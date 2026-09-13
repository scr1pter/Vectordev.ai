import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { LAUNCH_TEXT, startLaunchScreen, type LaunchApi, type LaunchWindow } from "./launch-host"
import { LAUNCH_TIMINGS } from "./launch-state"

const markup = readFileSync(new URL("./launch-screen.html", import.meta.url), "utf8")
const win = window as unknown as LaunchWindow
const html = document.documentElement

// A virtual clock: timers only fire when the test advances time.
function createClock() {
  let time = 1_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => time,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { at: time + ms, fn })
      return id
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number)
    },
    advance(ms: number) {
      const end = time + ms
      while (true) {
        let next: [number, { at: number; fn: () => void }] | undefined
        for (const entry of timers) {
          if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
        }
        if (!next) break
        timers.delete(next[0])
        time = Math.max(time, next[1].at)
        next[1].fn()
      }
      time = end
    },
    pending: () => timers.size,
  }
}

let clock: ReturnType<typeof createClock>
let host: LaunchApi | undefined

const start = (now?: () => number) => {
  host = startLaunchScreen({
    now: now ?? clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  return host
}
const overlay = () => document.getElementById("vector-launch")
const allReady = (api: LaunchApi) => {
  api.signal("settings")
  api.signal("shell")
  api.signal("engine")
  api.signal("data")
}

beforeEach(() => {
  clock = createClock()
  document.body.innerHTML = markup
  localStorage.clear()
  for (const name of [...html.getAttributeNames()])
    if (name.startsWith("data-vector-launch")) html.removeAttribute(name)
  html.style.removeProperty("--vector-launch-nav")
  delete win.api
})

afterEach(() => {
  host?.dispose()
  host = undefined
  delete win.api
  delete (navigator as { platform?: string }).platform
})

describe("launch host", () => {
  test("stamps the first-frame attributes from the settings mirrors and the saved sidebar", () => {
    localStorage.setItem("vector.glass", "false")
    localStorage.setItem("vector.reduce-animations", "true")
    localStorage.setItem("vector.navigation-width.v1", "999")
    start()
    expect(html.getAttribute("data-vector-launch")).toBe("veiled")
    expect(html.getAttribute("data-vector-launch-glass")).toBe("off")
    expect(html.getAttribute("data-vector-launch-motion")).toBe("reduced")
    expect(html.style.getPropertyValue("--vector-launch-nav")).toBe("460px")
  })

  test("reveals on the web once everything is ready, stops taking input, then removes itself", () => {
    const done = mock(() => {})
    window.addEventListener("vector:launch-done", done)
    const api = start()
    allReady(api)
    const node = overlay()!
    expect(api.phase()).toBe("revealing")
    expect(node.getAttribute("data-state")).toBe("revealing")
    expect(node.getAttribute("aria-hidden")).toBe("true")
    expect(node.inert).toBe(true)
    expect(node.style.pointerEvents).toBe("none")

    clock.advance(LAUNCH_TIMINGS.EXIT_MS + LAUNCH_TIMINGS.REMOVE_SLACK_MS - 1)
    expect(overlay()).not.toBeNull()
    clock.advance(1)
    expect(overlay()).toBeNull()
    expect(api.phase()).toBe("gone")
    expect(html.getAttribute("data-vector-launch")).toBe("done")
    expect(html.hasAttribute("data-vector-launch-motion")).toBe(false)
    expect(done).toHaveBeenCalledTimes(1)
    expect(clock.pending()).toBe(0)
    window.removeEventListener("vector:launch-done", done)
  })

  test("desktop holds the glass for 800ms on a warm start", () => {
    win.api = {}
    const api = start()
    clock.advance(100)
    allReady(api)
    expect(api.phase()).toBe("veiled")
    clock.advance(600)
    expect(api.phase()).toBe("veiled")
    clock.advance(101)
    expect(api.phase()).toBe("revealing")
  })

  test("shows the slow hint at 8s, with the Keychain wording on a Mac desktop", () => {
    win.api = {}
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true })
    const api = start()
    clock.advance(LAUNCH_TIMINGS.SLOW_MS - 1)
    expect(api.phase()).toBe("veiled")
    clock.advance(2)
    expect(api.phase()).toBe("slow")
    expect(overlay()!.getAttribute("data-state")).toBe("slow")
    expect(document.querySelector("[data-vector-launch-hint]")!.textContent).toBe(LAUNCH_TEXT.keychainHint)
    expect(document.querySelector("[data-vector-launch-status]")!.textContent).toBe(LAUNCH_TEXT.slowStatus)
  })

  test("the web slow hint keeps the neutral wording", () => {
    const api = start()
    clock.advance(LAUNCH_TIMINGS.SLOW_MS + 1)
    expect(api.phase()).toBe("slow")
    expect(document.querySelector("[data-vector-launch-hint]")!.textContent).toBe("Still starting…")
  })

  test("the hard cap fails the glass with no signal at all, and a late ready still reveals", () => {
    const api = start()
    clock.advance(LAUNCH_TIMINGS.HARD_MAX_MS + 1)
    expect(api.phase()).toBe("failed")
    const node = overlay()!
    expect(node.getAttribute("data-state")).toBe("failed")
    expect(document.querySelector("[data-vector-launch-status]")!.textContent).toBe(LAUNCH_TEXT.failedStatus)
    const reload = node.querySelector<HTMLElement>('[data-vector-launch-action="reload"]')!
    const restart = node.querySelector<HTMLElement>('[data-vector-launch-action="restart"]')!
    expect(document.activeElement).toBe(reload)
    expect(restart.hidden).toBe(true)

    allReady(api)
    expect(api.phase()).toBe("revealing")
    clock.advance(1_000)
    expect(overlay()).toBeNull()
  })

  test("the watchdog still fails the glass if deciding ever throws", () => {
    let broken = false
    const api = start(() => {
      if (broken) throw new Error("clock broke")
      return clock.now()
    })
    broken = true
    api.signal("shell")
    clock.advance(LAUNCH_TIMINGS.HARD_MAX_MS + 1_000)
    expect(api.phase()).toBe("failed")
  })

  test("Restart on desktop kills the engine, then relaunches", async () => {
    const order: string[] = []
    win.api = {
      killSidecar: async () => {
        order.push("kill")
      },
      relaunch: () => {
        order.push("relaunch")
      },
    }
    const api = start()
    clock.advance(LAUNCH_TIMINGS.HARD_MAX_MS + 1)
    expect(api.phase()).toBe("failed")
    const restart = overlay()!.querySelector<HTMLElement>('[data-vector-launch-action="restart"]')!
    expect(restart.hidden).toBe(false)
    restart.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(["kill", "relaunch"])
  })

  test("a blocking screen takes over at once, before the minimum and even after failure", () => {
    win.api = {}
    const api = start()
    api.yield("license")
    expect(api.phase()).toBe("revealing")

    host?.dispose()
    document.body.innerHTML = markup
    const again = start()
    clock.advance(LAUNCH_TIMINGS.HARD_MAX_MS + 1)
    expect(again.phase()).toBe("failed")
    again.yield("error")
    expect(again.phase()).toBe("revealing")
  })

  test("a failed module script fails the glass at once", () => {
    const api = start()
    const script = document.createElement("script")
    script.type = "module"
    document.head.appendChild(script)
    script.dispatchEvent(new Event("error"))
    expect(api.phase()).toBe("failed")
    script.remove()
  })

  test("other failed resources are ignored", () => {
    const api = start()
    const image = document.createElement("img")
    document.body.appendChild(image)
    image.dispatchEvent(new Event("error"))
    expect(api.phase()).toBe("veiled")
  })

  test("an uncaught error before the app rendered fails at once; after attach it is the ErrorBoundary's", () => {
    const api = start()
    api.attach()
    window.dispatchEvent(new ErrorEvent("error", { message: "late app error" }))
    expect(api.phase()).toBe("veiled")

    host?.dispose()
    document.body.innerHTML = markup
    const fresh = start()
    window.dispatchEvent(new ErrorEvent("error", { message: "SyntaxError in bundle" }))
    expect(fresh.phase()).toBe("failed")
  })

  test("a failed module script after attach is not a failed bundle", () => {
    const api = start()
    api.attach()
    const script = document.createElement("script")
    script.type = "module"
    document.head.appendChild(script)
    script.dispatchEvent(new Event("error"))
    expect(api.phase()).toBe("veiled")
    script.remove()
  })

  test("a wrongly guessed bundle failure still reveals once the app turns out ready, then removes itself", () => {
    const api = start()
    window.dispatchEvent(new ErrorEvent("error", { message: "an extension threw before the app rendered" }))
    expect(api.phase()).toBe("failed")
    clock.advance(500)
    expect(document.querySelector("[data-vector-launch-status]")!.textContent).toBe(LAUNCH_TEXT.failedStatus)

    api.attach()
    allReady(api)
    expect(api.phase()).toBe("revealing")
    clock.advance(LAUNCH_TIMINGS.EXIT_MS + LAUNCH_TIMINGS.REMOVE_SLACK_MS)
    expect(overlay()).toBeNull()
    expect(api.phase()).toBe("gone")
    expect(html.getAttribute("data-vector-launch")).toBe("done")
  })

  test("announces the start a moment after the status region exists, with nothing busy above it", () => {
    const status = document.querySelector("[data-vector-launch-status]")!
    expect(status.textContent).toBe("")
    const api = start()
    expect(status.textContent).toBe("")
    clock.advance(1_000)
    expect(api.phase()).toBe("veiled")
    expect(status.textContent).toBe(LAUNCH_TEXT.startingStatus)
    expect(status.closest("[aria-busy]")).toBeNull()
    clock.advance(LAUNCH_TIMINGS.SLOW_MS)
    expect(status.textContent).toBe(LAUNCH_TEXT.slowStatus)
    expect(status.closest("[aria-busy]")).toBeNull()
  })

  test("the failure screen makes the app underneath inert until something reveals it", () => {
    document.body.insertAdjacentHTML("beforeend", '<div id="root"><button>New session</button></div>')
    const root = document.getElementById("root")!
    const api = start()
    expect(root.inert).toBeFalsy()
    clock.advance(LAUNCH_TIMINGS.HARD_MAX_MS + 1)
    expect(api.phase()).toBe("failed")
    expect(root.inert).toBe(true)
    allReady(api)
    expect(api.phase()).toBe("revealing")
    expect(root.inert).toBe(false)

    // Disposing while failed lets go of it too.
    host?.dispose()
    document.body.innerHTML = `${markup}<div id="root"></div>`
    const again = start()
    const fresh = document.getElementById("root")!
    clock.advance(LAUNCH_TIMINGS.HARD_MAX_MS + 1)
    expect(fresh.inert).toBe(true)
    again.dispose()
    expect(fresh.inert).toBe(false)
  })

  test("an unreachable engine hands over to the app after 3s of unhealthy", () => {
    const api = start()
    api.signal("settings")
    api.signal("shell")
    api.unhealthy(true)
    clock.advance(LAUNCH_TIMINGS.UNHEALTHY_GRACE_MS - 1)
    expect(api.phase()).toBe("veiled")
    clock.advance(2)
    expect(api.phase()).toBe("revealing")
  })

  test("reduced motion removes the node after the 200ms fade", () => {
    localStorage.setItem("vector.reduce-animations", "true")
    const api = start()
    allReady(api)
    clock.advance(LAUNCH_TIMINGS.EXIT_REDUCED_MS + LAUNCH_TIMINGS.REMOVE_SLACK_MS)
    expect(overlay()).toBeNull()
  })

  test("signals after the glass is gone are ignored, and starting twice returns the same host", () => {
    const api = start()
    expect(startLaunchScreen()).toBe(api)
    allReady(api)
    clock.advance(1_000)
    api.signal("shell", false)
    api.yield("error")
    api.fail()
    expect(api.phase()).toBe("gone")
  })
})
