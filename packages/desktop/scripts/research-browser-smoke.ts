#!/usr/bin/env bun
// The research browsers in the real Electron (section 5.6a): what only Chromium can show, which the desktop's unit tests
// (Bun, with Electron mocked) cannot. Run it from packages/desktop:
//
//   bun scripts/research-browser-smoke.ts
//
// Run by Bun, it bundles itself for Node and starts the pinned Electron binary on the bundle; inside Electron it starts
// a small web of its own on 127.0.0.1 (names under web.test, resolved there by the injected resolver, as the fake web
// does) and drives research browsers through runResearchBrowser, with no other network. It prints one line per check
// and exits non-zero when one fails. It needs Electron's binary (the desktop's install downloads it) and a display;
// on macOS it runs by hand, and in CI wherever xvfb exists.
//
// It checks:
// - a cookie set in one slot is not seen in another slot, in persist:vector-browser, or in the same slot after reuse;
// - a page's fetch to 127.0.0.1 is refused (the <-loopback> rule and the proxy);
// - service worker registration fails;
// - alert() shows nothing and returns;
// - a 401 Basic challenge gets no credentials (a client-certificate request needs a TLS site and stays manual);
// - a meta refresh and a timer navigation to another site are refused;
// - an iframe POST form is refused;
// - top-level blob:, data: and javascript: navigations are refused;
// - freezing between commands stops a page's timers;
// - what print() does in a hidden window, recorded.

import { existsSync, readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"

const MARK = "research-smoke "

type Check = { readonly name: string; readonly ok: boolean; readonly detail?: string }

if (process.versions.electron) await inElectron()
if (!process.versions.electron) await launch()

// Under Bun: bundle this file for Node with Electron left to the runtime, then run it in Electron.
async function launch() {
  const require = createRequire(import.meta.url)
  const directory = path.dirname(require.resolve("electron/package.json"))
  const recorded = path.join(directory, "path.txt")
  const binary = existsSync(recorded) ? path.join(directory, "dist", readFileSync(recorded, "utf8").trim()) : undefined
  if (!binary || !existsSync(binary)) {
    console.error("Electron's binary is not installed in this checkout, so the research browser smoke cannot run.")
    process.exit(2)
  }
  const out = await mkdtemp(path.join(tmpdir(), "vector-research-smoke-"))
  const built = await Bun.build({
    entrypoints: [import.meta.path],
    target: "node",
    format: "esm",
    outdir: out,
    naming: "[name].mjs",
    external: ["electron"],
  })
  if (!built.success) throw new AggregateError(built.logs, "The research browser smoke did not bundle")
  const child = Bun.spawn([binary, path.join(out, "research-browser-smoke.mjs")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    // No proxy of the machine's own, so every request is decided as the smoke sets it up.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DISPLAY: process.env.DISPLAY ?? "" },
  })
  const stdout = await new Response(child.stdout).text()
  await child.exited
  const line = stdout.split("\n").find((item) => item.startsWith(MARK))
  if (!line) {
    console.error(stdout)
    console.error("The research browser smoke printed no result.")
    process.exit(1)
  }
  const checks = JSON.parse(line.slice(MARK.length)) as Check[]
  checks.forEach((check) => console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`))
  process.exit(checks.every((check) => check.ok) ? 0 : 1)
}

// Inside Electron: the checks themselves.
async function inElectron() {
  const { app, session } = await import("electron")
  const http = await import("node:http")
  const research = await import("../src/main/research-browser")
  const { useResearchNetwork } = await import("../src/main/research-proxy")
  const { PAGE_STARTED, SCHEME, POST } = await import("../src/main/research-navigation")
  await app.whenReady()

  // A web of the smoke's own on 127.0.0.1, one site per name under web.test, routed by the Host header.
  const hits: { host: string; method: string; path: string; authorization?: string }[] = []
  const pages: Record<string, (request: import("node:http").IncomingMessage) => { status?: number; headers?: Record<string, string>; body: string }> = {
    "cookie.web.test/set": () => ({ headers: { "set-cookie": "smoke=one; Path=/" }, body: "<p>Cookie set.</p>" }),
    "cookie.web.test/read": (request) => ({ body: `<p>Cookies sent: ${request.headers.cookie ?? "none"}</p>` }),
    "loop.web.test/": () => ({
      body: `<p id="result">pending</p><script>fetch("http://127.0.0.1:${port()}/secret").then(() => document.getElementById("result").textContent = "reached", () => document.getElementById("result").textContent = "blocked")</script>`,
    }),
    "worker.web.test/": () => ({
      body: `<p id="result">pending</p><script>Promise.resolve().then(() => navigator.serviceWorker.register("/sw.js")).then(() => document.getElementById("result").textContent = "registered", () => document.getElementById("result").textContent = "failed")</script>`,
    }),
    "worker.web.test/sw.js": () => ({ headers: { "content-type": "text/javascript" }, body: "self.addEventListener('fetch', () => {})" }),
    "alert.web.test/": () => ({
      body: `<p id="result">pending</p><script>alert("hello"); document.getElementById("result").textContent = "returned"</script>`,
    }),
    "print.web.test/": () => ({
      body: `<p id="result">pending</p><script>const started = Date.now(); window.print(); document.getElementById("result").textContent = "returned after " + (Date.now() - started) + " ms"</script>`,
    }),
    "auth.web.test/": () => ({ status: 401, headers: { "www-authenticate": 'Basic realm="smoke"' }, body: "<p>Sign in</p>" }),
    "refresh.web.test/": () => ({
      body: `<meta http-equiv="refresh" content="0;url=http://other.web.test:${port()}/"><p>Refreshing</p><script>setTimeout(() => { location.href = "http://elsewhere.web.test:${port()}/" }, 300)</script>`,
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

  const site = (name: string, at = "/") => `http://${name}.web.test:${port()}${at}`
  const every = Object.keys(pages).map((key) => `http://${key.split("/")[0]}:${port()}/${key.split("/").slice(1).join("/")}`)
  const command = (input: Partial<import("../src/main/research-browser").Input> & { command: import("../src/main/research-browser").Command; sessionID: string }) =>
    research.runResearchBrowser({ runID: "run_smoke", agent: "researcher", max: 5, provenance: every, ...input })
  const text = async (sessionID: string) => (await command({ command: "research.read", sessionID })).read?.html ?? ""
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) })

  // Cookies stay in their slot, and a slot is clean for its next agent.
  await command({ command: "research.open", sessionID: "ses_a", url: site("cookie", "/set") })
  const slots = research.ResearchWatch.list()
  const own = await session.fromPartition("vector-research-1").cookies.get({})
  await command({ command: "research.open", sessionID: "ses_b", url: site("cookie", "/read") })
  const other = await text("ses_b")
  const user = await session.fromPartition("persist:vector-browser").cookies.get({ domain: "cookie.web.test" })
  await command({ command: "research.close", sessionID: "ses_a" })
  await command({ command: "research.open", sessionID: "ses_c", url: site("cookie", "/read") })
  const reused = await text("ses_c")
  check("a cookie is kept in its own slot", own.some((cookie) => cookie.name === "smoke") && slots.length === 1)
  check("another slot does not see it", other.includes("Cookies sent: none"), other.slice(0, 200))
  check("the user's browser does not see it", user.length === 0)
  check("the same slot after reuse does not see it", reused.includes("Cookies sent: none"), reused.slice(0, 200))
  await command({ command: "research.close", sessionID: "ses_b" })
  await command({ command: "research.close", sessionID: "ses_c" })

  const page = async (name: string, settle = 1_000) => {
    await command({ command: "research.open", sessionID: `ses_${name}`, url: site(name) })
    await wait(settle)
    const html = await text(`ses_${name}`)
    const report = await command({ command: "research.scroll", sessionID: `ses_${name}` })
    await command({ command: "research.close", sessionID: `ses_${name}` })
    return { html, report }
  }

  const loop = await page("loop")
  check("a page's fetch to 127.0.0.1 is refused", loop.html.includes("blocked"), loop.html.slice(0, 200))
  check("nothing on 127.0.0.1 was reached for it", !hits.some((hit) => hit.path === "/secret"))

  const worker = await page("worker")
  check("service worker registration fails", worker.html.includes("failed"), worker.html.slice(0, 200))

  const alerted = await page("alert")
  check("alert() shows nothing and returns", alerted.html.includes("returned"), alerted.html.slice(0, 200))

  const printed = await page("print")
  check("print() in a hidden window returns without a dialog (recorded)", printed.html.includes("returned"), printed.html.slice(0, 200))

  const auth = await page("auth")
  check("a 401 Basic challenge gets no credentials", !hits.some((hit) => hit.host === "auth.web.test" && hit.authorization), auth.html.slice(0, 120))

  const refresh = await page("refresh", 1_500)
  check(
    "a meta refresh and a timer navigation to another site are refused",
    refresh.report.url.startsWith(site("refresh")) && !hits.some((hit) => hit.host === "other.web.test" || hit.host === "elsewhere.web.test"),
    JSON.stringify(refresh.report.refused),
  )
  check("the refusal says the page started it", refresh.report.refused.some((item) => item.reason === PAGE_STARTED))

  await page("post", 1_500)
  check("an iframe POST form is refused", !hits.some((hit) => hit.host === "sink.web.test"))

  const schemes = await page("schemes", 1_500)
  check(
    "top-level blob:, data: and javascript: navigations are refused",
    schemes.report.url.startsWith(site("schemes")) && schemes.report.title !== "moved",
    JSON.stringify(schemes.report.refused),
  )
  check(
    "data: and blob: are refused as schemes",
    schemes.report.refused.filter((item) => item.reason === SCHEME).length >= 2,
    JSON.stringify(schemes.report.refused.map((item) => item.url.slice(0, 20))),
  )

  await command({ command: "research.open", sessionID: "ses_timer", url: site("timer") })
  const first = Number(/<p>(\d+)<\/p>/.exec(await text("ses_timer"))?.[1] ?? "0")
  await wait(1_000)
  const second = Number(/<p>(\d+)<\/p>/.exec(await text("ses_timer"))?.[1] ?? "0")
  await command({ command: "research.close", sessionID: "ses_timer" })
  // 1 second at one tick per 20 ms would be about 50 ticks; a frozen page makes a few while each read runs.
  check("freezing between commands stops a page's timers", second - first < 15, `${first} then ${second}`)

  check("no POST reached any site", !hits.some((hit) => hit.method === "POST"), POST)
  process.stdout.write(`${MARK}${JSON.stringify(checks)}\n`, () => app.exit(0))
}
