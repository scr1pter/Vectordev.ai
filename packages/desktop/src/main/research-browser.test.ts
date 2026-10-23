import { afterAll, describe, expect, mock, test } from "bun:test"
import type { LookupAddress } from "node:dns"
import net from "node:net"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { clickPoint, observePage, readPage, typeTarget, type PageRead } from "./browser-page"
import { PAGE_STARTED, POST, SCHEME } from "./research-navigation"
import { USER, useResearchNetwork } from "./research-proxy"

// Research browsers against a stand-in for Electron's windows, views, pages and sessions (section 5.6a). What only
// Chromium can show (cookies kept apart between partitions, `<-loopback>`, service workers failing, dialogs, freezing)
// is checked by scripts/research-browser-smoke.ts in the real Electron. Each desktop test file runs in its own process,
// so this file's Electron mock stays its own. The proxies are real and reach the fake web on loopback only.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
useResearchNetwork({
  resolver: (hostname: string): Promise<readonly LookupAddress[]> => web.resolver(hostname),
  privateHosts: [FakeWeb.DOMAIN],
})
afterAll(async () => {
  useResearchNetwork({})
  await web.close()
})

type Listener = (...input: any[]) => unknown

class Emitter {
  readonly listeners = new Map<string, Listener[]>()
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  once(event: string, listener: Listener) {
    const wrapped = (...input: unknown[]) => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((item) => item !== wrapped),
      )
      return listener(...input)
    }
    return this.on(event, wrapped)
  }
  emit(event: string, ...input: unknown[]) {
    ;(this.listeners.get(event) ?? []).forEach((listener) => listener(...input))
  }
}

class FakeSession extends Emitter {
  readonly calls: string[] = []
  readonly proxies: unknown[] = []
  readonly ntlm: string[] = []
  request?: Listener
  check?: Listener
  device?: Listener
  failClear = false
  readonly web: Record<string, Listener> = {}
  readonly webRequest = {
    onBeforeRequest: (listener: Listener) => void (this.web.beforeRequest = listener),
    onBeforeSendHeaders: (listener: Listener) => void (this.web.beforeSendHeaders = listener),
    onHeadersReceived: (listener: Listener) => void (this.web.headersReceived = listener),
    onCompleted: (listener: Listener) => void (this.web.completed = listener),
    onErrorOccurred: (listener: Listener) => void (this.web.errorOccurred = listener),
  }
  constructor(readonly name: string) {
    super()
  }
  setPermissionRequestHandler(listener: Listener) {
    this.request = listener
  }
  setPermissionCheckHandler(listener: Listener) {
    this.check = listener
  }
  setDevicePermissionHandler(listener: Listener) {
    this.device = listener
  }
  allowNTLMCredentialsForDomains(domains: string) {
    this.ntlm.push(domains)
  }
  setSpellCheckerEnabled() {}
  async setProxy(config: unknown) {
    this.proxies.push(config)
  }
  clearStorageData(options?: unknown) {
    this.calls.push(`clearStorageData:${JSON.stringify(options ?? "all")}`)
    return this.failClear ? Promise.reject(new Error("clearing failed")) : Promise.resolve()
  }
  async clearCache() {
    this.calls.push("clearCache")
  }
  async clearAuthCache() {
    this.calls.push("clearAuthCache")
  }
  async clearHostResolverCache() {
    this.calls.push("clearHostResolverCache")
  }
  async closeAllConnections() {
    this.calls.push("closeAllConnections")
  }
}

// What each page script returns, by the function the code runs.
const scripts = new Map<Function, (contents: FakeContents) => unknown>()
const ids = { contents: 0, request: 0 }

class FakeContents extends Emitter {
  readonly id = ++ids.contents
  readonly inputs: { type: string; x?: number; keyCode?: string }[] = []
  readonly devtools: { method: string; params?: unknown }[] = []
  url = ""
  title = ""
  destroyed = false
  muted = false
  webrtc = ""
  openHandler?: Listener
  /** What the page does after a trusted mouse up. */
  onMouseUp?: () => void
  readonly debugger = {
    attach: () => undefined,
    sendCommand: async (method: string, params?: unknown) => void this.devtools.push({ method, params }),
    on: () => undefined,
  }
  readonly navigationHistory = {
    entries: [] as string[],
    getActiveIndex: () => this.navigationHistory.entries.length - 1,
    getEntryAtIndex: (index: number) => ({ url: this.navigationHistory.entries[index]!, title: "" }),
    goBack: () => {
      const back = this.navigationHistory.entries.at(-2)
      if (back) void this.navigate(back, { browser: true })
    },
  }
  constructor(readonly partition: FakeSession) {
    super()
  }
  setAudioMuted(muted: boolean) {
    this.muted = muted
  }
  setWebRTCIPHandlingPolicy(policy: string) {
    this.webrtc = policy
  }
  setWindowOpenHandler(handler: Listener) {
    this.openHandler = handler
  }
  loadURL(url: string) {
    return this.navigate(url, { browser: true })
  }
  /** A navigation through the slot session's onBeforeRequest, as Chromium's network stack makes it. */
  async navigate(url: string, options: { readonly method?: string; readonly browser?: boolean } = {}) {
    const cancelled = await new Promise<boolean>((resolve) =>
      this.partition.web.beforeRequest!(
        {
          id: ++ids.request,
          url,
          method: options.method ?? "GET",
          webContentsId: this.id,
          resourceType: "mainFrame",
          referrer: "",
          timestamp: Date.now(),
          uploadData: [],
        },
        (response: { cancel?: boolean }) => resolve(response.cancel === true),
      ),
    )
    if (cancelled) throw new Error("ERR_BLOCKED_BY_CLIENT (-20) loading " + url)
    if (/\.pdf$/.test(new URL(url).pathname)) {
      const prevented: string[] = []
      this.partition.emit(
        "will-download",
        { preventDefault: () => prevented.push(url) },
        { getURL: () => url, getMimeType: () => "application/pdf" },
        this,
      )
      throw new Error("ERR_ABORTED (-3) loading " + url)
    }
    this.url = url
    this.navigationHistory.entries.push(url)
    this.emit("did-navigate", {}, url, 200, "OK")
  }
  isLoading() {
    return false
  }
  stop() {}
  focus() {}
  getURL() {
    return this.url
  }
  getTitle() {
    return this.title
  }
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.destroyed = true
    this.emit("destroyed")
  }
  sendInputEvent(event: { type: string; x?: number; keyCode?: string }) {
    this.inputs.push(event)
    if (event.type === "mouseUp") this.onMouseUp?.()
  }
  async capturePage() {
    return { toDataURL: () => `data:image/png;base64,${Buffer.from(this.url).toString("base64")}` }
  }
  async executeJavaScriptInIsolatedWorld(world: number, code: { code: string }[]) {
    const source = code[0]!.code
    const known = [...scripts.entries()].find(([fn]) => source.startsWith(`(${fn.toString()})(window`))
    if (known) return known[1](this)
    if (source.includes("scrollBy")) return undefined
    throw new Error(`No script stand-in for ${source.slice(0, 60)} in world ${world}`)
  }
}

const views: FakeView[] = []
class FakeView {
  readonly webContents: FakeContents
  bounds?: unknown
  constructor(readonly options: { webPreferences: { session: FakeSession } & Record<string, unknown> }) {
    this.webContents = new FakeContents(options.webPreferences.session)
    views.push(this)
  }
  setBounds(bounds: unknown) {
    this.bounds = bounds
  }
}

const windows: FakeWindow[] = []
class FakeWindow {
  readonly children = new Set<FakeView>()
  readonly contentView = {
    addChildView: (view: FakeView) => void this.children.add(view),
    removeChildView: (view: FakeView) => void this.children.delete(view),
  }
  constructor(readonly options: Record<string, unknown>) {
    windows.push(this)
  }
  isDestroyed() {
    return false
  }
}

const partitions = new Map<string, FakeSession>()
const electron = {
  app: { getPath: () => "/tmp", isPackaged: false },
  BrowserWindow: Object.assign(FakeWindow, { fromWebContents: () => undefined }),
  WebContentsView: FakeView,
  session: {
    fromPartition: (name: string) => {
      const existing = partitions.get(name) ?? new FakeSession(name)
      partitions.set(name, existing)
      return existing
    },
  },
}
mock.module("electron", () => ({ default: electron, ...electron }))

const research = await import("./research-browser")

const ARTICLE = web.url("article", "/")
// A page on another site, with no robots.txt (so every path is allowed).
const PAPER = web.url("copy", "/heat-pumps")
const read = (links: readonly string[] = []): PageRead => ({
  html: "<html><body><p>The study followed 412 homes.</p></body></html>",
  title: "Heat pumps",
  url: ARTICLE,
  links: links.map((url) => ({ url, text: "a link", main: true })),
  forms: [],
  truncated: false,
})
scripts.set(readPage, () => read([PAPER]))
scripts.set(observePage, () => ({ title: "", url: "", text: "", elements: [], links: [], forms: [] }))

const base = (input: Partial<research.Input> & Pick<research.Input, "command" | "sessionID">): research.Input => ({
  runID: "run_one",
  agent: input.sessionID === "ses_lead" ? "research" : "researcher",
  rootID: "ses_lead",
  max: 3,
  provenance: [ARTICLE],
  ...input,
})
const send = (input: Partial<research.Input> & Pick<research.Input, "command" | "sessionID">) =>
  research.runResearchBrowser(base(input))
// The view a command just opened: views are made in order, one per browser.
const latest = () => views.at(-1)!
const close = (sessionID: string, runID = "run_one") => send({ command: "research.close", sessionID, runID })

describe("the slot pool", () => {
  const fake = (name: string) => new FakeSession(name)

  test("a slot serves one agent at a time and is cleared, every storage type, before the next", async () => {
    const pool = research.slotPool(fake)
    const first = pool.acquire()
    const second = pool.acquire()
    expect([first.name, second.name]).toEqual(["vector-research-1", "vector-research-2"])
    expect(await pool.release(first)).toBe(true)
    expect(first.session.calls).toEqual([
      'clearStorageData:"all"',
      "clearCache",
      "clearAuthCache",
      "clearHostResolverCache",
      "closeAllConnections",
    ])
    // The cleared slot serves the next agent; the busy one does not.
    expect(pool.acquire()).toBe(first)
    expect(pool.acquire().name).toBe("vector-research-3")
  })

  test("a slot whose clearing fails is retired and never used again; the pool grows and does not shrink", async () => {
    const pool = research.slotPool(fake)
    const first = pool.acquire()
    first.session.failClear = true
    expect(await pool.release(first)).toBe(false)
    expect(first.retired).toBe(true)
    const next = pool.acquire()
    expect(next).not.toBe(first)
    expect(next.name).toBe("vector-research-2")
    expect(pool.slots().map((slot) => slot.name)).toEqual(["vector-research-1", "vector-research-2"])
  })
})

describe("research browsers", () => {
  test("each research agent gets a browser of its own, in a slot of its own, apart from the user's browser", async () => {
    const lead = await send({ command: "research.scroll", sessionID: "ses_lead" })
    const view = latest()
    const researcher = await send({ command: "research.scroll", sessionID: "ses_r1" })
    const other = latest()
    expect([lead.ok, researcher.ok]).toEqual([true, true])
    expect([lead.label, researcher.label]).toEqual(["Research lead", "Researcher 1"])
    const names = [view, other].map((item) => item.webContents.partition.name)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name).toMatch(/^vector-research-\d+$/)
    expect(partitions.has("persist:vector-browser")).toBe(false)
    // Hidden, at a real size, with the page's options locked down.
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 900 })
    expect(view.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      disableDialogs: true,
      spellcheck: false,
      backgroundThrottling: false,
      webviewTag: false,
      plugins: false,
    })
    expect(view.options.webPreferences).not.toHaveProperty("preload")
    expect(view.webContents.muted).toBe(true)
    expect(view.webContents.webrtc).toBe("disable_non_proxied_udp")
    expect(windows).toHaveLength(1)
    expect(windows[0]!.options).toMatchObject({ show: false, width: 1280, height: 900 })
    expect(windows[0]!.children.has(view)).toBe(true)
    // Two calls from one agent at once still open one browser.
    await Promise.all([send({ command: "research.scroll", sessionID: "ses_r1" }), send({ command: "research.scroll", sessionID: "ses_r1" })])
    expect(research.ResearchWatch.list().filter((chip) => chip.sessionID === "ses_r1")).toHaveLength(1)
    await close("ses_lead")
    await close("ses_r1")
  })

  test("a run has at most its count of browsers open, and an agent past it waits for one to close", async () => {
    await send({ command: "research.scroll", sessionID: "ses_lead", max: 2 })
    await send({ command: "research.scroll", sessionID: "ses_r1", max: 2 })
    const state = { done: false }
    const waiting = send({ command: "research.scroll", sessionID: "ses_r2", max: 2 }).then((result) => {
      state.done = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(state.done).toBe(false)
    // Another run's agent does not wait on this run's count.
    const other = await send({ command: "research.scroll", sessionID: "ses_lead", runID: "run_two", max: 1 })
    expect(other.ok).toBe(true)
    await close("ses_lead", "run_two")
    await close("ses_r1")
    const third = await waiting
    expect(third.ok).toBe(true)
    expect(third.label).toBe("Researcher 2")
    expect(research.ResearchWatch.list().map((chip) => chip.sessionID).toSorted()).toEqual(["ses_lead", "ses_r2"])
    await close("ses_lead")
    await close("ses_r2")
  })

  test("a slot session is hardened, sends everything through the browser's own proxy, and keeps the rule's listener", async () => {
    await send({ command: "research.scroll", sessionID: "ses_lead" })
    const view = latest()
    const partition = view.webContents.partition
    // Every permission is denied, fullscreen included.
    const answers: boolean[] = []
    for (const permission of ["fullscreen", "media", "notifications", "geolocation", "clipboard-read", "display-capture"])
      partition.request!(view.webContents, permission, (granted: boolean) => answers.push(granted))
    expect(answers).toEqual([false, false, false, false, false, false])
    expect(partition.check!(view.webContents, "fullscreen", ARTICLE, {})).toBe(false)
    expect(partition.device!({})).toBe(false)
    expect(partition.ntlm).toEqual([""])
    // L7's dispatcher must compose this listener, not replace it.
    expect(partition.web.beforeRequest).toBe(research.researchRequestHandlers.beforeRequest)
    expect(partition.web.beforeSendHeaders).toBe(research.researchRequestHandlers.beforeSendHeaders)
    const config = partition.proxies.at(-1) as { mode: string; proxyRules: string; proxyBypassRules: string }
    expect(config).toMatchObject({ mode: "fixed_servers", proxyBypassRules: "<-loopback>" })
    const port = Number(config.proxyRules.split(":").at(-1))
    // The proxy is live, needs its secret, and `login` answers it alone.
    const given: unknown[][] = []
    view.webContents.emit("login", { preventDefault: () => given.push(["prevented"]) }, {}, { isProxy: true, host: "127.0.0.1", port }, (...answer: unknown[]) => given.push(answer))
    view.webContents.emit("login", { preventDefault: () => given.push(["prevented"]) }, {}, { isProxy: false, host: "journal.example", port: 443 }, (...answer: unknown[]) => given.push(answer))
    expect(given[0]).toEqual(["prevented"])
    expect(given[1]![0]).toBe(USER)
    expect(given.slice(2)).toEqual([["prevented"], []])
    // A client certificate request is answered with none.
    const certificates: unknown[][] = []
    view.webContents.emit("select-client-certificate", { preventDefault: () => certificates.push(["prevented"]) }, ARTICLE, [{ subjectName: "user" }], (...answer: unknown[]) => certificates.push(answer))
    expect(certificates).toEqual([["prevented"], []])
    // The page's scripts are frozen between commands and file choosers never open.
    const methods = view.webContents.devtools.map((item) => `${item.method}${item.method === "Page.setWebLifecycleState" ? `:${(item.params as { state: string }).state}` : ""}`)
    expect(methods).toContain("Page.setInterceptFileChooserDialog")
    expect(methods).toContain("Page.addScriptToEvaluateOnNewDocument")
    expect(methods.filter((method) => method.startsWith("Page.setWebLifecycleState"))).toEqual([
      "Page.setWebLifecycleState:active",
      "Page.setWebLifecycleState:frozen",
    ])
    await close("ses_lead")
    // Closed: its pages, then its slot cleared, and its proxy stopped.
    expect(view.webContents.destroyed).toBe(true)
    expect(partition.calls.slice(-5)).toEqual([
      'clearStorageData:"all"',
      "clearCache",
      "clearAuthCache",
      "clearHostResolverCache",
      "closeAllConnections",
    ])
    const refused = await new Promise<boolean>((resolve) =>
      net.connect(port, "127.0.0.1").on("error", () => resolve(true)).on("connect", () => resolve(false)),
    )
    expect(refused).toBe(true)
  })

  test("opens only what the run's provenance holds, and follows a clicked link, which joins it as via S#", async () => {
    const outside = await send({ command: "research.open", sessionID: "ses_lead", url: "https://elsewhere.example/" })
    const view = latest()
    expect(outside).toMatchObject({ ok: false, error: ResearchProvenance.REFUSAL })
    const opened = await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    expect(opened).toMatchObject({ ok: true, url: ARTICLE, status: 200 })
    // The article's robots.txt came through the browser's proxy.
    expect(web.count("article", "/robots.txt")).toBe(1)
    expect(web.count("article", "/")).toBe(0)
    // The agent read the page, so its links are on it; a click on one is followed.
    await send({ command: "research.read", sessionID: "ses_lead" })
    scripts.set(clickPoint, () => ({ ok: true, x: 40, y: 60, hit: true, href: PAPER }))
    view.webContents.onMouseUp = () => void view.webContents.navigate(PAPER).catch(() => undefined)
    const clicked = await send({ command: "research.click", sessionID: "ses_lead", ref: "ref_1" })
    expect(view.webContents.inputs.filter((input) => input.type.startsWith("mouse")).map((input) => input.type)).toEqual([
      "mouseMove",
      "mouseDown",
      "mouseUp",
    ])
    expect(clicked.joined).toEqual([PAPER])
    // The page later walking the browser to another site on its own is refused, and the browser stays.
    view.webContents.onMouseUp = undefined
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    await view.webContents.navigate("https://tracker.example/?id=1").catch(() => undefined)
    const after = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(after.refused).toEqual([{ url: "https://tracker.example/?id=1", reason: PAGE_STARTED }])
    expect(after.url).toBe(PAPER)
    // A form that would send data is refused in any frame, and so is a non-web scheme.
    await view.webContents.navigate("https://other.example/comment", { method: "POST" }).catch(() => undefined)
    const frame = await new Promise<boolean>((resolve) =>
      research.researchRequestHandlers.beforeRequest(
        { id: 9_001, url: "https://ads.example/form", method: "POST", webContentsId: view.webContents.id, resourceType: "subFrame", referrer: "", timestamp: 0, uploadData: [] } as never,
        (response) => resolve(response.cancel === true),
      ),
    )
    expect(frame).toBe(true)
    const navigate = { prevented: false }
    view.webContents.emit("will-frame-navigate", { url: "data:text/html,hi", isMainFrame: true, isSameDocument: false, preventDefault: () => (navigate.prevented = true) })
    expect(navigate.prevented).toBe(true)
    const refused = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(refused.refused).toEqual([
      { url: "https://other.example/comment", reason: POST },
      { url: "https://ads.example/form", reason: POST },
      { url: "data:text/html,hi", reason: SCHEME },
    ])
    await close("ses_lead")
  }, 30_000)

  test("bounds what a page loads: no fonts, images only for image models, 150 requests, nothing private", async () => {
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    const view = latest()
    const request = (url: string, resourceType: string, from: { readonly webContentsId?: number } = { webContentsId: view.webContents.id }) =>
      new Promise<boolean>((resolve) =>
        research.researchRequestHandlers.beforeRequest(
          { id: ++ids.request, url, method: "GET", ...from, resourceType, referrer: "", timestamp: 0, uploadData: [] } as never,
          (response) => resolve(response.cancel !== true),
        ),
      )
    expect(await request("https://cdn.example/font.woff2", "font")).toBe(false)
    expect(await request("https://cdn.example/photo.jpg", "image")).toBe(false)
    expect(await request("https://cdn.example/clip.mp4", "media")).toBe(false)
    // A request no research browser made, such as a service worker's, is refused.
    expect(await request("https://cdn.example/app.js", "script", {})).toBe(false)
    expect(await request("https://cdn.example/app.js", "script", { webContentsId: 99_999 })).toBe(false)
    expect(await request("http://127.0.0.1:4096/session", "xhr")).toBe(false)
    expect(await request("ws://localhost:3000/socket", "webSocket")).toBe(false)
    const allowed = await Promise.all(
      Array.from({ length: research.MAX_SUBRESOURCES + 1 }, (_, index) => request(`https://cdn.example/${index}.js`, "script")),
    )
    expect(allowed.filter(Boolean)).toHaveLength(research.MAX_SUBRESOURCES)
    // A service worker's script is refused in the network stack.
    const headers = await new Promise<boolean>((resolve) =>
      research.researchRequestHandlers.beforeSendHeaders(
        { id: 1, url: "https://journal.example/sw.js", method: "GET", webContentsId: view.webContents.id, resourceType: "script", referrer: "", timestamp: 0, requestHeaders: { "Service-Worker": "script" } } as never,
        (response) => resolve(response.cancel === true),
      ),
    )
    expect(headers).toBe(true)
    // The next page load starts its own count; an image model's browser loads images.
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE, images: true })
    expect(await request("https://cdn.example/photo.jpg", "image")).toBe(true)
    // 20 MB of sub-resources, by their Content-Length, is the most one page load gets.
    research.researchRequestHandlers.headersReceived(
      { id: 2, url: "https://cdn.example/big.js", method: "GET", webContentsId: view.webContents.id, resourceType: "script", responseHeaders: { "Content-Length": [String(research.MAX_SUBRESOURCE_BYTES + 1)] } } as never,
      () => undefined,
    )
    expect(await request("https://cdn.example/after.js", "script")).toBe(false)
    await close("ses_lead")
  })

  test("downloads stay off, and a PDF is read into memory through the browser's proxy", async () => {
    const pdf = web.url("docs", "/report.pdf")
    const result = await send({ command: "research.open", sessionID: "ses_lead", url: pdf, provenance: [pdf] })
    const view = latest()
    expect(result.ok).toBe(true)
    expect(result.pdf?.url).toBe(pdf)
    expect(Buffer.from(result.pdf!.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-")
    expect(result.pdf?.contentType).toBe("application/pdf")
    const prevented: string[] = []
    view.webContents.partition.emit(
      "will-download",
      { preventDefault: () => prevented.push("cancelled") },
      { getURL: () => "https://files.example/archive.zip", getMimeType: () => "application/zip" },
      view.webContents,
    )
    expect(prevented).toEqual(["cancelled"])
    const next = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(next.refused).toEqual([{ url: "https://files.example/archive.zip", reason: research.DOWNLOADS_OFF }])
    await close("ses_lead")
  })

  test("types only what the agent may, and presses only the keys research needs", async () => {
    await send({ command: "research.open", sessionID: "ses_lead", url: ARTICLE })
    const view = latest()
    scripts.set(typeTarget, () => ({ ok: false, reason: "Research browsers never type into a sign-in, contact or payment field." }))
    expect(await send({ command: "research.type", sessionID: "ses_lead", ref: "ref_2", text: "heat pumps" })).toMatchObject({
      ok: false,
      error: "Research browsers never type into a sign-in, contact or payment field.",
    })
    expect(await send({ command: "research.type", sessionID: "ses_lead", ref: "ref_2", text: "heat\npumps" })).toMatchObject({ ok: false })
    expect(await send({ command: "research.press", sessionID: "ses_lead", key: "a" })).toMatchObject({ ok: false })
    expect(await send({ command: "research.press", sessionID: "ses_lead", key: "Escape" })).toMatchObject({ ok: true })
    expect(view.webContents.inputs.filter((input) => input.type.startsWith("key")).map((input) => input.keyCode)).toEqual(["Escape", "Escape"])
    // Screenshots only for a model that reads images.
    expect(await send({ command: "research.screenshot", sessionID: "ses_lead" })).toMatchObject({ ok: false })
    expect((await send({ command: "research.screenshot", sessionID: "ses_lead", images: true })).screenshot).toStartWith("data:image/png")
    await close("ses_lead")
  })

  test("watching shows chips and snapshots, offers Stop and no way to send input", async () => {
    await send({ command: "research.open", sessionID: "ses_r1", url: ARTICLE })
    expect(Object.keys(research.ResearchWatch).toSorted()).toEqual(["list", "snapshot", "stop", "subscribe"])
    const chips = research.ResearchWatch.list()
    expect(chips).toEqual([
      { id: "run_one:ses_r1", runID: "run_one", sessionID: "ses_r1", label: "Researcher 1", host: "article.web.test", state: "idle" },
    ])
    expect(await research.ResearchWatch.snapshot("run_one:ses_r1")).toStartWith("data:image/png;base64,")
    const events: string[] = []
    const stop = research.ResearchWatch.subscribe(() => events.push("changed"))
    expect(await research.ResearchWatch.stop("run_one:ses_r1")).toBe(true)
    stop()
    expect(events.length).toBeGreaterThan(0)
    expect(research.ResearchWatch.list()).toEqual([])
    expect(await research.ResearchWatch.snapshot("run_one:ses_r1")).toBeUndefined()
  })

  test("a command naming another copy of the run's provenance is told to send it whole", async () => {
    const started = await send({ command: "research.scroll", sessionID: "ses_lead" })
    expect(started.generation).toBeTruthy()
    expect(await send({ command: "research.scroll", sessionID: "ses_lead", generation: "stale" })).toMatchObject({
      ok: false,
      resync: true,
    })
    expect(await send({ command: "research.scroll", sessionID: "ses_lead", generation: started.generation })).toMatchObject({ ok: true })
    await close("ses_lead")
    expect(guard.outside()).toEqual([])
    expect(LocalPolicy.hostClass("article.web.test")).toBe("internet")
  })
})
