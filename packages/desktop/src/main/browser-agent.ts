import { BrowserWindow, WebContentsView, session, type IpcMainInvokeEvent, type WebContents } from "electron"
import { isCredentialField } from "./browser-credential-field"
import { CredentialFocusChangedError, sendGuardedCharacters } from "./browser-credential-input"
import { browserOrigin, isAllowedBrowserNavigation, isLocalBrowserUrl } from "./browser-navigation-policy"
import { AsyncLocalStorage } from "node:async_hooks"

import type { BrowserAgentInput, BrowserAgentPageEvent, BrowserAutomationRun } from "../preload/types"
import { redactText } from "./security-redaction"

type BrowserAgentLog = { level: string; message: string; location?: string }
type BrowserAgentActionLog = { label: string; ok: boolean; error?: string; result?: unknown; at: string }
type BrowserAgentNetworkError = { url: string; status?: number; error?: string; method?: string }
type BrowserAgentDom = NonNullable<BrowserAutomationRun["domSummary"]>
type BrowserAgentComputedStyle = NonNullable<BrowserAutomationRun["computedStyles"]>[number]
type BrowserAgentBounds = { x: number; y: number; width: number; height: number }
type BrowserContext = {
  id: string
  view?: WebContentsView
  hostWindow?: BrowserWindow
  lastBounds?: BrowserAgentBounds
  consoleLogs: BrowserAgentLog[]
  pageErrors: string[]
  networkErrors: BrowserAgentNetworkError[]
  actionTimeline: BrowserAgentActionLog[]
  currentPageTitle: string
  lastUsedAt: number
  allowedExternalOrigins: Set<string>
  blockedNavigationError?: string
}

// The agent drives a WebContentsView embedded in the main Vector window, so
// the user always watches the same live page the agent is acting on and can
// take over with normal mouse/keyboard input at any time.
let attaching: Promise<void> | undefined
const contexts = new Map<string, BrowserContext>()
const contextStorage = new AsyncLocalStorage<BrowserContext>()
const MAX_BROWSER_CONTEXTS = 17

function currentContext() {
  const context = contextStorage.getStore()
  if (!context) throw new Error("The controlled browser has no active Vector task context.")
  context.lastUsedAt = Date.now()
  return context
}

function getContext(id: string, create = true) {
  const existing = contexts.get(id)
  if (existing || !create) return existing
  pruneContexts()
  const context: BrowserContext = {
    id,
    consoleLogs: [],
    pageErrors: [],
    networkErrors: [],
    actionTimeline: [],
    currentPageTitle: "",
    lastUsedAt: Date.now(),
    allowedExternalOrigins: new Set(),
  }
  contexts.set(id, context)
  return context
}

function pruneContexts() {
  if (contexts.size < MAX_BROWSER_CONTEXTS) return
  const oldest = Array.from(contexts.values())
    .filter((context) => !context.view || context.view.webContents.isDestroyed())
    .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
  if (!oldest) throw new Error(`Vector already has ${MAX_BROWSER_CONTEXTS} active browser tasks.`)
  destroyContext(oldest)
}

function now() {
  return new Date().toISOString()
}

function pushAction(label: string, ok = true, error?: unknown, result?: unknown, context = currentContext()) {
  context.actionTimeline = [
    {
      label,
      ok,
      error: error instanceof Error ? redactText(error.message) : error ? redactText(String(error)) : undefined,
      result,
      at: now(),
    },
    ...context.actionTimeline,
  ].slice(0, 80)
}

export { isLocalBrowserUrl } from "./browser-navigation-policy"

function safeUrl(rawUrl: string, allowExternal = false) {
  const url = new URL(rawUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser Agent can only open http and https URLs.")
  }
  if (!isLocalBrowserUrl(rawUrl) && !allowExternal) {
    throw new Error("Browser Agent blocked this external website. Enable external sites for this conversation first.")
  }
  return url.toString()
}

const PAGE_ISSUE_HOOK = `(() => {
  if (window.__vectorAgentIssueHook) return true;
  window.__vectorAgentIssueHook = true;
  window.__vectorAgentIssues = [];
  const push = (message) => {
    try {
      window.__vectorAgentIssues.push(String(message).slice(0, 500));
      window.__vectorAgentIssues = window.__vectorAgentIssues.slice(-40);
    } catch {}
  };
  window.addEventListener("error", (event) => push(event.message || event.error || "Unknown page error"));
  window.addEventListener("unhandledrejection", (event) => push("Unhandled rejection: " + (event.reason?.message || event.reason)));
  return true;
})()`

function emitPageEvent(context = currentContext()) {
  const contents = context.view?.webContents
  if (!contents || contents.isDestroyed() || !context.hostWindow || context.hostWindow.isDestroyed()) return
  const payload: BrowserAgentPageEvent = {
    contextId: context.id,
    url: contents.getURL(),
    title: contents.getTitle(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    loading: contents.isLoading(),
  }
  context.hostWindow.webContents.send("browser-agent-page-event", payload)
}

function wireView(context: BrowserContext, contents: WebContents) {
  const blockNavigation = (url: string) => {
    const message =
      "Browser Agent blocked a redirect to an external origin that was not approved. Open that URL explicitly to continue."
    context.blockedNavigationError = message
    context.networkErrors.push({ url: redactText(url), error: message })
    context.networkErrors = context.networkErrors.slice(-50)
    pushAction("Blocked unapproved external navigation", false, message, undefined, context)
  }
  contents.setWindowOpenHandler(({ url }) => {
    // Keep the agent's world on one surface: popups navigate in place.
    if (isAllowedBrowserNavigation(url, context.allowedExternalOrigins)) void contents.loadURL(url)
    else blockNavigation(url)
    return { action: "deny" }
  })
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (isAllowedBrowserNavigation(url, context.allowedExternalOrigins)) return
    event.preventDefault()
    blockNavigation(url)
  }
  contents.on("will-navigate", guardNavigation)
  contents.on("will-redirect", guardNavigation)
  contents.on("did-navigate", () => {
    context.consoleLogs = []
    context.pageErrors = []
    context.networkErrors = []
    context.currentPageTitle = contents.getTitle()
    emitPageEvent(context)
  })
  contents.on("did-navigate-in-page", () => emitPageEvent(context))
  contents.on("did-start-loading", () => emitPageEvent(context))
  contents.on("did-stop-loading", () => emitPageEvent(context))
  contents.on("page-title-updated", (_event, title) => {
    context.currentPageTitle = title
    emitPageEvent(context)
  })
  contents.on("dom-ready", () => {
    void contents.executeJavaScript(PAGE_ISSUE_HOOK, true).catch(() => undefined)
  })
  contents.on("console-message", (event) => {
    const labels: Record<string, string> = { info: "info", warning: "warn", error: "error", debug: "debug" }
    context.consoleLogs.push({
      level: labels[event.level] ?? "log",
      message: redactText(event.message),
      location: event.sourceId ? redactText(`${event.sourceId}:${event.lineNumber}`) : undefined,
    })
    context.consoleLogs = context.consoleLogs.slice(-80)
  })
  contents.on("render-process-gone", (_event, details) => {
    context.pageErrors.push(`Renderer stopped: ${details.reason}`)
    context.pageErrors = context.pageErrors.slice(-40)
  })
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return
    context.networkErrors.push({
      url: redactText(validatedURL),
      status: errorCode,
      error: redactText(errorDescription),
    })
    context.networkErrors = context.networkErrors.slice(-50)
  })
}

async function drainInjectedIssues() {
  const context = currentContext()
  const contents = context.view?.webContents
  if (!contents || contents.isDestroyed()) return
  try {
    const drained = (await contents.executeJavaScript(
      `(() => { const items = window.__vectorAgentIssues || []; window.__vectorAgentIssues = []; return items; })()`,
      true,
    )) as unknown
    if (Array.isArray(drained) && drained.length) {
      context.pageErrors = [...context.pageErrors, ...drained.map((item) => String(item))].slice(-40)
    }
  } catch {
    // Page navigated mid-read; the hook reinstalls on the next dom-ready.
  }
}

function scaledBounds(sender: WebContents, bounds: { x: number; y: number; width: number; height: number }) {
  // The renderer measures its pane in CSS pixels; the view is positioned in
  // window DIP coordinates, so account for the app zoom factor.
  const zoom = sender.getZoomFactor()
  return {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.max(0, Math.round(bounds.width * zoom)),
    height: Math.max(0, Math.round(bounds.height * zoom)),
  }
}

async function attachView(event: IpcMainInvokeEvent, bounds?: { x: number; y: number; width: number; height: number }) {
  if (attaching) await attaching
  attaching = (async () => {
    const context = currentContext()
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Browser Agent could not find the requesting window.")
    const active = ensureBrowserView()
    for (const item of contexts.values()) {
      if (item.id !== context.id && item.hostWindow === win && item.view) item.view.setVisible(false)
    }
    if (context.hostWindow !== win) {
      if (context.hostWindow && !context.hostWindow.isDestroyed())
        context.hostWindow.contentView.removeChildView(active)
      win.contentView.addChildView(active)
      win.once("closed", () => {
        if (context.hostWindow !== win) return
        destroyContext(context)
      })
      context.hostWindow = win
    }
    if (bounds) {
      context.lastBounds = scaledBounds(event.sender, bounds)
      active.setBounds(context.lastBounds)
    }
    active.setVisible(true)
  })()
  try {
    await attaching
  } finally {
    attaching = undefined
  }
}

function ensureBrowserView() {
  const context = currentContext()
  if (context.view && !context.view.webContents.isDestroyed()) return context.view
  context.view = new WebContentsView({
    webPreferences: {
      session: session.fromPartition("persist:vector-browser"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  context.view.setBackgroundColor("#18181a")
  wireView(context, context.view.webContents)
  pushAction("Controlled browser launched")
  return context.view
}

function detachView() {
  // Hide but keep the page alive so reopening the workspace resumes where the
  // agent (or the user) left off. closeBrowser destroys it for real.
  const context = currentContext()
  if (context.view && context.hostWindow && !context.hostWindow.isDestroyed()) context.view.setVisible(false)
}

async function closeBrowser() {
  destroyContext(currentContext())
}

function destroyContext(context: BrowserContext) {
  const active = context.view
  context.view = undefined
  if (active) {
    if (context.hostWindow && !context.hostWindow.isDestroyed()) context.hostWindow.contentView.removeChildView(active)
    if (!active.webContents.isDestroyed()) active.webContents.close()
  }
  context.hostWindow = undefined
  context.lastBounds = undefined
  context.consoleLogs = []
  context.pageErrors = []
  context.networkErrors = []
  context.currentPageTitle = ""
  context.allowedExternalOrigins.clear()
  context.blockedNavigationError = undefined
  context.actionTimeline = [
    {
      label: "Browser stopped",
      ok: true,
      at: now(),
    },
  ]
  contexts.delete(context.id)
}

function ensureView() {
  const view = currentContext().view
  if (!view || view.webContents.isDestroyed()) {
    throw new Error("The controlled browser is unavailable for this task.")
  }
  return view.webContents
}

async function runScript<T>(script: string): Promise<T> {
  const contents = ensureView()
  return (await contents.executeJavaScript(script, true)) as T
}

export async function openUrl(url: string, allowExternal = false) {
  const context = currentContext()
  const target = safeUrl(url, allowExternal)
  const origin = browserOrigin(target)
  if (origin && !isLocalBrowserUrl(target) && allowExternal) context.allowedExternalOrigins.add(origin)
  const contents = ensureView()
  try {
    await contents.loadURL(target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // ERR_ABORTED means a superseding navigation interrupted this one (e.g. a
    // redirect committed first) — the page is fine, so it is not a failure.
    if (!/ERR_ABORTED/i.test(message)) {
      const friendly = `Could not open ${target}: ${message}`
      context.networkErrors.push({ url: redactText(target), error: redactText(friendly) })
      context.networkErrors = context.networkErrors.slice(-50)
      throw new Error(friendly, { cause: error })
    }
  }
  context.currentPageTitle = contents.getTitle()
  pushAction(`Opened ${target}`)
}

export async function click(selector: string) {
  await runScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("No element matches selector: " + ${JSON.stringify(selector)});
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  })()`)
  pushAction(`Clicked ${selector}`)
}

/**
 * Executor-level guard (defense in depth beyond the planner prompt): typing
 * into credential fields is always refused so the run hands control to the user
 * via wait_for_user instead of ever filling passwords, OTPs, or cards.
 *
 * This is serialized into the page with toString(), so the body has to stay
 * self-contained: anything it read from module scope would be a ReferenceError
 * inside the renderer.
 */
export { isCredentialField } from "./browser-credential-field"

// Every injected script that is about to put characters somewhere opens with
// this so all of them decide with the same predicate rather than each carrying
// its own copy of the rule.
const CREDENTIAL_GUARD = `
    const isCredentialField = ${isCredentialField.toString()};
    const describeField = (el) => ({
      type: el.getAttribute("type"),
      autocomplete: el.getAttribute("autocomplete"),
      name: el.getAttribute("name"),
      id: el.getAttribute("id"),
      textSecurity: getComputedStyle(el).getPropertyValue("-webkit-text-security"),
    });`

// Keystrokes land on whatever holds focus, not on the selector a caller named,
// so the paths that type blind (press, and type's phase 2) ask about focus.
const FOCUSED_CREDENTIAL_CHECK = `(() => {${CREDENTIAL_GUARD}
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    return isCredentialField(describeField(el));
  })()`

// Keys that navigate, submit, or edit without inserting a character. Anything
// absent from this list counts as typing, so an unfamiliar key code fails closed
// into the guard rather than around it.
const NON_TYPING_KEYS = new Set([
  "tab",
  "enter",
  "return",
  "escape",
  "esc",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "shift",
  "control",
  "ctrl",
  "alt",
  "option",
  "meta",
  "command",
  "cmd",
  "super",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
  "pause",
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
])

function credentialRefusal(target: string) {
  return `Refused to send keystrokes to ${target}: it is a credential field (password, one-time code, or card number). Vector never fills credentials — emit the wait_for_user action so the user can complete this step in the live browser.`
}

export async function type(selector: string, text: string, clear = true) {
  const contents = ensureView()
  // Phase 1 (in-page): locate, guard, focus, and set the selection so that
  // trusted keystrokes replace (clear) or append to the existing value.
  const prep = await runScript<{ missing?: boolean; guarded?: boolean; before?: string }>(`(() => {${CREDENTIAL_GUARD}
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    if (isCredentialField(describeField(el))) return { guarded: true };
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    if ("value" in el) {
      const before = String(el.value ?? "");
      try {
        if (${JSON.stringify(clear)}) el.select?.();
        else el.setSelectionRange?.(before.length, before.length);
      } catch {}
      return { before };
    }
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!${JSON.stringify(clear)}) range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {}
    return { before: String(el.textContent ?? "") };
  })()`)
  if (prep.missing) throw new Error(`No element matches selector: ${selector}`)
  if (prep.guarded) throw new Error(credentialRefusal(selector))
  const expected = clear ? text : `${prep.before ?? ""}${text}`

  // Phase 2: real key events through sendInputEvent, char by char, so
  // React/Vue/Svelte controlled inputs see native keystrokes and update state.
  if (text.length > 0) {
    contents.focus()
    try {
      await sendGuardedCharacters(
        text,
        () => runScript<boolean>(FOCUSED_CREDENTIAL_CHECK),
        (event) => contents.sendInputEvent(event),
      )
    } catch (error) {
      if (error instanceof CredentialFocusChangedError) throw new Error(credentialRefusal("the focused field"))
      // Characters that are not valid key codes (emoji, some symbols) fall
      // through; the verification pass below repairs the value natively.
    }
    // Let the queued input events flush and the framework re-render.
    await new Promise((resolve) => setTimeout(resolve, 80))
  }

  // Phase 3: verify what actually landed. If trusted typing missed (element in
  // an unfocused subtree, exotic characters, empty text with clear), fall back
  // to the native value setter + InputEvent so frameworks still notice.
  const check = await runScript<{ missing?: boolean; value?: string }>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    return { value: "value" in el ? String(el.value ?? "") : String(el.textContent ?? "") };
  })()`)
  if (!check.missing && check.value === expected) {
    pushAction(`Typed into ${selector}`)
    return
  }
  // The element behind the selector can have been swapped or re-typed while
  // phase 2 ran, so the fallback that writes the whole value at once re-checks
  // rather than trusting phase 1's verdict.
  const applied = await runScript<{ missing?: boolean; guarded?: boolean }>(`(() => {${CREDENTIAL_GUARD}
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    if (isCredentialField(describeField(el))) return { guarded: true };
    el.focus();
    if (isCredentialField(describeField(el))) return { guarded: true };
    const value = ${JSON.stringify(expected)};
    const data = ${JSON.stringify(text)};
    if ("value" in el) {
      let proto = Object.getPrototypeOf(el);
      let setter;
      while (proto && !setter) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        setter = descriptor && descriptor.set;
        proto = Object.getPrototypeOf(proto);
      }
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data }));
    }
    return { ok: true };
  })()`)
  if (applied.guarded) throw new Error(credentialRefusal(selector))
  pushAction(`Typed into ${selector} (native setter fallback)`)
}

export async function press(key: string) {
  const contents = ensureView()
  // press() reaches the page through the same trusted key pipeline as type(),
  // so without this a caller spells a password out one single-character press
  // at a time and walks straight around type()'s guard.
  const typesCharacter = !NON_TYPING_KEYS.has(key.toLowerCase())
  if (typesCharacter && (await runScript<boolean>(FOCUSED_CREDENTIAL_CHECK))) {
    throw new Error(credentialRefusal("the focused field"))
  }
  try {
    // Electron's documented pattern: keyDown + char + keyUp. The char event is
    // what makes Enter actually submit forms and reach framework key handlers.
    contents.focus()
    contents.sendInputEvent({ type: "keyDown", keyCode: key })
    if (typesCharacter && (await runScript<boolean>(FOCUSED_CREDENTIAL_CHECK))) {
      throw new CredentialFocusChangedError()
    }
    if (key.length === 1 || key === "Enter" || key === "Return" || key === "Tab" || key === "Space") {
      contents.sendInputEvent({ type: "char", keyCode: key })
    }
    if (typesCharacter && (await runScript<boolean>(FOCUSED_CREDENTIAL_CHECK))) {
      throw new CredentialFocusChangedError()
    }
    contents.sendInputEvent({ type: "keyUp", keyCode: key })
    pushAction(`Pressed ${key}`)
  } catch (error) {
    if (error instanceof CredentialFocusChangedError) throw new Error(credentialRefusal("the focused field"))
    // JS fallback for keys sendInputEvent rejects: synthetic key events on the
    // focused element, plus explicit form submission for Enter.
    const fallback = await runScript<{ guarded?: boolean }>(`(() => {${CREDENTIAL_GUARD}
      const key = ${JSON.stringify(key)};
      const typesCharacter = ${JSON.stringify(typesCharacter)};
      const active = () => document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      const guarded = () => typesCharacter && isCredentialField(describeField(active()));
      if (guarded()) return { guarded: true };
      const el = active();
      const init = { key, code: key.length === 1 ? undefined : key, bubbles: true, cancelable: true };
      const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
      if (guarded()) return { guarded: true };
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      if (guarded()) return { guarded: true };
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      if (key === "Enter" && proceed) {
        const form = el.form || (el.closest ? el.closest("form") : null);
        if (form) {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        }
      }
      return { guarded: false };
    })()`)
    if (fallback.guarded) throw new Error(credentialRefusal("the focused field"))
    pushAction(`Pressed ${key} (synthetic fallback)`)
  }
}

export async function wait(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(milliseconds, 15_000))))
  pushAction(`Waited ${milliseconds}ms`)
}

export async function waitForSelector(selector: string) {
  await runScript(`new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    if (document.querySelector(selector)) return resolve(true);
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for selector: " + selector));
    }, 10000);
  })`)
  pushAction(`Waited for ${selector}`)
}

export async function waitForText(text: string) {
  await runScript(`new Promise((resolve, reject) => {
    const text = ${JSON.stringify(text)};
    const hasText = () => (document.body?.innerText || "").includes(text);
    if (hasText()) return resolve(true);
    const observer = new MutationObserver(() => {
      if (hasText()) {
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for text: " + text));
    }, 10000);
  })`)
  pushAction(`Waited for text "${text}"`)
}

export async function takeScreenshot() {
  const contents = ensureView()
  const image = await contents.capturePage()
  pushAction("Screenshot captured")
  return image.toDataURL()
}

export async function reload() {
  ensureView().reload()
  pushAction("Reloaded page")
}

export async function goBack() {
  const contents = ensureView()
  if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  pushAction("Went back")
}

export async function goForward() {
  const contents = ensureView()
  if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  pushAction("Went forward")
}

export async function scroll(deltaY = 680) {
  const amount = Math.max(-2400, Math.min(deltaY, 2400))
  await runScript(`window.scrollBy({ top: ${amount}, left: 0, behavior: "smooth" }); true`)
  pushAction(`Scrolled ${amount > 0 ? "down" : "up"} ${Math.abs(amount)}px`)
}

export function currentUrl() {
  const contents = currentContext().view?.webContents
  if (!contents || contents.isDestroyed()) return ""
  return contents.getURL()
}

export function clearLogs() {
  const context = currentContext()
  context.consoleLogs = []
  context.pageErrors = []
  context.networkErrors = []
  context.actionTimeline = []
  pushAction("Logs cleared")
}

const DOM_INSPECT_SCRIPT = `(() => {
  const selectorFor = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const test = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("aria-label") || el.getAttribute("name");
    if (test) return el.tagName.toLowerCase() + "[" + (el.getAttribute("data-testid") ? "data-testid" : el.getAttribute("data-test") ? "data-test" : el.getAttribute("aria-label") ? "aria-label" : "name") + "=" + JSON.stringify(test) + "]";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const pick = (el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 90),
    selector: selectorFor(el),
    role: el.getAttribute("role") || undefined,
    type: el.getAttribute("type") || undefined,
  });
  const pickInput = (el) => ({
    tag: el.tagName.toLowerCase(),
    selector: selectorFor(el),
    placeholder: el.getAttribute("placeholder") || undefined,
    type: el.getAttribute("type") || undefined,
    name: el.getAttribute("name") || undefined,
  });
  return {
    title: document.title || "",
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    textSample: (document.body?.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 1200),
    links: document.querySelectorAll("a").length,
    scripts: document.querySelectorAll("script").length,
    stylesheets: document.querySelectorAll('link[rel~="stylesheet"], style').length,
    htmlBytes: new Blob([document.documentElement.outerHTML]).size,
    interactives: Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')).slice(0, 40).map(pick),
    inputs: Array.from(document.querySelectorAll("input, textarea, select, [contenteditable=true]")).slice(0, 40).map(pickInput),
  };
})()`

async function inspectDom(): Promise<BrowserAgentDom> {
  const dom = await runScript<BrowserAgentDom>(DOM_INSPECT_SCRIPT)
  currentContext().currentPageTitle = dom.title
  return dom
}

const COMPUTED_STYLES_SCRIPT = `(() => {
  const selectorFor = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  return Array.from(
    document.querySelectorAll("main, header, nav, section, article, form, h1, h2, h3, button, a, input, textarea, select, [role]")
  )
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    })
    .slice(0, 35)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        selector: selectorFor(el),
        text: (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 90),
        display: style.display,
        visibility: style.visibility,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
})()`

export async function runBrowserAgent(
  event: IpcMainInvokeEvent | undefined,
  input: BrowserAgentInput,
): Promise<BrowserAutomationRun> {
  const contextId = input.contextId.trim()
  if (!contextId) throw new Error("The controlled browser needs an active Vector task context.")
  const passive =
    input.command === "detach" ||
    input.command === "setBounds" ||
    input.command === "closeBrowser" ||
    input.command === "setVisible"
  const context = getContext(contextId, !passive)
  if (!context) return stoppedReport()
  return contextStorage.run(context, () => runBrowserAgentInContext(event, input))
}

async function runBrowserAgentInContext(
  event: IpcMainInvokeEvent | undefined,
  input: BrowserAgentInput,
): Promise<BrowserAutomationRun> {
  const checkedAt = now()
  let commandOk = true
  let commandError: string | undefined
  let screenshotDataUrl = ""
  let computedStyles: BrowserAgentComputedStyle[] | undefined
  let pageHtml: string | undefined

  try {
    if (input.command === "setVisible") {
      const context = currentContext()
      if (
        context.view &&
        !context.view.webContents.isDestroyed() &&
        context.hostWindow &&
        !context.hostWindow.isDestroyed()
      ) {
        context.view.setVisible(input.visible !== false)
      }
      return stoppedReport()
    }
    const passiveCommand =
      input.command === "detach" || input.command === "setBounds" || input.command === "closeBrowser"
    if (!passiveCommand) ensureBrowserView()
    switch (input.command) {
      case "attach":
        if (!event) throw new Error("Only Vector's visible browser panel can attach the browser view.")
        await attachView(event, input.bounds)
        break
      case "setBounds":
        if (!event) throw new Error("Browser bounds can only be changed by the visible Browser panel.")
        {
          const context = currentContext()
          if (input.bounds && context.view && context.hostWindow && !context.hostWindow.isDestroyed()) {
            context.lastBounds = scaledBounds(event.sender, input.bounds)
            context.view.setBounds(context.lastBounds)
          }
        }
        break
      case "detach":
        detachView()
        break
      case "closeBrowser":
        await closeBrowser()
        break
      case "openUrl":
        if (!input.url) throw new Error("The controlled browser needs a URL to open.")
        await openUrl(input.url, input.allowExternal)
        break
      case "click":
        if (!input.selector) throw new Error("The controlled browser needs a selector to click.")
        await click(input.selector)
        break
      case "type":
        if (!input.selector) throw new Error("The controlled browser needs a selector to type into.")
        await type(input.selector, input.text ?? "")
        break
      case "press":
        if (!input.key) throw new Error("The controlled browser needs a key to press.")
        await press(input.key)
        break
      case "wait":
        await wait(input.milliseconds ?? 500)
        break
      case "waitForSelector":
        if (!input.selector) throw new Error("Browser Agent needs a selector to wait for.")
        await waitForSelector(input.selector)
        break
      case "waitForText":
        if (!input.text) throw new Error("Browser Agent needs text to wait for.")
        await waitForText(input.text)
        break
      case "takeScreenshot":
        screenshotDataUrl = await takeScreenshot()
        break
      case "inspectComputedStyles":
        computedStyles = await runScript<BrowserAgentComputedStyle[]>(COMPUTED_STYLES_SCRIPT)
        pushAction("Read computed styles", true, undefined, `${computedStyles.length} visible elements`)
        break
      case "inspectPageHtml":
        pageHtml = String(await runScript<string>("document.documentElement.outerHTML")).slice(0, 120_000)
        pushAction("Read page HTML", true, undefined, `${pageHtml.length} characters`)
        break
      case "reload":
        await reload()
        break
      case "goBack":
        await goBack()
        break
      case "goForward":
        await goForward()
        break
      case "scroll":
        await scroll(input.deltaY)
        break
      case "clearLogs":
        clearLogs()
        break
      case "inspectDom":
      default:
        break
    }
  } catch (error) {
    commandOk = false
    commandError = error instanceof Error ? error.message : String(error)
    pushAction(input.command ?? "Browser Agent command", false, error)
  }

  const context = currentContext()
  if (context.blockedNavigationError) {
    if (commandOk) {
      commandOk = false
      commandError = context.blockedNavigationError
    }
    context.blockedNavigationError = undefined
  }
  const contents = context.view?.webContents
  const alive = Boolean(contents && !contents.isDestroyed())
  let dom: BrowserAgentDom = {
    title: context.currentPageTitle,
    description: "",
    textSample: "",
    links: 0,
    scripts: 0,
    stylesheets: 0,
    htmlBytes: 0,
    interactives: [],
    inputs: [],
  }
  if (alive && contents!.getURL()) {
    await drainInjectedIssues()
    try {
      dom = await inspectDom()
    } catch {
      // Mid-navigation inspection can fail; the next command retries.
    }
  }

  const url = currentUrl() || input.url || ""
  return {
    url,
    finalUrl: url,
    status: commandOk ? 200 : 500,
    ok: commandOk,
    error: commandError,
    title: dom.title,
    description: dom.description,
    htmlBytes: dom.htmlBytes,
    links: dom.links,
    scripts: dom.scripts,
    stylesheets: dom.stylesheets,
    checkedAt,
    viewport: context.lastBounds ?? { x: 0, y: 0, width: 0, height: 0 },
    screenshotDataUrl,
    console: context.consoleLogs.slice(-30),
    pageErrors: context.pageErrors.slice(-30),
    networkErrors: context.networkErrors.slice(-30),
    domSummary: dom,
    computedStyles,
    pageHtml,
    diagnostics: {
      consoleCount: context.consoleLogs.length,
      runtimeErrorCount: context.pageErrors.length,
      networkErrorCount: context.networkErrors.length,
      interactiveCount: dom.interactives.length,
      inputCount: dom.inputs.length,
      htmlBytes: dom.htmlBytes,
    },
    actions: context.actionTimeline.slice(0, 40),
    interactives: dom.interactives,
    inputs: dom.inputs,
    browserStatus: alive ? "running" : "stopped",
    currentPage: dom.title || url || "No page open",
  }
}

function stoppedReport(): BrowserAutomationRun {
  return {
    url: "",
    finalUrl: "",
    status: 200,
    ok: true,
    title: "",
    description: "",
    htmlBytes: 0,
    links: 0,
    scripts: 0,
    stylesheets: 0,
    checkedAt: now(),
    viewport: { x: 0, y: 0, width: 0, height: 0 },
    screenshotDataUrl: "",
    console: [],
    pageErrors: [],
    networkErrors: [],
    actions: [],
    interactives: [],
    inputs: [],
    browserStatus: "stopped",
    currentPage: "No page open",
  }
}
