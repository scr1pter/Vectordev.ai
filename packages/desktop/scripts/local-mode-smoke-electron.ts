// Vector Local's Chromium filter in the real Electron (plan section 4.3.6), bundled and started by local-mode-smoke.ts.
// It serves a small web of its own on 127.0.0.1, whose names under web.test Chromium resolves there
// (--host-resolver-rules), so nothing reaches any other host; then it puts the desktop's dispatcher on Electron's
// sessions as desktop main does and loads pages in Vector's window, the agent's browser and other sessions. It prints
// one line, "local-smoke " and the checks as JSON, and quits.

import { mkdtempSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { app, BrowserWindow, session, webContents } from "electron"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { egressFilter } from "../src/main/egress-filter"
import { installChromiumLocal } from "../src/main/local-mode"

export type Check = { name: string; ok: boolean; detail?: string; note?: boolean }

const MARK = "local-smoke "
const home = mkdtempSync(path.join(tmpdir(), "vector-local-smoke-"))
app.setPath("userData", path.join(home, "user-data"))
// The smoke's web: every name under web.test is this computer, for Chromium only. Vector Local still reads the names
// as internet hosts, as it would read real ones.
app.commandLine.appendSwitch("host-resolver-rules", "MAP *.web.test 127.0.0.1")
// No keychain question for the agent browser's cookie store on macOS, and no stored password on Linux.
app.commandLine.appendSwitch("use-mock-keychain")
app.commandLine.appendSwitch("password-store", "basic")

const hits: string[] = []
const server = http.createServer((request, response) => {
  const host = (request.headers.host ?? "").replace(/:\d+$/, "")
  hits.push(`${host}${request.url}`)
  const port = (server.address() as { port: number }).port
  const at = (name: string, file: string) => `http://${name}.web.test:${port}/${file}`
  if (request.url === "/page")
    return void response.end(`<!doctype html><title>page</title>
<script src="${at("cdn", "a.js")}"></script><script src="${at("cdn", "b.js")}"></script>
<img src="${at("img", "i.png")}">
<script>
  const frame = document.createElement("iframe")
  document.documentElement.appendChild(frame)
  window.peers = { page: typeof RTCPeerConnection, frame: typeof frame.contentWindow.RTCPeerConnection }
</script>`)
  if (request.url?.endsWith(".js")) return void response.end("window.loaded = (window.loaded || 0) + 1")
  response.end("ok")
})

const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) })
const note = (name: string, detail: string) => checks.push({ name, ok: true, detail, note: true })

await app.whenReady()
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as { port: number }).port
const page = (name: string) => `http://${name}.web.test:${port}/page`
const local = `http://127.0.0.1:${port}/page`
const policy = (web: "ask" | "none") => LocalPolicy.resolve({ global: { enabled: true, web } })
Egress.configure(policy("ask"))

installChromiumLocal({
  app,
  defaultSession: session.defaultSession,
  fromPartition: (partition, options) => session.fromPartition(partition, options),
  webContents: () => webContents.getAllWebContents(),
  directory: path.join(home, "local-mode"),
})

// Loads a page in a hidden window of `partition` (Vector's own windows when none); resolves whether it loaded.
const load = async (url: string, partition?: string) => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, ...(partition ? { partition } : {}) },
  })
  const loaded = await window.loadURL(url).then(
    () => true,
    () => false,
  )
  return { window, loaded }
}
const seen = (prefix: string) => hits.filter((hit) => hit.startsWith(prefix)).length

try {
  // Vector's own windows: this computer loads, an internet name no part of Vector labelled does not.
  const own = await load(local)
  check("Vector's window loads a page on this computer", own.loaded)
  check(
    "Vector's window keeps WebRTC to the proxy",
    own.window.webContents.getWebRTCIPHandlingPolicy() === "disable_non_proxied_udp",
    own.window.webContents.getWebRTCIPHandlingPolicy(),
  )
  own.window.destroy()
  const before = seen("news.web.test")
  const refused = await load(page("news"))
  check("Vector's window refuses an internet page no part of Vector labelled", !refused.loaded)
  check("…before it reaches the network", seen("news.web.test") === before)
  refused.window.destroy()

  // The agent's browser follows Web access: Ask loads the page and what it loads.
  const browse = await load(page("news"), "persist:vector-browser")
  check("the agent's browser loads an internet page with Web access Ask", browse.loaded)
  const loaded = await browse.window.webContents.executeJavaScript("window.loaded || 0")
  check("…and the scripts the page loads", loaded === 2, `${loaded} scripts ran`)
  const peers = (await browse.window.webContents.executeJavaScript("window.peers")) as { page: string; frame: string }
  check("the agent's browser's pages have no RTCPeerConnection", peers.page === "undefined", peers.page)
  note(
    "a frame a page's script just made, in the agent's browser",
    `RTCPeerConnection is ${peers.frame} there; WebRTC is held to no proxy by the IP handling policy`,
  )
  const events = Egress.events().filter((event) => event.source === "agent-browser" && event.decision === "allow")
  const pages = events.filter((event) => event.resource === "page").map((event) => event.origin)
  const loads = events.filter((event) => event.resource === "subresource").map((event) => event.origin)
  check("the network log counts the agent's page once", pages.length === 1, pages.join(", "))
  check("…and what it loaded once per host", loads.length === 2 && new Set(loads).size === 2, loads.join(", "))
  const summary = Egress.summary()
  check("the counters read 1 page and 3 hosts", summary.pages === 1 && summary.hosts === 3, JSON.stringify(summary))
  browse.window.destroy()

  // Web access None: the agent's browser reaches this computer only.
  Egress.configure(policy("none"))
  const none = await load(page("docs"), "persist:vector-browser")
  check("the agent's browser refuses an internet page with Web access None", !none.loaded)
  none.window.destroy()
  const dev = await load(local, "persist:vector-browser")
  check("…and still loads a page on this computer", dev.loaded)
  dev.window.destroy()
  Egress.configure(policy("ask"))

  // A session Electron makes later gets the dispatcher too, and is decided as a request no part of Vector labelled.
  const other = await load(page("other"), "smoke-other")
  check("a session made later refuses an internet page", !other.loaded)
  other.window.destroy()

  // A window's own step runs after Vector Local's decision, on the one listener the session has.
  const ran: string[] = []
  const billing = session.fromPartition("smoke-billing")
  egressFilter.register(
    billing,
    (details, callback) => {
      if (details.resourceType === "mainFrame") ran.push(new URL(details.url).hostname)
      callback({})
    },
    { kind: "billing" },
  )
  const blocked = await load(page("pay"), "smoke-billing")
  check("a window's step never sees a request Vector Local refused", !blocked.loaded && ran.length === 0)
  blocked.window.destroy()
  Egress.configure(LocalPolicy.OFF)
  const off = await load(page("pay"), "smoke-billing")
  check("with Vector Local off the window's step runs as it would alone", off.loaded && ran.includes("pay.web.test"))
  off.window.destroy()
} catch (error) {
  check("the smoke ran to the end", false, error instanceof Error ? error.stack : String(error))
}

console.log(`${MARK}${JSON.stringify(checks)}`)
server.close()
app.exit(0)
