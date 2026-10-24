import "@vectordevai/core/local-mode/backstop"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { app, BrowserWindow, net, session, webContents } from "electron"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { AGENT_BROWSER_PREFERENCES } from "../src/main/browser-agent"
import { duringUpdateCheck, installChromiumLocal, startDesktopLocal } from "../src/main/local-mode"

const input: {
  root: string
  output: string
  duration: number
  base: string
  engineURL: string
  repository: string
  revision: string
  engineSha256: string
  desktopVersion: string
} = JSON.parse(readFileSync(process.argv[2]!, "utf8"))
for (const name of ["userData", "sessionData", "cache", "crashDumps"] as const) {
  const directory = path.join(input.root, `electron-${name}`)
  mkdirSync(directory, { recursive: true })
  app.setPath(name, directory)
}
app.commandLine.appendSwitch("use-mock-keychain")
app.commandLine.appendSwitch("password-store", "basic")
app.commandLine.appendSwitch("host-resolver-rules", "MAP *.web.test 127.0.0.1")
ConfigManaged.useTestDirectory(path.join(input.root, "managed"))
startDesktopLocal({
  userData: app.getPath("userData"),
  commandLine: app.commandLine,
  log: (message) => console.log(message),
})
app.on("window-all-closed", () => undefined)
const checks: { name: string; ok: boolean }[] = []
const cycles: number[] = []
const controls: { time: number; origin: string; method: string; path: string }[] = []
const check = (name: string, ok: boolean) => {
  checks.push({ name, ok })
  if (!ok) throw new Error(name)
}

void main().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})

async function main() {
  await app.whenReady()
  const policy = (web: "ask" | "none") => LocalPolicy.resolve({ global: { enabled: true, web } })
  Egress.configure(policy("ask"), { log: { directory: path.join(input.root, "desktop-egress") } })
  const chromium = installChromiumLocal({
    app,
    defaultSession: session.defaultSession,
    fromPartition: (name, options) => session.fromPartition(name, options),
    webContents: () => webContents.getAllWebContents(),
    directory: path.join(input.root, "chromium-policy"),
  })
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  controls.push({ time: Date.now(), origin: input.base, method: "GET", path: "/app" })
  await window.loadURL(`${input.base}/app`)
  const request = async (route: string, body?: unknown) => {
    controls.push({
      time: Date.now(),
      origin: new URL(input.engineURL).origin,
      method: body === undefined ? "GET" : "POST",
      path: route,
    })
    return window.webContents.executeJavaScript(`(async () => {
      const response = await fetch(${JSON.stringify(new URL(route, input.engineURL).href)}, {
        method: ${JSON.stringify(body === undefined ? "GET" : "POST")},
        headers: { "content-type": "application/json", "x-vector-directory": ${JSON.stringify(encodeURIComponent(input.repository))} },
        ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`}
      });
      if (!response.ok) throw new Error("Capture API returned " + response.status);
      const text = await response.text(); return text ? JSON.parse(text) : null;
    })()`)
  }
  const port = new URL(input.base).port
  const page = (host: string, pathname = "/page") => `http://${host}.web.test:${port}${pathname}`
  const load = async (url: string, partition: string) => {
    const child = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        ...(partition === "persist:vector-browser" ? AGENT_BROWSER_PREFERENCES : {}),
        partition,
      },
    })
    const loaded = await child.loadURL(url).then(
      () => true,
      () => false,
    )
    return { child, loaded }
  }
  const update = (url: string) =>
    new Promise<string>((resolve) => {
      const request = net.request({ url, session: session.fromPartition("electron-updater", { cache: false }) })
      request.on("response", (response) => {
        response.on("data", () => undefined)
        response.on("end", () => resolve(String(response.statusCode)))
      })
      request.on("error", () => resolve("blocked"))
      request.end()
    })
  const started = Date.now()
  while (Date.now() - started < input.duration) {
    const cycle = Date.now()
    const created: { id: string } = await request("/session", { title: "Local capture fixture" })
    await request(`/session/${created.id}/prompt_async`, {
      agent: "build",
      size: "light",
      model: { providerID: "capture", modelID: "fixture" },
      parts: [{ type: "text", text: "Read notes.txt and say what it contains." }],
    })
    const deadline = Date.now() + 60_000
    for (;;) {
      const messages: {
        info: { role: string; error?: unknown }
        parts: { type: string; text?: string; tool?: string; state?: { status: string } }[]
      }[] = await request(`/session/${created.id}/message`)
      if (messages.some((message) => message.info.error)) throw new Error("The built engine reported a turn failure")
      const parts = messages.filter((message) => message.info.role === "assistant").flatMap((message) => message.parts)
      if (parts.some((part) => part.type === "text" && part.text?.includes("The local capture fixture is ready."))) {
        check(
          "built Node engine completed a Read tool and inference",
          parts.some((part) => part.tool === "read" && part.state?.status === "completed"),
        )
        break
      }
      if (Date.now() > deadline) throw new Error("The built engine turn did not finish")
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const browse = await load(page("redirect", "/redirect"), "persist:vector-browser")
    check("agent browser loaded a redirect and page", browse.loaded)
    check(
      "two same-host scripts loaded",
      (await browse.child.webContents.executeJavaScript("window.captureScripts")) === 2,
    )
    check(
      "agent browser keeps WebRTC off UDP",
      browse.child.webContents.getWebRTCIPHandlingPolicy() === "disable_non_proxied_udp",
    )
    browse.child.destroy()
    const refused = await load(page("unlabelled"), `capture-late-${cycles.length}`)
    check("late unlabelled session was blocked", !refused.loaded)
    refused.child.destroy()
    // The dispatcher records one origin per page/session. A distinct feed origin keeps each explicit check visible.
    const feed = page(`updates-${cycles.length}`, "/latest.yml")
    check("automatic update check was blocked", (await update(feed)) === "blocked")
    check(
      "manual update check reached the fixture",
      (await duringUpdateCheck(
        (name, options) => session.fromPartition(name, options),
        [feed],
        () => update(feed),
      )) === "200",
    )
    Egress.configure(policy("none"))
    chromium.apply()
    const denied = await load(page("web-none"), "persist:vector-browser")
    check("Web access None blocked the browser", !denied.loaded)
    denied.child.destroy()
    Egress.configure(policy("ask"))
    chromium.apply()
    cycles.push(Date.now())
    console.log(`capture cycle ${cycles.length} at ${new Date().toISOString()}`)
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Math.min(30_000 - (Date.now() - cycle), input.duration - (Date.now() - started))),
      ),
    )
  }
  const finished = Date.now()
  writeFileSync(path.join(input.output, "desktop-events.json"), JSON.stringify(await Egress.exported(), null, 2))
  writeFileSync(
    path.join(input.output, "workload.json"),
    JSON.stringify(
      {
        revision: input.revision,
        engineSha256: input.engineSha256,
        desktopVersion: input.desktopVersion,
        started,
        finished,
        cycles,
        checks,
        controls,
        ports: [Number(new URL(input.base).port), Number(new URL(input.engineURL).port)],
      },
      null,
      2,
    ),
  )
  window.destroy()
  app.exit(0)
}
