import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"

import type {
  BrowserAutomationAction,
  BrowserAutomationReport,
  BrowserAutomationRun,
  FatalRendererError,
  ServerReadyData,
  TitlebarTheme,
} from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { getPinchZoomEnabled, getWindowID, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

function textBetween(source: string, regex: RegExp) {
  const match = source.match(regex)
  return match?.[1]?.replace(/\s+/g, " ").trim() ?? ""
}

async function inspectBrowserUrl(rawUrl: string): Promise<BrowserAutomationReport> {
  const url = new URL(rawUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser automation can only inspect http and https URLs.")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  const checkedAt = new Date().toISOString()

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Vector Browser Automation/1.0",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    })
    const html = await response.text()
    return {
      url: rawUrl,
      finalUrl: response.url,
      status: response.status,
      ok: response.ok,
      title: textBetween(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
      description:
        textBetween(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i) ||
        textBetween(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i),
      htmlBytes: Buffer.byteLength(html),
      links: html.match(/<a\b/gi)?.length ?? 0,
      scripts: html.match(/<script\b/gi)?.length ?? 0,
      stylesheets: html.match(/<link\b[^>]*rel=["']?stylesheet/gi)?.length ?? 0,
      checkedAt,
    }
  } catch (error) {
    return {
      url: rawUrl,
      finalUrl: rawUrl,
      status: 0,
      ok: false,
      title: "",
      description: "",
      htmlBytes: 0,
      links: 0,
      scripts: 0,
      stylesheets: 0,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function validateBrowserUrl(rawUrl: string) {
  const url = new URL(rawUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser automation can only open http and https URLs.")
  }
  return url.toString()
}

async function runBrowserAutomation(input: {
  url: string
  actions?: BrowserAutomationAction[]
  viewport?: { width: number; height: number }
}): Promise<BrowserAutomationRun> {
  const targetUrl = validateBrowserUrl(input.url)
  const viewport = {
    width: Math.max(360, Math.min(input.viewport?.width ?? 1366, 2400)),
    height: Math.max(360, Math.min(input.viewport?.height ?? 900, 1800)),
  }
  const checkedAt = new Date().toISOString()
  const consoleMessages: BrowserAutomationRun["console"] = []
  const pageErrors: string[] = []
  const actionResults: BrowserAutomationRun["actions"] = []

  const win = new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: true,
      images: true,
      webSecurity: false,
    },
  })

  const cleanup = () => {
    if (!win.isDestroyed()) win.destroy()
  }

  win.webContents.on("console-message", (_event, level, message) => {
    const labels = ["log", "warn", "error", "info", "debug"]
    consoleMessages.push({ level: labels[level] ?? String(level), message })
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    pageErrors.push(`Renderer stopped: ${details.reason}`)
  })
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode !== -3) pageErrors.push(`${validatedURL}: ${errorDescription}`)
  })

  try {
    await win.loadURL(targetUrl)
    await win.webContents.executeJavaScript(
      "new Promise((resolve) => { if (document.readyState === 'complete') resolve(true); else window.addEventListener('load', () => resolve(true), { once: true }); setTimeout(() => resolve(false), 3500); })",
      true,
    )

    for (const action of input.actions ?? []) {
      try {
        if (action.type === "click") {
          const result = await win.webContents.executeJavaScript(
            `(() => {
              const el = document.querySelector(${JSON.stringify(action.selector)});
              if (!el) throw new Error("No element matches selector: ${action.selector.replace(/"/g, '\\"')}");
              el.scrollIntoView({ block: "center", inline: "center" });
              el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
              el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
              el.click();
              return true;
            })()`,
            true,
          )
          actionResults.push({ label: `Click ${action.selector}`, ok: true, result })
        }
        if (action.type === "type") {
          const result = await win.webContents.executeJavaScript(
            `(() => {
              const el = document.querySelector(${JSON.stringify(action.selector)});
              if (!el) throw new Error("No element matches selector: ${action.selector.replace(/"/g, '\\"')}");
              el.scrollIntoView({ block: "center", inline: "center" });
              el.focus();
              const text = ${JSON.stringify(action.text)};
              if ("value" in el) {
                if (${action.clear ? "true" : "false"}) el.value = "";
                el.value = String(el.value || "") + text;
                el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              } else {
                el.textContent = (${action.clear ? "true" : "false"} ? "" : el.textContent || "") + text;
                el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
              }
              return true;
            })()`,
            true,
          )
          actionResults.push({ label: `Type into ${action.selector}`, ok: true, result })
        }
        if (action.type === "press") {
          await win.webContents.sendInputEvent({ type: "keyDown", keyCode: action.key })
          await win.webContents.sendInputEvent({ type: "keyUp", keyCode: action.key })
          actionResults.push({ label: `Press ${action.key}`, ok: true })
        }
        if (action.type === "evaluate") {
          const result = await win.webContents.executeJavaScript(action.script, true)
          actionResults.push({ label: "Evaluate JavaScript", ok: true, result })
        }
        await new Promise((resolve) => setTimeout(resolve, 350))
      } catch (error) {
        actionResults.push({
          label:
            action.type === "evaluate"
              ? "Evaluate JavaScript"
              : `${action.type} ${"selector" in action ? action.selector : "key" in action ? action.key : ""}`.trim(),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const dom = await win.webContents.executeJavaScript(
      `(() => {
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
      })()`,
      true,
    )

    const image = await win.webContents.capturePage()
    return {
      url: targetUrl,
      finalUrl: win.webContents.getURL(),
      status: pageErrors.length ? 0 : 200,
      ok: pageErrors.length === 0,
      title: dom.title,
      description: dom.description,
      htmlBytes: dom.htmlBytes,
      links: dom.links,
      scripts: dom.scripts,
      stylesheets: dom.stylesheets,
      checkedAt,
      viewport,
      screenshotDataUrl: image.toDataURL(),
      textSample: dom.textSample,
      console: consoleMessages.slice(-30),
      pageErrors,
      actions: actionResults,
      interactives: dom.interactives,
      inputs: dom.inputs,
    }
  } catch (error) {
    return {
      url: targetUrl,
      finalUrl: targetUrl,
      status: 0,
      ok: false,
      title: "",
      description: "",
      htmlBytes: 0,
      links: 0,
      scripts: 0,
      stylesheets: 0,
      checkedAt,
      viewport,
      screenshotDataUrl: "",
      textSample: "",
      console: consoleMessages.slice(-30),
      pageErrors,
      actions: actionResults,
      interactives: [],
      inputs: [],
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    cleanup()
  }
}

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
}

export function registerIpcHandlers(deps: Deps) {
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("browser-automation-inspect", (_event: IpcMainInvokeEvent, url: string) => inspectBrowserUrl(url))
  ipcMain.handle(
    "browser-automation-run",
    (_event: IpcMainInvokeEvent, input: { url: string; actions?: BrowserAutomationAction[] }) =>
      runBrowserAutomation(input),
  )
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
