import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The session header's branch chip is a quiet neutral chip, the same surface and type as the
// status chip beside it. On 15 October the owner asked for the violet reference colours added on
// 9 October to go and for the branches button to look as it did before, so this pins that look.
const css = ["../../vector-premium.css", "./branch-picker.css"]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n")

const HEADER = `<header data-vector-session-header>
  <span id="branch" data-vector-session-branch>main</span>
  <button id="picker" type="button" data-vector-session-branch data-vector-branch-picker>main</button>
  <button id="open" type="button" data-vector-session-branch data-vector-branch-picker data-expanded>main</button>
  <button id="busy" type="button" data-vector-session-branch data-vector-branch-picker aria-busy="true">main</button>
  <span id="status" data-vector-session-status>Ready</span>
</header>`

function mount(theme: "dark" | "light") {
  if (theme === "light") document.documentElement.dataset.vectorTheme = "light"
  const style = document.createElement("style")
  style.dataset.branchChipTest = ""
  style.textContent = css
  document.head.append(style)
  document.body.innerHTML = HEADER
}

function chip(id: string) {
  const style = getComputedStyle(document.getElementById(id)!)
  return { background: style.backgroundColor, color: style.color, border: style.borderTopColor }
}

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

afterEach(() => {
  document.head.querySelectorAll("style[data-branch-chip-test]").forEach((style) => style.remove())
  document.body.innerHTML = ""
  delete document.documentElement.dataset.vectorTheme
})

describe("session header branch chip", () => {
  test.each(["dark", "light"] as const)("matches the neutral status chip in the %s theme", (theme) => {
    mount(theme)
    expect(chip("status").color).toBe(token("--vx-workspace-text-secondary"))
    expect(chip("branch")).toEqual(chip("status"))
    expect(chip("picker")).toEqual(chip("status"))
  })

  test.each(["dark", "light"] as const)("stays neutral while open or switching in the %s theme", (theme) => {
    mount(theme)
    expect(chip("open").color).toBe(token("--vx-text"))
    expect(chip("open").border).toBe(token("--vx-line-strong"))
    expect(chip("busy").color).toBe(token("--vx-text-muted"))
  })

  test("has no reference-only violet palette to fall back on", () => {
    mount("dark")
    expect(css.includes("--vx-ref-")).toBe(false)
    expect(token("--vx-ref-surface")).toBe("")
    expect(token("--vx-ref-text")).toBe("")
  })
})
