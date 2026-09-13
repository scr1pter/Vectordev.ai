import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { injectLaunchScreen, LAUNCH_FILES, readLaunchParts, stripCssComments } from "./launch-inject.js"
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
const glyph = readFileSync(LAUNCH_FILES.glyph)
const GLYPH_URI = `data:image/webp;base64,${glyph.toString("base64")}`

// Every rule in a stylesheet as [selector, declarations], @media wrappers
// peeled off (the innermost block wins, which is the rule itself).
const rules = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (match) => [match[1].trim(), match[2]] as const,
  )

// Every URL in a page: src and href attributes, and CSS url()s, quoted or not.
// The grain's data: SVG holds a url() of its own; the outer match takes it whole.
const urls = (html: string) => [
  ...[...html.matchAll(/\s(?:src|href)=(["'])(.*?)\1/g)].map((match) => match[2]),
  ...[...html.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)].map((match) => match[2]),
]

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
      expect(out).not.toContain("<!--vector-launch-glyph-->")
      expect(out).toContain(`<img class="vector-launch-glyph" src="${GLYPH_URI}"`)
      expect(out.match(/data:image\/webp;base64,/g)).toHaveLength(1)
    })
  }

  test("embeds the glyph exactly once, as a data: URI of launch-glyph.webp's own bytes", () => {
    const out = injectLaunchScreen(desktop, parts)
    const embedded = [...out.matchAll(/data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})/g)]
    expect(embedded).toHaveLength(1)
    const [, mime, base64] = embedded[0]
    expect(mime).toBe("image/webp")
    expect(Buffer.from(base64, "base64").equals(glyph)).toBe(true)
    // It lives in the emblem's <img>; the CSS never repeats it.
    expect(parts.css).not.toContain(";base64,")
  })

  test("launch-glyph.webp is a 256px WebP with alpha, small enough to inline", () => {
    expect(glyph.toString("latin1", 0, 4)).toBe("RIFF")
    expect(glyph.toString("latin1", 8, 12)).toBe("WEBP")
    // VP8X, the extended header: lossy WebP needs it to carry alpha.
    expect(glyph.toString("latin1", 12, 16)).toBe("VP8X")
    expect(glyph[20] & 0x10).toBe(0x10)
    expect(glyph.readUIntLE(24, 3) + 1).toBe(256)
    expect(glyph.readUIntLE(27, 3) + 1).toBe(256)
    // A budget, so a PNG or a full-size export never slips into every
    // index.html.
    expect(glyph.length).toBeLessThan(10 * 1024)
  })

  // The body is see-through glass drawn in CSS, and it never frosts live:
  // a backdrop-filter on the emblem would re-render what is behind it on
  // every frame of the halo's loop. The only live frost is the full-window
  // glass, and only while revealing (the performance note in the CSS).
  test("only the revealing glass has a backdrop-filter; the emblem has none", () => {
    const frosted = rules(parts.css).filter(([, body]) =>
      [...body.matchAll(/(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;]+)/g)].some((m) => m[1].trim() !== "none"),
    )
    expect(frosted.length).toBeGreaterThan(0)
    for (const [selector] of frosted) {
      expect(selector).toContain('.vector-launch[data-state="revealing"]')
      expect(selector).toMatch(/\.vector-launch-glass$/)
    }
    const emblem = rules(parts.css).filter(([selector]) =>
      /vector-launch-(?:emblem|halo|tile|glyph|gloss|sheen)/.test(selector),
    )
    expect(emblem.length).toBeGreaterThan(0)
    for (const [, body] of emblem) expect(body).not.toMatch(/backdrop-filter/)
  })

  // launch-glyph.webp is keyed out of the macOS app icon's art by
  // make-launch-glyph.py, so nothing else would notice a new app icon: the
  // launch screen would quietly keep showing the old logo.
  test("launch-glyph.webp is still made from the current macOS app icon", () => {
    // The failure message below sends people to the generator: keep it here.
    expect(existsSync(new URL("./make-launch-glyph.py", import.meta.url))).toBe(true)
    const sources = {
      // what macOS renders for Vector.app (byte-identical in the installed app)
      "icon.icns": "b92a1195dcecc1ea470c337d25c8351642c0c299510b816ed7a0f31a6a97feb1",
      // the master it is built from
      "icon.png": "b74ece31ee32c900b692da67abcd80d571154ec41a31a409ae176580364a6c0e",
    }
    for (const [name, sha256] of Object.entries(sources)) {
      const bytes = readFileSync(new URL(`../../../../desktop/icons/prod/${name}`, import.meta.url))
      expect(
        createHash("sha256").update(bytes).digest("hex"),
        `packages/desktop/icons/prod/${name} changed: remake launch-glyph.webp with \`python3 packages/app/src/features/launch/make-launch-glyph.py\`, look at the launch screen, then update this hash`,
      ).toBe(sha256)
    }
  })

  test("needs no request: every URL in the launch markup and CSS is a data: URI", () => {
    const kinds = urls(parts.markup + parts.css).map((url) => url.slice(0, url.indexOf(",")))
    expect(kinds).toEqual(["data:image/webp;base64", "data:image/svg+xml"])
  })

  // The inlined copy drops the source's comments (a third of its bytes) and
  // nothing else: every rule and every URL survive as written.
  test("inlines the CSS without its comments, every rule intact", () => {
    const source = readFileSync(LAUNCH_FILES.css, "utf8")
    const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, "")
    const flat = (css: string) =>
      rules(css).map(([selector, body]) => [selector.replace(/\s+/g, " "), body.replace(/\s+/g, " ").trim()])
    expect(source).toContain("/*")
    expect(parts.css).not.toMatch(/\/\*|\*\//)
    expect(flat(parts.css)).toEqual(flat(uncommented))
    expect(urls(parts.css)).toEqual(urls(uncommented))
    // Strings are kept whole, whatever they hold; comments go, whatever they hold.
    expect(stripCssComments(`a{content:"/* kept */"}\n/* it's gone */\n\nb{c:'x/*y'}`)).toBe(
      `a{content:"/* kept */"}\nb{c:'x/*y'}`,
    )
  })

  // The sheen is a glint on the glass, never on the solid chip: its clip comes
  // before the glyph, and both paint as positioned z-index:auto children of
  // the tile, in markup order.
  test("the sheen passes under the glyph", () => {
    const tile = parts.markup.slice(parts.markup.indexOf('class="vector-launch-tile"'))
    const gloss = tile.indexOf('class="vector-launch-gloss"')
    expect(gloss).toBeGreaterThan(-1)
    expect(gloss).toBeLessThan(tile.indexOf('class="vector-launch-glyph"'))
    const body = (selector: string) =>
      rules(parts.css)
        .filter(([s]) => s === selector)
        .map(([, b]) => b)
        .join(";")
    expect(body(".vector-launch-glyph")).toMatch(/position:\s*relative/)
    expect(body(".vector-launch-gloss")).toMatch(/position:\s*absolute/)
    for (const selector of [".vector-launch-glyph", ".vector-launch-gloss"])
      expect(body(selector)).not.toMatch(/z-index/)
  })

  test("the launch script runs before the app's module script", () => {
    const out = injectLaunchScreen(built, parts)
    expect(out.indexOf('<script id="vector-launch-script">')).toBeLessThan(out.indexOf('<script type="module"'))
  })

  test("adds no root-relative src, href or url() (the Electron oc:// rule in html.test.ts)", () => {
    const out = injectLaunchScreen(desktop, parts)
    const refs = urls(out)
    expect(refs).toContain(GLYPH_URI)
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
