#!/usr/bin/env bun
// Vector Local's Chromium filter in the real Electron (plan section 4.3.6): what only Chromium can show, which the
// desktop's unit tests (Bun, with Electron mocked) cannot. Run it from packages/desktop:
//
//   bun scripts/local-mode-smoke.ts
//
// It bundles local-mode-smoke-electron.ts for Node and starts the pinned Electron binary on the bundle, which serves a
// small web of its own on 127.0.0.1 and reaches no other host. It needs Electron's binary (the desktop's install
// downloads it) and a display; on macOS it runs by hand, and in CI wherever xvfb exists. It checks:
// - Vector's window loads this computer and refuses an internet page no part of Vector labelled, before the request;
// - every web contents keeps WebRTC to the proxy;
// - the agent's browser follows Web access (Ask loads a page and what it loads, None refuses it and still loads this
//   computer), and its pages have no RTCPeerConnection (a frame a page's script makes is reported, not checked);
// - the network log counts a page once and what it loaded once per host;
// - a session Electron makes later gets the dispatcher;
// - a window's own step runs after Vector Local's decision and never sees a request it refused.
// It is the scripted half of Gate L2; the packet capture compared with the network log is the other.

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
const binary = existsSync(recorded) ? path.join(directory, "dist", readFileSync(recorded, "utf8").trim()) : undefined
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
