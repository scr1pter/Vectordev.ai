import { describe, expect, test } from "bun:test"
import path from "path"
import { codeToHtml } from "shiki"
import { sanitizeMarkdown } from "@vectordevai/session-ui/markdown-cache"

// Chat renders math with the session UI's own KaTeX, which the app does not depend on directly.
const katex = (await import(Bun.resolveSync("katex", path.join(import.meta.dir, "../../session-ui")))).default

describe("untrusted Markdown network isolation", () => {
  test("removes elements and attributes that can initiate requests", () => {
    const html = sanitizeMarkdown(`
      <img src="https://attacker.test/pixel" srcset="https://attacker.test/2x 2x">
      <picture><source srcset="https://attacker.test/source"><img src="/pixel"></picture>
      <video src="https://attacker.test/video" poster="https://attacker.test/poster"></video>
      <audio src="https://attacker.test/audio"></audio>
      <iframe src="https://attacker.test/frame"></iframe>
      <object data="https://attacker.test/object"></object>
      <svg><use href="https://attacker.test/icon.svg#x"></use></svg>
      <div style="background:url(https://attacker.test/style)">safe text</div>
    `)

    for (const value of ["attacker.test", "<img", "<source", "<video", "<audio", "<iframe", "<object", "style="]) {
      expect(html).not.toContain(value)
    }
    expect(html).toContain("safe text")
  })

  test("keeps the inline styles KaTeX math and Shiki code need", async () => {
    const math = katex.renderToString("\\frac{a}{b}^2")
    const code = await codeToHtml("const answer = 42", { lang: "ts", theme: "github-light" })

    for (const html of [math, code]) {
      const styles = html.match(/style="[^"]*"/g) ?? []
      expect(styles.length).toBeGreaterThan(0)
      expect(sanitizeMarkdown(html).match(/style="[^"]*"/g) ?? []).toEqual(styles)
    }
  })

  test("removes a style that loads a resource however it is spelled", () => {
    const html = sanitizeMarkdown(`
      <span style="color:#d73a49">kept</span>
      <span style="background-image: image-set('https://attacker.test/a.png' 1x)">set</span>
      <span style="background:u\\72l(https://attacker.test/escaped)">escaped</span>
      <span style="background:&#117;rl(https://attacker.test/entity)">entity</span>
      <span style="cursor:URL (https://attacker.test/cursor), auto">cursor</span>
    `)

    expect(html).toContain('style="color:#d73a49"')
    expect(html).not.toContain("attacker.test")
    expect(html.match(/style=/g)).toHaveLength(1)
    for (const text of ["kept", "set", "escaped", "entity", "cursor"]) expect(html).toContain(text)
  })

  test("keeps only navigable web links and isolates their opener", () => {
    const html = sanitizeMarkdown(`
      <a href="javascript:alert(1)" target="_blank">bad</a>
      <a href="data:text/html,bad">data</a>
      <a href="https://example.test/path">good</a>
    `)

    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("data:text")
    expect(html).toContain('href="https://example.test/path"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain("noopener")
    expect(html).toContain("noreferrer")
  })
})
