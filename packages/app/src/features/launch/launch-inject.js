// Build-time half of the launch screen, used by the shared Vite plugin in
// packages/app/vite.js (web app and desktop renderer alike) and by the tests.
// It inlines the CSS and the compiled host script right after the theme
// preload script, and the markup right after <body>, so the glass is on the
// first painted frame with no request and no edit to either index.html.

import { readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))

export const LAUNCH_FILES = {
  css: here("launch-screen.css"),
  markup: here("launch-screen.html"),
  mark: here("launch-mark.svg"),
  host: here("launch-host.ts"),
  state: here("launch-state.ts"),
}

const MARK_SLOT = "<!--vector-launch-mark-->"
const PRELOAD = /<script id="oc-theme-preload-script"[^>]*>[\s\S]*?<\/script>/
const BODY = /<body\b[^>]*>/

/** @type {{ key: string, parts: { css: string, markup: string, script: string } } | undefined} */
let cache

/**
 * Bundle launch-host.ts and launch-state.ts into one self-starting classic
 * script. Uses the esbuild that Vite itself ships with.
 * @returns {string}
 */
export function compileLaunchHost() {
  const esbuild = createRequire(createRequire(import.meta.url).resolve("vite"))("esbuild")
  const result = esbuild.buildSync({
    stdin: {
      contents: 'import { startLaunchScreen } from "./launch-host"\nstartLaunchScreen()\n',
      resolveDir: dirname(LAUNCH_FILES.host),
      sourcefile: "vector-launch-boot.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2019",
    minify: true,
    write: false,
    charset: "utf8",
    legalComments: "none",
  })
  // Never let a string in the script close the inline <script> early.
  return result.outputFiles[0].text.trim().replace(/<\/(script)/gi, "<\\/$1")
}

/**
 * Read (and cache by mtime) the CSS, the markup with the mark inlined, and the
 * compiled host script.
 * @returns {{ css: string, markup: string, script: string }}
 */
export function readLaunchParts() {
  const key = Object.values(LAUNCH_FILES)
    .map((file) => statSync(file).mtimeMs)
    .join(":")
  if (cache && cache.key === key) return cache.parts
  const mark = readFileSync(LAUNCH_FILES.mark, "utf8").trim()
  const parts = {
    css: readFileSync(LAUNCH_FILES.css, "utf8"),
    markup: readFileSync(LAUNCH_FILES.markup, "utf8")
      .trim()
      .replace(MARK_SLOT, () => mark),
    script: compileLaunchHost(),
  }
  cache = { key, parts }
  return parts
}

/**
 * Inject the launch screen into an index.html. Idempotent. Replacer functions
 * keep `$` sequences in the CSS or script from being read as patterns.
 * @param {string} html
 * @param {{ css: string, markup: string, script: string }} parts
 * @returns {string}
 */
export function injectLaunchScreen(html, parts) {
  if (html.includes('id="vector-launch"') || !BODY.test(html)) return html
  const head = `<style id="vector-launch-style">${parts.css}</style><script id="vector-launch-script">${parts.script}</script>`
  let next
  if (PRELOAD.test(html)) next = html.replace(PRELOAD, (tag) => tag + head)
  else if (html.includes("</head>")) next = html.replace("</head>", () => head + "</head>")
  else return html
  return next.replace(BODY, (tag) => tag + parts.markup)
}
