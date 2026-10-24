#!/usr/bin/env bun
// Vector Local's Chromium filter in the real Electron (plan section 4.3.6): what only Chromium can show, which the
// desktop's unit tests (Bun, with Electron mocked) cannot. Run it from packages/desktop:
//
//   bun scripts/local-mode-smoke.ts
//
// It bundles local-mode-smoke-electron.ts for Node and starts the pinned Electron binary on the bundle, which serves a
// small web of its own on 127.0.0.1 and reaches no other host. It needs Electron's binary (the desktop's install
// downloads it, or ELECTRON_OVERRIDE_DIST_PATH names the folder of one, as Electron's own package reads it) and a
// display; on macOS it runs by hand, and in CI wherever xvfb exists. It checks:
// - Vector's window loads this computer and refuses an internet page no part of Vector labelled, before the request;
// - with Web access None, Vector's window reaches a Vector server on your network with the app's own requests, and an
//   image a reply would show there loads nothing;
// - every web contents keeps WebRTC off UDP, a window opened before Vector Local was turned on included;
// - the agent's browser follows Web access (Ask loads a page and what it loads, None refuses it and still loads this
//   computer), and neither its pages, the frames they make (a blank frame in a frame of another site included) nor
//   their dedicated workers have RTCPeerConnection or WebTransport, while shared and service workers still start (a
//   note line says they keep WebTransport);
// - the network log counts a page once and what it loaded once per host, and the counters leave the page's own host
//   out of the other hosts;
// - the updater's session (electron-updater's net.request) reaches the dispatcher: an automatic check is refused
//   before it reaches the network, and a check the person asked for reaches the feed;
// - a session Electron makes later gets the dispatcher;
// - a window's own step runs after Vector Local's decision and never sees a request it refused.
// It is the scripted half of Gate L2; the packet capture compared with the network log is the other. What Chromium
// sends below the dispatcher is listed in the registry (LocalSources, chromium-network).

import { existsSync, readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Check } from "./local-mode-smoke-electron"

const MARK = "local-smoke "
const LIMIT_MS = 120_000

const require = createRequire(import.meta.url)
const directory = path.dirname(require.resolve("electron/package.json"))
const recorded = path.join(directory, "path.txt")
const executable = existsSync(recorded)
  ? readFileSync(recorded, "utf8").trim()
  : process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32"
      ? "electron.exe"
      : "electron"
const dist =
  process.env.ELECTRON_OVERRIDE_DIST_PATH ?? (existsSync(recorded) ? path.join(directory, "dist") : undefined)
const binary = dist ? path.join(dist, executable) : undefined
if (!binary || !existsSync(binary)) {
  console.error("Electron's binary is not installed in this checkout, so the Vector Local smoke cannot run.")
  process.exit(2)
}
const out = await mkdtemp(path.join(tmpdir(), "vector-local-smoke-"))
const built = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "local-mode-smoke-electron.ts")],
  target: "node",
  format: "esm",
  outdir: out,
  naming: "[name].mjs",
  external: ["electron"],
})
if (!built.success) throw new AggregateError(built.logs, "The Vector Local smoke did not bundle")
const child = Bun.spawn([binary, path.join(out, "local-mode-smoke-electron.mjs")], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
  // No proxy or Vector Local setting of the machine's own: the smoke sets the policy it checks.
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DISPLAY: process.env.DISPLAY ?? "" },
})
const timer = setTimeout(() => child.kill(), LIMIT_MS)
const stdout = await new Response(child.stdout).text()
await child.exited
clearTimeout(timer)
const line = stdout.split("\n").find((item) => item.startsWith(MARK))
if (!line) {
  console.error(stdout)
  console.error(`The Vector Local smoke printed no result (it stops after ${LIMIT_MS / 1000} seconds).`)
  process.exit(1)
}
const checks = JSON.parse(line.slice(MARK.length)) as Check[]
checks.forEach((check) =>
  console.log(
    `${check.note ? "note" : check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`,
  ),
)
process.exit(checks.every((check) => check.ok) ? 0 : 1)
