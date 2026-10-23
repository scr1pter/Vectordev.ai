#!/usr/bin/env bun
// The research browsers in the real Electron (section 5.6a): what only Chromium can show, which the desktop's unit tests
// (Bun, with Electron mocked) cannot. Run it from packages/desktop:
//
//   bun scripts/research-browser-smoke.ts
//
// Run by Bun, it bundles research-browser-smoke-electron.ts for Node and starts the pinned Electron binary on the bundle;
// that file, inside Electron, starts a small web of its own on 127.0.0.1 (names under web.test, resolved there by the injected resolver, as the fake web
// does) and drives research browsers through runResearchBrowser, with no other network. It prints one line per check
// and exits non-zero when one fails. It needs Electron's binary (the desktop's install downloads it) and a display;
// on macOS it runs by hand, and in CI wherever xvfb exists.
//
// It checks:
// - a cookie set in one slot is not seen in another slot, in persist:vector-browser, or in the same slot after reuse;
// - a page's fetch to 127.0.0.1 is refused (the <-loopback> rule and the proxy);
// - service worker registration fails;
// - alert() shows nothing and returns;
// - print() returns at once without a dialog, from the page and from a frame the page's script just made;
// - RTCPeerConnection from such a fresh frame gathers no address outside the proxy;
// - a 401 Basic challenge gets no credentials, and a TLS site that asks for a client certificate gets none (the smoke
//   trusts its own test certificate in the research slots, as a test CA would be; it needs openssl, and says skip
//   without it);
// - a meta refresh and a timer navigation to another site are refused;
// - an iframe POST form is refused;
// - top-level blob:, data: and javascript: navigations are refused;
// - holding a page's scripts between commands stops its timers, and a page let run again is visible and renders
//   (requestAnimationFrame runs), so watching snapshots show it;
// - typing reaches a search field while a window of the smoke's own keeps the focus, and the hidden host never takes
//   focus or shows;
// - once the last research browser closes, no host window is left (a Dock click, a second launch or the tray then
//   finds no window but Vector's own).

import { existsSync, readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Check } from "./research-browser-smoke-electron"

// The prefix of the line the checks print their results on, as research-browser-smoke-electron.ts writes it.
const MARK = "research-smoke "
const LIMIT_MS = 240_000

await launch()

// Bundle the checks for Node with Electron left to the runtime, then run them in Electron.
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
    entrypoints: [path.join(import.meta.dir, "research-browser-smoke-electron.ts")],
    target: "node",
    format: "esm",
    outdir: out,
    naming: "[name].mjs",
    external: ["electron"],
  })
  if (!built.success) throw new AggregateError(built.logs, "The research browser smoke did not bundle")
  const child = Bun.spawn([binary, path.join(out, "research-browser-smoke-electron.mjs")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    // No proxy of the machine's own, so every request is decided as the smoke sets it up.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DISPLAY: process.env.DISPLAY ?? "" },
  })
  // A check that hangs (a page that never answers) ends the run instead of holding it.
  const timer = setTimeout(() => child.kill(), LIMIT_MS)
  const stdout = await new Response(child.stdout).text()
  await child.exited
  clearTimeout(timer)
  const line = stdout.split("\n").find((item) => item.startsWith(MARK))
  if (!line) {
    console.error(stdout)
    console.error(`The research browser smoke printed no result (it stops after ${LIMIT_MS / 1000} seconds).`)
    process.exit(1)
  }
  const checks = JSON.parse(line.slice(MARK.length)) as Check[]
  checks.forEach((check) =>
    console.log(
      `${check.skipped ? "skip" : check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`,
    ),
  )
  process.exit(checks.every((check) => check.ok) ? 0 : 1)
}
