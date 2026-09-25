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

  test("migrates unique suffix matches before hydration", () => {
    localStorage.setItem("other-theme-id", "nightowl")
    localStorage.setItem("other-color-scheme", "dark")
    localStorage.setItem("other-theme-css-dark", "--background-base:#abcdef;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(localStorage.getItem("vector-theme-id")).toBe("nightowl")
    expect(localStorage.getItem("other-theme-id")).toBeNull()
    expect(localStorage.getItem("other-color-scheme")).toBeNull()
    expect(localStorage.getItem("other-theme-css-dark")).toBeNull()
    expect(document.getElementById("vector-theme-preload")?.textContent).toContain("--background-base:#abcdef;")
  })

  test("restores an unavailable saved theme as Classic without discarding its cached CSS", () => {
    localStorage.setItem("vector-theme-id", "missing-test-theme")
    localStorage.setItem("vector-color-scheme", "dark")
    localStorage.setItem("vector-theme-css-light", "--background-base:#abcdef;")
    localStorage.setItem("vector-theme-css-dark", "--background-base:#123456;")

    run()
    expect(document.getElementById("vector-theme-preload")?.textContent).toContain("--background-base:#123456;")

    expect(restoreThemePreference((id) => new Set(["vector-modern", "nightowl", "vector"]).has(id))).toBe("vector")
    expect(localStorage.getItem("vector-theme-id")).toBe("vector")
    expect(localStorage.getItem("vector-theme-css-light")).toBe("--background-base:#abcdef;")
    expect(localStorage.getItem("vector-theme-css-dark")).toBe("--background-base:#123456;")
    expect(document.getElementById("vector-theme-preload")?.textContent).toContain("--background-base:#123456;")
    expect(localStorage.getItem("vector-color-scheme")).toBe("dark")

    run()
    expect(document.documentElement.dataset.theme).toBe("vector")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.getElementById("vector-theme-preload")?.textContent).toContain("--background-base:#123456;")
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

for (const initialize of [
  run,
  () => restoreThemePreference((id) => ["vector", "vector-modern", "nightowl"].includes(id)),
]) {
  describe(initialize === run ? "preload migration" : "provider migration", () => {
    for (const id of ["oc-1", "oc-2"]) {
      test(`maps ${id} to Modern`, () => {
        localStorage.setItem("previous-theme-id", id)
        localStorage.setItem("previous-color-scheme", "dark")
        initialize()
        expect(localStorage.getItem("vector-theme-id")).toBe("vector-modern")
        expect(localStorage.getItem("vector-color-scheme")).toBe("dark")
        expect(localStorage.getItem("previous-theme-id")).toBeNull()
      })
    }

    test("copies light and dark cached CSS and retains current Vector choices on later loads", () => {
      localStorage.setItem("previous-theme-id", "nightowl")
      localStorage.setItem("previous-color-scheme", "system")
      localStorage.setItem("previous-theme-css-light", "--background-base:#fefefe;")
      localStorage.setItem("previous-theme-css-dark", "--background-base:#101010;")
      initialize()
      expect(localStorage.getItem("vector-theme-id")).toBe("nightowl")
      expect(localStorage.getItem("vector-color-scheme")).toBe("system")
      expect(localStorage.getItem("vector-theme-css-light")).toBe("--background-base:#fefefe;")
      expect(localStorage.getItem("vector-theme-css-dark")).toBe("--background-base:#101010;")
      expect(localStorage.getItem("previous-theme-css-light")).toBeNull()
      expect(localStorage.getItem("previous-theme-css-dark")).toBeNull()
      localStorage.setItem("previous-theme-id", "oc-2")
      localStorage.setItem("previous-color-scheme", "light")
      initialize()
      expect(localStorage.getItem("vector-theme-id")).toBe("nightowl")
      expect(localStorage.getItem("vector-color-scheme")).toBe("system")
      expect(localStorage.getItem("previous-theme-id")).toBe("oc-2")
    })

    test("leaves ambiguous suffix matches untouched", () => {
      localStorage.setItem("first-theme-id", "nightowl")
      localStorage.setItem("second-theme-id", "oc-2")
      initialize()
      expect(localStorage.getItem("vector-theme-id")).toBeNull()
      expect(localStorage.getItem("first-theme-id")).toBe("nightowl")
      expect(localStorage.getItem("second-theme-id")).toBe("oc-2")
    })
  })
}
