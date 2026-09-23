import { beforeEach, describe, expect, test } from "bun:test"
import { restoreThemePreference } from "@vectordevai/ui/theme/context"

const src = await Bun.file(new URL("../public/vector-theme-preload.js", import.meta.url)).text()
const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: false }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("reads Vector theme, scheme, and cached CSS before hydration", () => {
    localStorage.setItem("vector-theme-id", "nightowl")
    localStorage.setItem("vector-color-scheme", "dark")
    localStorage.setItem("vector-theme-css-dark", "--background-base:#123456;")
    document.head.innerHTML = '<meta name="theme-color" content="#fafafa">'

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.documentElement.style.backgroundColor).toBe("#080808")
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#080808")
    expect(document.getElementById("vector-theme-preload")?.textContent).toContain("--background-base:#123456;")
  })

  test("uses defaults without reading a different app's preferences", () => {
    localStorage.setItem("other-theme-id", "nightowl")
    localStorage.setItem("other-color-scheme", "dark")
    localStorage.setItem("other-theme-css-dark", "--background-base:#abcdef;")

    run()

    expect(document.documentElement.dataset.theme).toBe("vector-modern")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("vector-theme-id")).toBeNull()
    expect(document.getElementById("vector-theme-preload")).toBeNull()
  })

  test("recovers an unavailable saved theme and removes its preloaded and cached CSS", () => {
    localStorage.setItem("vector-theme-id", "missing-test-theme")
    localStorage.setItem("vector-color-scheme", "dark")
    localStorage.setItem("vector-theme-css-light", "--background-base:#abcdef;")
    localStorage.setItem("vector-theme-css-dark", "--background-base:#123456;")

    run()
    expect(document.getElementById("vector-theme-preload")?.textContent).toContain("--background-base:#123456;")

    expect(restoreThemePreference((id) => new Set(["vector-modern", "nightowl"]).has(id))).toBe("vector-modern")
    expect(localStorage.getItem("vector-theme-id")).toBe("vector-modern")
    expect(localStorage.getItem("vector-theme-css-light")).toBeNull()
    expect(localStorage.getItem("vector-theme-css-dark")).toBeNull()
    expect(document.getElementById("vector-theme-preload")).toBeNull()
    expect(localStorage.getItem("vector-color-scheme")).toBe("dark")

    run()
    expect(document.documentElement.dataset.theme).toBe("vector-modern")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.getElementById("vector-theme-preload")).toBeNull()
  })

  test("preserves an available saved theme and its preload while the theme loads", () => {
    localStorage.setItem("vector-theme-id", "nightowl")
    localStorage.setItem("vector-theme-css-light", "--background-base:#abcdef;")
    run()

    expect(restoreThemePreference((id) => new Set(["vector-modern", "nightowl"]).has(id))).toBe("nightowl")
    expect(localStorage.getItem("vector-theme-id")).toBe("nightowl")
    expect(localStorage.getItem("vector-theme-css-light")).toBe("--background-base:#abcdef;")
    expect(document.getElementById("vector-theme-preload")?.textContent).toContain("--background-base:#abcdef;")
  })
})
