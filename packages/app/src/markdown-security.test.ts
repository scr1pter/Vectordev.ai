import { describe, expect, test } from "bun:test"
import { sanitizeMarkdown } from "@vectordevai/session-ui/markdown-cache"

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
