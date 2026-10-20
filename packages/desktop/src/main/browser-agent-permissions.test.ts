import { describe, expect, mock, test } from "bun:test"
import type { BrowserAgentInput } from "../preload/types"

// The agent browser's permissions, downloads, dialog cover and per-page queue, against a stand-in for Electron's
// views, windows and sessions. Bun keeps a module mock for the rest of a run; the desktop suite runs each file in
// its own process.

type Handler = (...input: unknown[]) => unknown

class FakeSession {
  request?: Handler
  check?: Handler
  installs = 0
  readonly listeners = new Map<string, Handler>()
  setPermissionRequestHandler(handler: Handler) {
    this.installs++
    this.request = handler
  }
  setPermissionCheckHandler(handler: Handler) {
    this.check = handler
  }
  on(event: string, listener: Handler) {
    this.listeners.set(event, listener)
  }
}

const contents = () => ({
  on: () => undefined,
  setWindowOpenHandler: () => undefined,
  isDestroyed: () => false,
  getURL: () => "",
  getTitle: () => "",
  close: () => undefined,
  isLoading: () => false,
  navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  executeJavaScript: async () => undefined,
})

// Every view the agent creates, newest last.
const created: FakeView[] = []

class FakeView {
  readonly webContents = contents()
  visible = true
  constructor() {
    created.push(this)
  }
  setBackgroundColor() {}
  setBounds() {}
  setVisible(visible: boolean) {
    this.visible = visible
  }
  getVisible() {
    return this.visible
  }
}

const fakeWindow = () => ({
  contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  webContents: { send: () => undefined },
  once: () => undefined,
  isDestroyed: () => false,
})

const partitions = new Map<string, FakeSession>()
const windows = new Map<unknown, ReturnType<typeof fakeWindow>>()
const electron = {
  BrowserWindow: { fromWebContents: (sender: unknown) => windows.get(sender) },
  WebContentsView: FakeView,
  session: {
    fromPartition: (name: string) => {
      const existing = partitions.get(name) ?? new FakeSession()
      partitions.set(name, existing)
      return existing
    },
  },
}
mock.module("electron", () => ({ default: electron, ...electron }))

const agent = await import("./browser-agent")
const run = (input: BrowserAgentInput, event?: unknown) =>
  agent.runBrowserAgent(event as Parameters<typeof agent.runBrowserAgent>[0], input)
const panel = () => {
  const sender = { getZoomFactor: () => 1 }
  const window = fakeWindow()
  windows.set(sender, window)
  return { event: { sender }, window }
}

describe("agent browser permissions and downloads", () => {
  test("grants a page fullscreen and nothing else", () => {
    expect(agent.browserPermissionAllowed("fullscreen")).toBe(true)
    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "clipboard-read",
      "clipboard-sanitized-write",
      "midi",
      "midiSysex",
      "pointerLock",
      "keyboardLock",
      "openExternal",
      "display-capture",
      "window-management",
      "storage-access",
      "fileSystem",
      "hid",
      "serial",
      "usb",
      "unknown",
    ])
      expect({ permission, allowed: agent.browserPermissionAllowed(permission) }).toEqual({
        permission,
        allowed: false,
      })
  })

  test("the agent browser's partition answers permission requests and checks itself, once", async () => {
    await run({ contextId: "ses_permissions", command: "wait", milliseconds: 0 })
    await run({ contextId: "ses_permissions_other", command: "wait", milliseconds: 0 })
    const partition = partitions.get("persist:vector-browser")!
    expect(partition.installs).toBe(1)
    const answers: boolean[] = []
    partition.request!(undefined, "media", (granted: boolean) => answers.push(granted))
    partition.request!(undefined, "notifications", (granted: boolean) => answers.push(granted))
    partition.request!(undefined, "fullscreen", (granted: boolean) => answers.push(granted))
    expect(answers).toEqual([false, false, true])
    expect(partition.check!(undefined, "geolocation", "https://example.com", {})).toBe(false)
    expect(partition.check!(undefined, "fullscreen", "https://example.com", {})).toBe(true)
  })

  test("cancels a download and says so in the page's next report", async () => {
    const first = await run({ contextId: "ses_download", command: "wait", milliseconds: 0 })
    expect(first.networkErrors).toEqual([])
    const partition = partitions.get("persist:vector-browser")!
    const view = created.at(-1)!
    const cancelled: string[] = []
    partition.listeners.get("will-download")!(
      { preventDefault: () => cancelled.push("cancelled") },
      { getURL: () => "https://files.example.com/report.zip?token=abc123" },
      view.webContents,
    )
    expect(cancelled).toEqual(["cancelled"])
    const next = await run({ contextId: "ses_download", command: "wait", milliseconds: 0 })
    expect(next.networkErrors).toEqual([
      { url: expect.stringContaining("https://files.example.com/report.zip"), error: agent.DOWNLOADS_OFF },
    ])
    expect(next.networkErrors[0]!.url).not.toContain("abc123")
    expect(next.actions.some((action) => action.label === "Cancelled a download" && !action.ok)).toBe(true)
    // A download from a page no task owns is still cancelled.
    partition.listeners.get("will-download")!(
      { preventDefault: () => cancelled.push("cancelled") },
      { getURL: () => "https://files.example.com/other.zip" },
      contents(),
    )
    expect(cancelled).toEqual(["cancelled", "cancelled"])
  })
})

describe("dialogs over the agent browser", () => {
  const context = (id: string, window: object, visible: boolean) => {
    const view = new FakeView()
    view.visible = visible
    return { id, view, hostWindow: window } as unknown as agent.BrowserContext
  }

  test("hide every view in the dialog's window, and restore only the ones they hid", () => {
    const window = fakeWindow()
    const elsewhere = fakeWindow()
    const shown = context("shown", window, true)
    const parked = context("parked", window, false)
    const other = context("other", elsewhere, true)
    const all = [shown, parked, other]
    const visible = () => all.map((item) => (item.view as unknown as FakeView).visible)

    agent.setWindowVisible(window as never, false, all)
    expect(visible()).toEqual([false, false, true])
    agent.setWindowVisible(window as never, false, all)
    expect(visible()).toEqual([false, false, true])
    agent.setWindowVisible(window as never, true, all)
    expect(visible()).toEqual([true, false, true])
  })

  test("the app's dialog hides the attached browser whatever context it names, and a view attached under it waits", async () => {
    const { event, window } = panel()
    await run({ contextId: "ses_panel", command: "attach", bounds: { x: 0, y: 0, width: 800, height: 600 } }, event)
    const view = created.at(-1)!
    expect(view.visible).toBe(true)

    expect((await run({ contextId: "modal", command: "setVisible", visible: false }, event)).browserStatus).toBe(
      "stopped",
    )
    expect(view.visible).toBe(false)

    await run({ contextId: "ses_panel_late", command: "attach" }, event)
    const late = created.at(-1)!
    expect(late).not.toBe(view)
    expect(late.visible).toBe(false)

    await run({ contextId: "modal", command: "setVisible", visible: true }, event)
    // The view attached last is the one the panel shows; attaching it parked the first.
    expect(late.visible).toBe(true)
    expect(view.visible).toBe(false)
    expect(windows.get(event.sender)).toBe(window)
  })
})

describe("commands on one page", () => {
  test("run one after the other, while other pages run alongside", async () => {
    const order: string[] = []
    const slow = run({ contextId: "ses_queue", command: "wait", milliseconds: 80 }).then(() => order.push("slow"))
    const next = run({ contextId: "ses_queue", command: "wait", milliseconds: 0 }).then(() => order.push("next"))
    const elsewhere = run({ contextId: "ses_queue_other", command: "wait", milliseconds: 0 }).then(() =>
      order.push("elsewhere"),
    )
    await Promise.all([slow, next, elsewhere])
    expect(order).toEqual(["elsewhere", "slow", "next"])
  })

  test("a failed command does not stop the next one", async () => {
    const failed = await run({ contextId: "ses_queue_fail", command: "click" })
    expect(failed.ok).toBe(false)
    const after = await run({ contextId: "ses_queue_fail", command: "wait", milliseconds: 0 })
    expect(after.ok).toBe(true)
  })

  test("sets no cap on pages", async () => {
    const reports = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        run({ contextId: `ses_many_${index}`, command: "wait", milliseconds: 0 }),
      ),
    )
    expect(reports.every((report) => report.ok && report.browserStatus === "running")).toBe(true)
  })
})
