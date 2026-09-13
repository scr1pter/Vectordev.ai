import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { injectLaunchScreen, readLaunchParts } from "./launch-inject.js"
import type { LaunchWindow } from "./launch-host"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

// packages/app/index.html after the theme-preload plugin inlined the script.
const web = read("../../../index.html").replace(
  '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
  `<script id="oc-theme-preload-script">${read("../../../public/oc-theme-preload.js")}</script>`,
)
// packages/desktop/src/renderer/index.html keeps the external ./ script.
const desktop = read("../../../../desktop/src/renderer/index.html")
// What a production build hands the post hook: Vite's module script and CSS.
const built = desktop.replace(
  "</head>",
  '<script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="./assets/index-abc.css"></head>',
)

const parts = readLaunchParts()

afterEach(() => {
  ;(window as unknown as LaunchWindow).__vectorLaunch?.dispose()
  document.getElementById("vector-launch")?.remove()
  for (const name of [...document.documentElement.getAttributeNames()])
    if (name.startsWith("data-vector-launch")) document.documentElement.removeAttribute(name)
  document.documentElement.style.removeProperty("--vector-launch-nav")
})

describe("launch screen injection", () => {
  for (const [name, source] of [
    ["web", web],
    ["desktop", desktop],
    ["built", built],
  ] as const) {
    test(`${name}: style and script are inline right after the theme preload, markup before #root`, () => {
      const out = injectLaunchScreen(source, parts)
      const preload = out.indexOf('id="oc-theme-preload-script"')
      const style = out.indexOf('<style id="vector-launch-style">')
      const script = out.indexOf('<script id="vector-launch-script">')
      const overlay = out.indexOf('<div id="vector-launch"')
      const root = out.indexOf('id="root"')
      expect(preload).toBeGreaterThan(-1)
      expect(style).toBeGreaterThan(preload)
      expect(script).toBeGreaterThan(style)
      expect(out.indexOf("</head>")).toBeGreaterThan(script)
      expect(overlay).toBeGreaterThan(out.indexOf("<body"))
      expect(root).toBeGreaterThan(overlay)
      expect(out.match(/id="vector-launch"/g)).toHaveLength(1)
      expect(out).toContain('<script id="vector-launch-script">(')
      expect(out).not.toContain("<!--vector-launch-mark-->")
      expect(out).toContain('<svg class="vector-launch-mark"')
    })
  }

  test("the launch script runs before the app's module script", () => {
    const out = injectLaunchScreen(built, parts)
    expect(out.indexOf('<script id="vector-launch-script">')).toBeLessThan(out.indexOf('<script type="module"'))
  })

  test("adds no root-relative src or href (the Electron oc:// rule in html.test.ts)", () => {
    const out = injectLaunchScreen(desktop, parts)
    const refs = [...out.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1])
    for (const ref of refs) expect(ref).not.toMatch(/^\/[^/]/)
  })

  test("is idempotent", () => {
    const once = injectLaunchScreen(desktop, parts)
    expect(injectLaunchScreen(once, parts)).toBe(once)
  })

  test("never reads $ sequences as replacement patterns", () => {
    const out = injectLaunchScreen(desktop, {
      css: ".x{content:'$&'}",
      script: "var a='$`$1'",
      markup: '<div id="vector-launch">$\'</div>',
    })
    expect(out).toContain(".x{content:'$&'}")
    expect(out).toContain("var a='$`$1'")
    expect(out).toContain('<div id="vector-launch">$\'</div>')
  })

  test("leaves a page without a body alone", () => {
    expect(injectLaunchScreen("<p>hi</p>", parts)).toBe("<p>hi</p>")
  })

  test("the compiled host is one classic script that starts itself", () => {
    expect(parts.script).not.toMatch(/<\/script/i)
    new Function(parts.script)()
    const host = (window as unknown as LaunchWindow).__vectorLaunch
    expect(host?.phase()).toBe("veiled")
    expect(document.documentElement.getAttribute("data-vector-launch")).toBe("veiled")
  })
})
