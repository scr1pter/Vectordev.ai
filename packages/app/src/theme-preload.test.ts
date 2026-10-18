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
  test("paints Vector's dark look before hydration whatever an earlier version saved", () => {
    localStorage.setItem("vector-theme-id", "nightowl")
    localStorage.setItem("vector-color-scheme", "light")
    localStorage.setItem("vector-theme-css-light", "--background-base:#fefefe;")
    localStorage.setItem("vector-theme-css-dark", "--background-base:#123456;")
    document.head.innerHTML = '<meta name="theme-color" content="#fafafa">'

    run()

    expect(document.documentElement.dataset.theme).toBe("vector-modern")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.documentElement.style.backgroundColor).toBe("#080808")
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#080808")
    // No cached theme CSS is painted, and none is left for a later launch to paint.
    expect(document.getElementById("vector-theme-preload")).toBeNull()
    expect(localStorage.getItem("vector-theme-css-light")).toBeNull()
    expect(localStorage.getItem("vector-theme-css-dark")).toBeNull()
  })

  test("a Match system scheme on a light computer still starts dark", () => {
    localStorage.setItem("vector-color-scheme", "system")
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ matches: query.includes("light") }) as MediaQueryList,
      configurable: true,
    })

    run()

    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.documentElement.style.backgroundColor).toBe("#080808")
  })

  test("leaves the theme provider the same dark Vector theme to restore", () => {
    localStorage.setItem("vector-theme-id", "dracula")
    localStorage.setItem("vector-color-scheme", "light")
    // Another app's saved theme, which the provider's one-time migration would otherwise copy in.
    localStorage.setItem("previous-theme-id", "vector-modern")
    localStorage.setItem("previous-color-scheme", "light")

    run()

    expect(localStorage.getItem("vector-theme-id")).toBe("vector-modern")
    expect(localStorage.getItem("vector-color-scheme")).toBe("dark")
    expect(restoreThemePreference((id) => ["vector-modern", "dracula"].includes(id))).toBe("vector-modern")
    expect(localStorage.getItem("vector-color-scheme")).toBe("dark")
  })

  test("still paints dark when storage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("blocked")
      },
      configurable: true,
    })
    try {
      run()
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original)
    }

    expect(document.documentElement.dataset.theme).toBe("vector-modern")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
  })
})

// The provider's own migration, for a page without the preload. The app's pages always run the preload first.
{
  const initialize = () => restoreThemePreference((id) => ["vector", "vector-modern", "nightowl"].includes(id))
  describe("provider migration", () => {
    for (const id of ["oc-1", "oc-2"]) {
      test(`maps ${id} to Modern`, () => {
        localStorage.setItem("previous-theme-id", id)
        localStorage.setItem("previous-color-scheme", "dark")
        initialize()
        expect(localStorage.getItem("vector-theme-id")).toBe("vector-modern")
        expect(localStorage.getItem("vector-color-scheme")).toBe("dark")
        expect(localStorage.getItem("previous-theme-id")).toBe(id)
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
      expect(localStorage.getItem("previous-theme-css-light")).toBe("--background-base:#fefefe;")
      expect(localStorage.getItem("previous-theme-css-dark")).toBe("--background-base:#101010;")
      localStorage.setItem("previous-theme-id", "oc-2")
      localStorage.setItem("previous-color-scheme", "light")
      initialize()
      expect(localStorage.getItem("vector-theme-id")).toBe("nightowl")
      expect(localStorage.getItem("vector-color-scheme")).toBe("system")
      expect(localStorage.getItem("previous-theme-id")).toBe("oc-2")
    })

    test("never combines unrelated preference families or overwrites a current selection", () => {
      localStorage.setItem("earlier-theme-id", "nightowl")
      localStorage.setItem("unrelated-color-scheme", "dark")
      localStorage.setItem("unrelated-theme-css-dark", "--background-base:red;")
      initialize()
      expect(localStorage.getItem("vector-theme-id")).toBe("nightowl")
      expect(localStorage.getItem("vector-color-scheme")).toBeNull()
      expect(localStorage.getItem("vector-theme-css-dark")).toBeNull()
      expect(localStorage.getItem("vector-theme-migration")).toBe("1")
      localStorage.setItem("earlier-theme-css-dark", "--background-base:blue;")
      initialize()
      expect(localStorage.getItem("vector-theme-css-dark")).toBeNull()
      localStorage.clear()
      localStorage.setItem("vector-theme-id", "vector-modern")
      localStorage.setItem("earlier-theme-id", "nightowl")
      localStorage.setItem("earlier-color-scheme", "dark")
      initialize()
      expect(localStorage.getItem("vector-theme-id")).toBe("vector-modern")
      expect(localStorage.getItem("vector-color-scheme")).toBeNull()
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
