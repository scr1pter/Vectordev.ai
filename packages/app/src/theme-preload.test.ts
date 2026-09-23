import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test.each(["vector", "opencode"])("migrates %s oc-1 to oc-2 before mount", (prefix) => {
    localStorage.setItem(`${prefix}-theme-id`, "oc-1")
    localStorage.setItem("vector-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("vector-theme-css-dark", "--background-base:#000;")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("opencode-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("vector-theme-id")).toBe("oc-2")
    expect(localStorage.getItem("vector-theme-css-light")).toBeNull()
    expect(localStorage.getItem("vector-theme-css-dark")).toBeNull()
    expect(localStorage.getItem("opencode-theme-css-light")).toBeNull()
    expect(localStorage.getItem("opencode-theme-css-dark")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  test("migrates legacy preferences and keeps cached css for non-default themes", () => {
    localStorage.setItem("opencode-theme-id", "nightowl")
    localStorage.setItem("opencode-color-scheme", "light")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("vector-theme-id")).toBe("nightowl")
    expect(localStorage.getItem("vector-color-scheme")).toBe("light")
    expect(localStorage.getItem("vector-theme-css-light")).toBe("--background-base:#fff;")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })

  test("prefers Vector theme, scheme, and cached css over conflicting legacy preferences", () => {
    localStorage.setItem("vector-theme-id", "nightowl")
    localStorage.setItem("vector-color-scheme", "dark")
    localStorage.setItem("vector-theme-css-dark", "--background-base:#123456;")
    localStorage.setItem("opencode-theme-id", "oc-1")
    localStorage.setItem("opencode-color-scheme", "light")
    localStorage.setItem("opencode-theme-css-dark", "--background-base:#abcdef;")
    document.head.innerHTML = '<meta name="theme-color" content="#fafafa">'

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.documentElement.style.backgroundColor).toBe("#080808")
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#080808")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#123456;")
    expect(document.getElementById("oc-theme-preload")?.textContent).not.toContain("#abcdef")
    expect(localStorage.getItem("vector-theme-id")).toBe("nightowl")
  })
})
