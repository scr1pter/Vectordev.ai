import { expect, test } from "bun:test"

test("web shell declares a restrictive CSP and no-referrer policy", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text()
  expect(html).toContain('name="referrer" content="no-referrer"')
  expect(html).toContain("default-src 'self'")
  expect(html).toContain("object-src 'none'")
  expect(html).toContain("frame-src 'none'")
  expect(html).not.toContain("frame-ancestors")
  expect(html).toContain("'wasm-unsafe-eval'")
  expect(html).toContain("img-src 'self' data: blob:")
  expect(html).toContain("media-src 'self' data: blob:")
  expect(html).not.toContain("img-src https:")
})
