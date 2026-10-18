import { app, BrowserWindow, session, shell } from "electron"
import { billingNavigation, billingReturn, billingTitle, type BillingOutcome } from "./billing-navigation"
import { write as writeLog } from "./logging"

// In memory only (no "persist:" prefix), and cleared after each use, so no Stripe or Link sign-in outlives the window.
const PARTITION = "vector-billing"
const windows = new WeakSet<BrowserWindow>()
const state: { current?: { window: BrowserWindow; done: Promise<BillingOutcome> } } = {}

/** The account status and other app events go to Vector's own windows only, never to the Stripe page. */
export function isBillingWindow(window: BrowserWindow) {
  return windows.has(window)
}

/**
 * Shows a Stripe Checkout or customer portal page in a Vector window and resolves when it is done: Stripe sent the
 * person back to the site (see billingReturn), they closed the window, or the page could not load. The window has
 * no preload, so the page can never reach Vector's IPC; it uses its own session, so the main window's permission
 * and header handlers do not apply to it and nothing it stores reaches the app. A second request while one is open
 * brings that window forward instead.
 */
export function openBillingWindow(url: string, origin: string, parent?: BrowserWindow | null) {
  if (state.current && !state.current.window.isDestroyed()) {
    state.current.window.focus()
    return state.current.done
  }
  const owner = parent && !parent.isDestroyed() ? parent : undefined
  const bounds = owner?.getBounds()
  const window = new BrowserWindow({
    ...(owner ? { parent: owner } : {}),
    // A sheet on macOS. Elsewhere a modal child disables the app and can end up behind other windows.
    modal: process.platform === "darwin" && Boolean(owner),
    width: Math.min(960, bounds?.width ?? 960),
    height: Math.min(760, bounds?.height ?? 760),
    minWidth: 420,
    minHeight: 480,
    show: false,
    title: billingTitle(url),
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  })
  windows.add(window)
  const contents = window.webContents
  const billing = contents.session
  const finished = Promise.withResolvers<BillingOutcome>()
  const settle = { done: false }
  const finish = (outcome: BillingOutcome) => {
    if (settle.done) return
    settle.done = true
    // The window closes a moment later; a new request in the meantime gets a new window, not this finished one.
    if (state.current?.window === window) state.current = undefined
    finished.resolve(outcome)
    if (!window.isDestroyed()) window.close()
  }
  // Decides one top-level navigation; returns whether the window may load it.
  const route = (target: string) => {
    const back = billingReturn(target, origin)
    if (back === "external") void shell.openExternal(target)
    if (back && back !== "external") finish(back)
    if (back) return false
    const where = billingNavigation(target)
    if (where === "allow") return true
    if (where === "external") void shell.openExternal(target)
    // The origin only: a page address can carry a session's identifiers.
    writeLog(
      "billing",
      "kept a navigation out of the billing window",
      { origin: URL.parse(target)?.origin, where },
      "warn",
    )
    return false
  }

  billing.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  billing.setPermissionCheckHandler(() => false)
  // Catches every way back to the site, server redirects and form posts included, before the request leaves.
  billing.webRequest.onBeforeRequest({ urls: [`${origin}/*`] }, (details, callback) => {
    if (details.resourceType !== "mainFrame") return callback({})
    callback({ cancel: true })
    route(details.url)
  })
  contents.on("will-navigate", (event, target) => {
    if (!route(target)) event.preventDefault()
  })
  contents.on("will-redirect", (event, target) => {
    if (!route(target)) event.preventDefault()
  })
  // Invoices and receipts open in new tabs; they go to the browser, which can download and keep them.
  contents.setWindowOpenHandler(({ url: target }) => {
    if (billingNavigation(target) !== "block") void shell.openExternal(target)
    return { action: "deny" }
  })
  billing.removeAllListeners("will-download")
  billing.on("will-download", (event, item) => {
    event.preventDefault()
    if (billingNavigation(item.getURL()) !== "block") void shell.openExternal(item.getURL())
  })
  // A page that could not load at all; -3 is a navigation this window stopped itself.
  contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) finish("failed")
  })
  contents.on("page-title-updated", (event) => event.preventDefault())
  contents.on("did-navigate", (_event, target) => {
    if (!window.isDestroyed()) window.setTitle(billingTitle(target))
  })
  const show = () => {
    if (!window.isDestroyed() && !settle.done && !window.isVisible()) window.show()
  }
  window.once("ready-to-show", show)
  setTimeout(show, 3_000)
  window.once("closed", () => {
    finish("closed")
    if (state.current?.window === window) state.current = undefined
    void billing.clearStorageData().catch(() => undefined)
  })

  state.current = { window, done: finished.promise }
  // Failures arrive through did-fail-load; a navigation this window stopped itself also rejects here.
  void window.loadURL(url).catch(() => undefined)
  return finished.promise
}
