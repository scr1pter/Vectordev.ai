// Build-time half of the launch screen, used by the shared Vite plugin in
// packages/app/vite.js (web app and desktop renderer alike) and by the tests.
// It inlines the CSS and the compiled host script right after the theme
// preload script, and the markup (the icon's glyph in it as a data: URI)
// right after <body>, so the glass and the icon are on the first painted frame
// with no request and no edit to either index.html.

import { readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))

export const LAUNCH_FILES = {
  css: here("launch-screen.css"),
  markup: here("launch-screen.html"),
  glyph: here("launch-glyph.webp"),
  host: here("launch-host.ts"),
  state: here("launch-state.ts"),
}

// The emblem's <img src>. launch-glyph.webp is the app icon's chip, and the
// contact shadow it casts on the icon's body, keyed out of the icon's own art
// (packages/desktop/icons/prod/icon.png, the master of icon.icns): the
// glyph's pixels exactly as the Dock shows them, over transparency. The body
// is see-through glass drawn by launch-screen.css, which also draws the
// icon's soft drop shadow. macOS 26 draws this art scaled into its squircle
// (the body box of an NSWorkspace render is the whole art at 824/1024), so
// the asset maps onto the body one to one.
// make-launch-glyph.py, next to it, makes it, and its header holds the
// recipe. After a new app icon, run
// `python3 packages/app/src/features/launch/make-launch-glyph.py`; `--check`
// confirms the committed file is current. The tests pin the app icon's
// hashes, so a new icon fails them until the file is remade.
// 256px (8.5KB, 11KB as base64) covers the largest raster on a 2x display:
// 112px x 1.08 in the exit zoom x 2 is about 242px, and nothing else scales
// it. At 3x (Windows and Linux at 250-300% scaling, or a zoomed web app) it
// is upsampled about 1.4x and softens a little. 336px would cover that, but
// at 11.2KB it is over the 10KB inline budget, and a second data: URI for
// srcset would double the inline bytes.
const GLYPH_SLOT = "<!--vector-launch-glyph-->"
const PRELOAD = /<script id="oc-theme-preload-script"[^>]*>[\s\S]*?<\/script>/
const BODY = /<body\b[^>]*>/
// A CSS comment, or a quoted string to keep as it is. Leftmost match wins, so
// a "/*" inside a string is never read as a comment and an apostrophe inside
// a comment never as a string.
const CSS_COMMENT = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\/\*[\s\S]*?\*\//g

/**
 * The launch CSS as inlined into every index.html: the source's comments (a
 * third of its bytes) and the blank lines they leave go; nothing else.
 * @param {string} css
 * @returns {string}
 */
export function stripCssComments(css) {
  return css.replace(CSS_COMMENT, (_, string) => string ?? "").replace(/\n\s*\n/g, "\n")
}

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
 * Read (and cache by mtime) the CSS, the markup with the icon inlined as a
 * data: URI, and the compiled host script.
 * @returns {{ css: string, markup: string, script: string }}
 */
export function readLaunchParts() {
  const key = Object.values(LAUNCH_FILES)
    .map((file) => statSync(file).mtimeMs)
    .join(":")
  if (cache && cache.key === key) return cache.parts
  const glyph = `data:image/webp;base64,${readFileSync(LAUNCH_FILES.glyph).toString("base64")}`
  const parts = {
    css: stripCssComments(readFileSync(LAUNCH_FILES.css, "utf8")),
    markup: readFileSync(LAUNCH_FILES.markup, "utf8")
      .trim()
      .replace(GLYPH_SLOT, () => glyph),
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
