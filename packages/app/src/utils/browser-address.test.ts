import { describe, expect, test } from "bun:test"

import { resolveBrowserAddress, selectUnambiguousPreviewUrl } from "./browser-address"

describe("resolveBrowserAddress", () => {
  test("keeps full web URLs", () => {
    expect(resolveBrowserAddress("https://vector.dev/docs?q=1")).toBe("https://vector.dev/docs?q=1")
  })

  test("opens local development servers over http", () => {
    expect(resolveBrowserAddress("localhost:5173/app")).toBe("http://localhost:5173/app")
    expect(resolveBrowserAddress("127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
  })

  test("opens domain-like input as a website", () => {
    expect(resolveBrowserAddress("github.com/vector/example")).toBe("https://github.com/vector/example")
  })

  test("searches normal words and incomplete host-like input", () => {
    expect(resolveBrowserAddress("best TypeScript formatter")).toBe(
      "https://www.google.com/search?q=best%20TypeScript%20formatter",
    )
    expect(resolveBrowserAddress("vector browser agent")).toBe(
      "https://www.google.com/search?q=vector%20browser%20agent",
    )
  })
})

describe("selectUnambiguousPreviewUrl", () => {
  test("selects the only live local server", () => {
    expect(
      selectUnambiguousPreviewUrl([
        { candidate: "http://localhost:3000", ok: false },
        { candidate: "http://localhost:4173", ok: true },
      ]),
    ).toBe("http://localhost:4173")
  })

  test("does not guess when multiple local servers are running", () => {
    expect(
      selectUnambiguousPreviewUrl([
        { candidate: "http://localhost:4173", ok: true },
        { candidate: "http://localhost:8080", ok: true },
      ]),
    ).toBeUndefined()
  })
})
