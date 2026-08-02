import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { app, BrowserWindow } from "electron"

export type CloudBrowserCheckResult = {
  ok: boolean
  details: string
  output: string
  durationMs: number
  screenshotPath?: string
}

export async function runCloudBrowserCheck(url: string, deploymentId: string): Promise<CloudBrowserCheckResult> {
  const startedAt = Date.now()
  const errors: string[] = []
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `vector-cloud-check-${deploymentId}`,
    },
  })

  window.webContents.on("console-message", (details, level, message, line, source) => {
    const resolvedLevel = typeof details.level === "string" ? details.level : level >= 2 ? "error" : "info"
    const resolvedMessage = typeof details.message === "string" ? details.message : message
    const resolvedSource = typeof details.sourceId === "string" ? details.sourceId : source
    const resolvedLine = typeof details.lineNumber === "number" ? details.lineNumber : line
    if (resolvedLevel !== "error") return
    errors.push(`${resolvedMessage}${resolvedSource ? ` (${resolvedSource}:${resolvedLine})` : ""}`)
  })
  window.webContents.on("render-process-gone", (_event, details) => {
    errors.push(`Renderer exited: ${details.reason}`)
  })

  let timeout: ReturnType<typeof setTimeout> | undefined
  const loadError = await Promise.race([
    window.loadURL(url).then(() => undefined).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    ),
    new Promise<string>((resolve) => {
      timeout = setTimeout(() => {
        window.webContents.stop()
        resolve("Browser smoke test timed out after 30 seconds.")
      }, 30_000)
    }),
  ])
  clearTimeout(timeout)
  if (loadError) errors.push(loadError)

  const page = loadError
    ? undefined
    : await window.webContents
        .executeJavaScript(`(() => ({
          title: document.title,
          text: (document.body?.innerText || "").trim().slice(0, 500),
          htmlLength: document.documentElement?.outerHTML.length || 0
        }))()`)
        .then((value: unknown) => value)
        .catch((error: unknown) => {
          errors.push(error instanceof Error ? error.message : String(error))
          return undefined
        })

  const screenshotDirectory = join(app.getPath("userData"), "cloud-checks")
  await mkdir(screenshotDirectory, { recursive: true })
  const screenshotPath = join(screenshotDirectory, `${deploymentId}.png`)
  const screenshot = loadError
    ? undefined
    : await window.webContents.capturePage().catch(() => undefined)
  if (screenshot) await writeFile(screenshotPath, screenshot.toPNG()).catch(() => undefined)

  const title = page && typeof page === "object" && typeof Reflect.get(page, "title") === "string"
    ? Reflect.get(page, "title")
    : ""
  const text = page && typeof page === "object" && typeof Reflect.get(page, "text") === "string"
    ? Reflect.get(page, "text")
    : ""
  const htmlLength = page && typeof page === "object" && typeof Reflect.get(page, "htmlLength") === "number"
    ? Reflect.get(page, "htmlLength")
    : 0
  const blank = !loadError && htmlLength < 40 && !text
  if (blank) errors.push("The deployed page rendered no meaningful HTML or text.")

  if (!window.isDestroyed()) window.destroy()

  return {
    ok: errors.length === 0,
    details: errors.length
      ? `${errors.length} browser issue${errors.length === 1 ? "" : "s"} detected.`
      : `Rendered ${title || "the page"} successfully with ${htmlLength.toLocaleString()} HTML characters.`,
    output: errors.join("\n"),
    durationMs: Date.now() - startedAt,
    screenshotPath: screenshot ? screenshotPath : undefined,
  }
}
