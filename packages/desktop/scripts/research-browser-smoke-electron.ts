// The research browser smoke's checks, inside the pinned Electron: run by research-browser-smoke.ts, which bundles this
// file for Node and starts Electron on it. See that file for what is checked.
//
// The entry must not await at its top level: Electron holds `ready` until the entry module has loaded, so a top-level
// await of app.whenReady() never returns. Every import is static, so the bundle holds one copy of each module and the
// smoke's network setting reaches the proxy the research browsers use.
//
// Electron quits by itself when its last window closes unless the app listens for window-all-closed; Vector's main
// process always does (index.ts), so the smoke does too, or destroying the research browsers' host would quit it.

import { execFile } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TLSSocket } from "node:tls"
import { app, BrowserWindow, nativeImage, session, webContents } from "electron"
import {
  ResearchWatch,
  runResearchBrowser,
  type ResearchCommand,
  type ResearchInput,
} from "../src/main/research-browser"
import { NOT_LINK, PAGE_STARTED, POST, SCHEME } from "../src/main/research-navigation"
import { useResearchNetwork } from "../src/main/research-proxy"

// The prefix of the line the results go on, which research-browser-smoke.ts reads.
const MARK = "research-smoke "

export type Check = {
  readonly name: string
  readonly ok: boolean
  readonly skipped?: boolean
  readonly detail?: string
}

if (process.versions.electron)
  void main().catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })

async function main() {
  app.on("window-all-closed", () => undefined)
  await app.whenReady()

  // A web of the smoke's own on 127.0.0.1, one site per name under web.test, routed by the Host header.
  const hits: { host: string; method: string; path: string; authorization?: string; certificate?: boolean }[] = []
  const pages: Record<
    string,
    (request: http.IncomingMessage) => { status?: number; headers?: Record<string, string>; body: string }
  > = {
    "cookie.web.test/set": () => ({ headers: { "set-cookie": "smoke=one; Path=/" }, body: "<p>Cookie set.</p>" }),
    "cookie.web.test/read": (request) => ({ body: `<p>Cookies sent: ${request.headers.cookie ?? "none"}</p>` }),
    "loop.web.test/": () => ({
      body: `<p id="result">pending</p><script>fetch("http://127.0.0.1:${port()}/secret").then(() => document.getElementById("result").textContent = "reached", () => document.getElementById("result").textContent = "blocked")</script>`,
    }),
    "worker.web.test/": () => ({
      body: `<p id="result">pending</p><script>Promise.resolve().then(() => navigator.serviceWorker.register("/sw.js")).then(() => document.getElementById("result").textContent = "registered", () => document.getElementById("result").textContent = "failed")</script>`,
    }),
    "worker.web.test/sw.js": () => ({
      headers: { "content-type": "text/javascript" },
      body: "self.addEventListener('fetch', () => {})",
    }),
    "alert.web.test/": () => ({
      body: `<p id="result">pending</p><script>alert("hello"); document.getElementById("result").textContent = "returned"</script>`,
    }),
    "print.web.test/": () => ({
      body: `<p id="result">pending</p><script>const started = Date.now(); window.print(); document.getElementById("result").textContent = "returned after " + (Date.now() - started) + " ms"</script>`,
    }),
    // A frame the page's script makes is a fresh document: no stub the page got reaches it unless Chromium carries it.
    "printframe.web.test/": () => ({
      body: `<p id="result">pending</p><script>const frame = document.createElement("iframe"); document.body.appendChild(frame); const started = Date.now(); frame.contentWindow.print(); document.getElementById("result").textContent = "returned after " + (Date.now() - started) + " ms"</script>`,
    }),
    "rtc.web.test/": () => ({
      body: `<p id="result">pending</p><script>const frame = document.createElement("iframe"); document.body.appendChild(frame); const RTC = frame.contentWindow.RTCPeerConnection; const result = document.getElementById("result"); if (!RTC) result.textContent = "no RTCPeerConnection in a fresh frame"; else { const found = []; const peer = new RTC({ iceServers: [] }); peer.onicecandidate = (event) => { if (event.candidate) found.push(event.candidate.type || "unknown"); result.textContent = "candidates: " + (found.join(",") || "none") }; peer.createDataChannel("smoke"); peer.createOffer().then((offer) => peer.setLocalDescription(offer)).then(() => { result.textContent = "candidates: " + (found.join(",") || "none") }, (error) => { result.textContent = "failed: " + error }) }</script>`,
    }),
    "auth.web.test/": () => ({
      status: 401,
      headers: { "www-authenticate": 'Basic realm="smoke"' },
      body: "<p>Sign in</p>",
    }),
    "refresh.web.test/": () => ({
      body: `<meta http-equiv="refresh" content="0;url=http://other.web.test:${port()}/"><p>Refreshing</p><script>setTimeout(() => { location.href = "http://elsewhere.web.test:${port()}/" }, 2_500)</script>`,
    }),
    "post.web.test/": () => ({
      body: `<iframe srcdoc='<form method="post" action="http://sink.web.test:${port()}/submit"><input name="q" value="x"></form><script>document.forms[0].submit()</script>'></iframe>`,
    }),
    "schemes.web.test/": () => ({
      body: `<script>setTimeout(() => { location.href = "data:text/html,hi" }, 100); setTimeout(() => { location.href = URL.createObjectURL(new Blob(["hi"], { type: "text/html" })) }, 400); setTimeout(() => { location.href = "javascript:document.title='moved'" }, 700)</script><p>Schemes</p>`,
    }),
    "timer.web.test/": () => ({
      body: `<p id="count">0</p><script>let count = 0; setInterval(() => { count++; document.getElementById("count").textContent = String(count) }, 20)</script>`,
    }),
    "visible.web.test/": () => ({
      body: `<h1>Heat pumps</h1><p>A page that draws.</p><script>window.smokeFrames = 0; const tick = () => { window.smokeFrames++; requestAnimationFrame(tick) }; requestAnimationFrame(tick)</script>`,
    }),
    "search.web.test/": () => ({
      body: `<form action="/results" method="get"><input id="q" type="search" name="q" aria-label="Search"></form>`,
    }),
  }
  const server = http.createServer((request, response) => {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "")
    hits.push({
      host,
      method: request.method ?? "",
      path: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    })
    const page = pages[`${host}${(request.url ?? "/").split("?")[0]}`]
    if (!page) {
      response.writeHead(404, { "content-type": "text/plain" })
      return response.end("Not found")
    }
    const answer = page(request)
    response.writeHead(answer.status ?? 200, { "content-type": "text/html; charset=utf-8", ...answer.headers })
    response.end(answer.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  function port() {
    const address = server.address()
    return typeof address === "object" && address ? address.port : 0
  }
  useResearchNetwork({
    resolver: (hostname) =>
      hostname === "web.test" || hostname.endsWith(".web.test")
        ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
        : Promise.reject(new Error(`The smoke resolves only web.test names, not ${hostname}`)),
    privateHosts: ["web.test"],
  })

  // A TLS site that asks every client for a certificate, with a certificate of the smoke's own.
  const tls = await tlsSite()
  const site = (name: string, at = "/") => `http://${name}.web.test:${port()}${at}`
  const every = [
    ...Object.keys(pages).map((key) => `http://${key.split("/")[0]}:${port()}/${key.split("/").slice(1).join("/")}`),
    ...(tls ? [tls.url] : []),
  ]
  const command = (
    input: Partial<ResearchInput> & {
      command: ResearchCommand
      sessionID: string
    },
  ) => runResearchBrowser({ runID: "run_smoke", agent: "researcher", max: 5, provenance: every, ...input })
  const text = async (sessionID: string) => (await command({ command: "research.read", sessionID })).read?.html ?? ""
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const checks: Check[] = []
  const check = (name: string, ok: boolean | "skip", detail?: string) => {
    process.stderr.write(
      `research-smoke: ${ok === "skip" ? "skip" : ok ? "ok" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}\n`,
    )
    checks.push({ name, ok: ok !== false, ...(ok === "skip" ? { skipped: true } : {}), ...(detail ? { detail } : {}) })
  }
  // The research browser's own page, for what only the page itself can say.
  const contentsOf = (url: string) => webContents.getAllWebContents().find((item) => item.getURL().startsWith(url))
  // Runs `fn` with the page's scripts let run, as each command does as it starts, and holds them again after: any
  // script of the smoke's own in a held page would wait for the next command.
  const running = async <T>(contents: Electron.WebContents, fn: () => Promise<T>) => {
    const send = (method: string, params?: Record<string, unknown>) =>
      contents.debugger.sendCommand(method, params).catch(() => undefined)
    await send("Debugger.setSkipAllPauses", { skip: true })
    await send("Debugger.resume")
    const result = await fn()
    await send("Debugger.setSkipAllPauses", { skip: false })
    await send("Debugger.pause")
    return result
  }
  // The smoke's own window stands for the user's, focused, with nothing to do with research.
  const user = new BrowserWindow({ width: 360, height: 220, show: true, webPreferences: { partition: "smoke-user" } })
  await user.loadURL("data:text/html,<p>The smoke's own window</p>")
  // macOS gives a program started from a terminal no focus of its own, so the smoke takes it, as a user's click would.
  if (process.platform === "darwin") app.focus({ steal: true })
  user.focus()
  await wait(300)
  const others = () => BrowserWindow.getAllWindows().filter((item) => item !== user && !item.isDestroyed())

  // Cookies stay in their slot, and a slot is clean for its next agent.
  await command({ command: "research.open", sessionID: "ses_a", url: site("cookie", "/set") })
  const slots = ResearchWatch.list()
  const own = await session.fromPartition("vector-research-1").cookies.get({})
  await command({ command: "research.open", sessionID: "ses_b", url: site("cookie", "/read") })
  const other = await text("ses_b")
  const userCookies = await session.fromPartition("persist:vector-browser").cookies.get({ domain: "cookie.web.test" })
  await command({ command: "research.close", sessionID: "ses_a" })
  await command({ command: "research.open", sessionID: "ses_c", url: site("cookie", "/read") })
  const reused = await text("ses_c")
  check("a cookie is kept in its own slot", own.some((cookie) => cookie.name === "smoke") && slots.length === 1)
  check("another slot does not see it", other.includes("Cookies sent: none"), other.slice(0, 200))
  check("the user's browser does not see it", userCookies.length === 0)
  check("the same slot after reuse does not see it", reused.includes("Cookies sent: none"), reused.slice(0, 200))
  await command({ command: "research.close", sessionID: "ses_b" })
  await command({ command: "research.close", sessionID: "ses_c" })

  // A page opened, read after `settle` and scrolled; what the rule refused is reported by the command it happened in,
  // so the three commands' refusals are kept together.
  const page = async (name: string, settle = 1_000) => {
    process.stderr.write(`research-smoke: opening ${name}\n`)
    const opened = await command({ command: "research.open", sessionID: `ses_${name}`, url: site(name) })
    await wait(settle)
    const read = await command({ command: "research.read", sessionID: `ses_${name}` })
    const scrolled = await command({ command: "research.scroll", sessionID: `ses_${name}` })
    await command({ command: "research.close", sessionID: `ses_${name}` })
    return {
      html: read.read?.html ?? "",
      report: { ...scrolled, refused: [...opened.refused, ...read.refused, ...scrolled.refused] },
    }
  }

  const loop = await page("loop")
  check("a page's fetch to 127.0.0.1 is refused", loop.html.includes("blocked"), loop.html.slice(0, 200))
  check("nothing on 127.0.0.1 was reached for it", !hits.some((hit) => hit.path === "/secret"))

  const worker = await page("worker")
  check("service worker registration fails", worker.html.includes("failed"), worker.html.slice(0, 200))

  const alerted = await page("alert")
  check("alert() shows nothing and returns", alerted.html.includes("returned"), alerted.html.slice(0, 200))

  const printed = await page("print")
  check(
    "print() returns at once, with no dialog",
    /returned after \d ms/.test(printed.html),
    printed.html.slice(0, 200),
  )
  const framed = await page("printframe")
  check(
    "print() from a frame the page just made returns at once, with no dialog",
    /returned after \d ms/.test(framed.html),
    framed.html.slice(0, 200),
  )

  const rtc = await page("rtc", 1_500)
  const gathered =
    /candidates: ([^<]*)|no RTCPeerConnection[^<]*|failed: [^<]*/.exec(rtc.html)?.[0] ?? rtc.html.slice(0, 200)
  check(
    "RTCPeerConnection from a fresh frame gathers no address outside the proxy",
    /candidates: none|no RTCPeerConnection/.test(gathered),
    gathered,
  )

  const auth = await page("auth")
  check(
    "a 401 Basic challenge gets no credentials",
    !hits.some((hit) => hit.host === "auth.web.test" && hit.authorization),
    auth.html.slice(0, 120),
  )

  if (!tls) check("a TLS site that asks for a client certificate gets none", "skip", "openssl is not on this computer")
  if (tls) {
    // The slots trust the smoke's own certificate, as they would a test CA; every other certificate is checked as usual.
    Array.from({ length: 5 }, (_, index) =>
      session
        .fromPartition(`vector-research-${index + 1}`)
        .setCertificateVerifyProc((request, callback) => callback(request.hostname === "tls.web.test" ? 0 : -3)),
    )
    // As an address the user typed, so robots.txt, which the proxy's own fetch could not read past the test
    // certificate, does not apply.
    const opened = await command({ command: "research.open", sessionID: "ses_tls", url: tls.url, typed: [tls.url] })
    const shown = await text("ses_tls")
    await command({ command: "research.close", sessionID: "ses_tls" })
    Array.from({ length: 5 }, (_, index) =>
      session.fromPartition(`vector-research-${index + 1}`).setCertificateVerifyProc(null),
    )
    check(
      "a TLS site that asks for a client certificate gets none",
      tls.asked() > 0 && !tls.given(),
      `${tls.asked()} connection(s); the page ${shown.includes("No certificate") ? "loaded" : `did not load (${opened.error ?? "no error"})`}`,
    )
  }

  const refresh = await page("refresh", 3_000)
  check(
    "a meta refresh and a timer navigation to another site are refused",
    refresh.report.url.startsWith(site("refresh")) &&
      !hits.some((hit) => hit.host === "other.web.test" || hit.host === "elsewhere.web.test"),
    JSON.stringify(refresh.report.refused),
  )
  // The meta refresh comes within 2 seconds of the agent's open, so it is decided as a link the page did not offer; the
  // timer's comes later, when nothing the agent did started it.
  check(
    "each refusal says why: not a link after the open, the page's own later",
    refresh.report.refused.some((item) => item.url.includes("other.web.test") && item.reason === NOT_LINK) &&
      refresh.report.refused.some((item) => item.url.includes("elsewhere.web.test") && item.reason === PAGE_STARTED),
    JSON.stringify(refresh.report.refused.map((item) => [new URL(item.url).hostname, item.reason.slice(0, 40)])),
  )

  await page("post", 1_500)
  check("an iframe POST form is refused", !hits.some((hit) => hit.host === "sink.web.test"))

  const schemes = await page("schemes", 1_500)
  check(
    "top-level blob:, data: and javascript: navigations are refused",
    schemes.report.url.startsWith(site("schemes")) && schemes.report.title !== "moved",
    JSON.stringify(schemes.report.refused),
  )
  // Chromium itself refuses a page's own top-level navigation to data:, so only blob: reaches the rule.
  check(
    "blob: is refused as a scheme",
    schemes.report.refused.some((item) => item.reason === SCHEME && item.url.startsWith("blob:")),
    JSON.stringify(schemes.report.refused.map((item) => item.url.slice(0, 20))),
  )

  await command({ command: "research.open", sessionID: "ses_timer", url: site("timer") })
  const first = Number(/<p>(\d+)<\/p>/.exec(await text("ses_timer"))?.[1] ?? "0")
  await wait(1_000)
  const second = Number(/<p>(\d+)<\/p>/.exec(await text("ses_timer"))?.[1] ?? "0")
  await command({ command: "research.close", sessionID: "ses_timer" })
  // 1 second at one tick per 20 ms would be about 50 ticks; a held page makes a few while each read runs.
  check(
    "holding a page's scripts between commands stops its timers",
    first > 0 && second - first < 15,
    `${first} then ${second}`,
  )

  // A page let run again is visible and draws: here by hand, as each command does as it starts, and held again after.
  await command({ command: "research.open", sessionID: "ses_visible", url: site("visible") })
  const drawn = contentsOf(site("visible"))
  const drawing = drawn
    ? await running(drawn, async () => {
        const before = Number(await drawn.executeJavaScript("window.smokeFrames"))
        await wait(400)
        return {
          visibility: String(await drawn.executeJavaScript("document.visibilityState")),
          frames: Number(await drawn.executeJavaScript("window.smokeFrames")) - before,
        }
      })
    : undefined
  check(
    "a page let run again is visible and draws",
    drawing?.visibility === "visible" && drawing.frames > 5,
    JSON.stringify(drawing ?? "the page was not found"),
  )
  const chip = ResearchWatch.list().find((item) => item.sessionID === "ses_visible")
  const snapshot = chip ? await ResearchWatch.snapshot(chip.id) : undefined
  const image = snapshot ? nativeImage.createFromDataURL(snapshot) : undefined
  check(
    "a watching snapshot shows the page",
    Boolean(image && !image.isEmpty() && image.getSize().width >= 640),
    JSON.stringify(image?.getSize() ?? "no snapshot"),
  )

  // Typing reaches a search field, and the user's window keeps the keyboard.
  const focused = user.isFocused()
  await command({ command: "research.open", sessionID: "ses_search", url: site("search") })
  const observed = await command({ command: "research.observe", sessionID: "ses_search" })
  const field = observed.observed?.elements.find((element) => element.tag === "input")
  const typed = field
    ? await command({ command: "research.type", sessionID: "ses_search", ref: field.ref, text: "heat pumps" })
    : undefined
  const searched = contentsOf(site("search"))
  const value = searched
    ? String(await running(searched, () => searched.executeJavaScript("document.getElementById('q').value")))
    : ""
  const host = others()[0]
  check(
    "typing reaches a search field without focusing the research browser",
    value === "heat pumps",
    typed?.error ?? value,
  )
  check(
    "the hidden host never takes focus or shows",
    Boolean(host && !host.isVisible() && !host.isFocusable() && BrowserWindow.getFocusedWindow() !== host),
    host ? `visible ${host.isVisible()}, focusable ${host.isFocusable()}` : "no host window",
  )
  // macOS gives a program started from a terminal no focus while another app holds it, so there this one may skip; the
  // check above holds either way.
  check(
    "the user's window keeps the focus while a research browser types",
    focused ? user.isFocused() : "skip",
    focused ? `focused ${user.isFocused()}` : "the smoke's window never had the focus (another app holds it)",
  )
  await command({ command: "research.close", sessionID: "ses_search" })
  await command({ command: "research.close", sessionID: "ses_visible" })
  check(
    "no host window is left once the last research browser closes",
    others().length === 0,
    `${others().length} other window(s)`,
  )

  check("no POST reached any site", !hits.some((hit) => hit.method === "POST"), POST)
  user.destroy()
  tls?.close()
  process.stdout.write(`${MARK}${JSON.stringify(checks)}\n`, () => app.exit(0))

  // A TLS site on 127.0.0.1 as tls.web.test that asks each client for a certificate; undefined without openssl.
  async function tlsSite() {
    const directory = await mkdtemp(path.join(tmpdir(), "vector-research-smoke-tls-"))
    const key = path.join(directory, "key.pem")
    const cert = path.join(directory, "cert.pem")
    const made = await new Promise<boolean>((resolve) =>
      execFile(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=tls.web.test",
        ],
        (error) => resolve(!error),
      ),
    )
    if (!made) return undefined
    const state = { asked: 0, given: false }
    const secure = https.createServer(
      { key: await readFile(key), cert: await readFile(cert), requestCert: true, rejectUnauthorized: false },
      (request, response) => {
        const peer = (request.socket as TLSSocket).getPeerCertificate()
        state.given = state.given || Boolean(peer && Object.keys(peer).length > 0)
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(`<p>${state.given ? "A certificate came" : "No certificate"}</p>`)
      },
    )
    secure.on("secureConnection", () => state.asked++)
    await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", () => resolve()))
    const address = secure.address()
    const at = typeof address === "object" && address ? address.port : 0
    return {
      url: `https://tls.web.test:${at}/`,
      asked: () => state.asked,
      given: () => state.given,
      close: () => secure.close(),
    }
  }
}
