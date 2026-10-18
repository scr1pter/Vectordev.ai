import { app, BrowserWindow, shell } from "electron"
import {
  billingNavigation,
  billingStep,
  billingTitle,
  billingWindowOptions,
  type BillingOutcome,
} from "./billing-navigation"
import { write as writeLog } from "./logging"

const windows = new WeakSet<BrowserWindow>()
const state: { current?: BrowserWindow } = {}

/** The account status and other app events go to Vector's own windows only, never to the Stripe page. */
export function isBillingWindow(window: BrowserWindow) {
  return windows.has(window)
}

/**
 * Shows a Stripe Checkout or customer portal page in a Vector window and resolves when it is done: Stripe sent the
 * person back to the site (see billingReturn), they closed the window, or the page could not load. Its settings are
 * billingWindowOptions. A request while one is open gets "busy" and brings that window forward, so it never takes the
 * open window's result for its own.
 */
export function openBillingWindow(url: string, origin: string, parent?: BrowserWindow | null) {
  if (focusBillingWindow()) return Promise.resolve<BillingOutcome>("busy")
  const owner = parent && !parent.isDestroyed() ? parent : undefined
  const window = new BrowserWindow({
    ...(owner ? { parent: owner } : {}),
    ...billingWindowOptions(url, owner?.getBounds(), app.isPackaged),
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
    if (state.current === window) state.current = undefined
    finished.resolve(outcome)
    if (!window.isDestroyed()) window.close()
  }
  // Carries out billingStep for one navigation or redirect; returns whether the window may load it.
  const route = (target: string, mainFrame = true) => {
    const step = billingStep(target, origin, mainFrame)
    if (step.load) return true
    if (step.browser) void shell.openExternal(target)
    if (step.finish) finish(step.finish)
    // The origin only: a page address can carry a session's identifiers.
    if (step.kept)
      writeLog(
        "billing",
        "kept a navigation out of the billing window",
        { origin: URL.parse(target)?.origin, where: step.kept },
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
  // will-navigate is the page's own; will-redirect also comes from frames, which billingStep lets through.
  contents.on("will-navigate", (event) => {
    if (!route(event.url, event.isMainFrame)) event.preventDefault()
  })
  contents.on("will-redirect", (event) => {
    if (!route(event.url, event.isMainFrame)) event.preventDefault()
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
    if (state.current === window) state.current = undefined
    void billing.clearStorageData().catch(() => undefined)
  })

  state.current = window
  // Failures arrive through did-fail-load; a navigation this window stopped itself also rejects here.
  void window.loadURL(url).catch(() => undefined)
  return finished.promise
}

/** Brings the open billing window forward; false when none is open. */
export function focusBillingWindow() {
  const open = state.current
  if (!open || open.isDestroyed()) return false
  if (open.isMinimized()) open.restore()
  open.focus()
  return true
}
