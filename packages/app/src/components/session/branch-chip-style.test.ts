import { afterEach, describe, expect, test } from "bun:test"

// The session header's branch chip is a quiet neutral chip, the same surface and type as the
// status chip beside it. On 15 October the owner asked for the violet reference colours added on
// 9 October to go and for the branches button to look as it did before, so this pins that look.
const [premium, picker] = await Promise.all(
  ["../../vector-premium.css", "./branch-picker.css"].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
)
const css = `${premium}\n${picker}`

const ROUTE = `<div data-vector-session-route>
  <header id="header" data-vector-session-header>
    <span id="title" data-vector-session-title>Fix the scroll state</span>
    <span id="branch" data-vector-session-branch>main</span>
    <button id="picker" type="button" data-vector-session-branch data-vector-branch-picker>main</button>
    <button id="open" type="button" data-vector-session-branch data-vector-branch-picker data-expanded>main</button>
    <button id="busy" type="button" data-vector-session-branch data-vector-branch-picker aria-busy="true">main</button>
    <span id="status" data-vector-session-status>Ready</span>
    <button type="button" data-vector-session-tool>Changes <span id="count" data-vector-session-count>3</span></button>
  </header>
  <div id="title-bar" data-session-title></div>
</div>`

function mount(theme: "dark" | "light") {
  if (theme === "light") document.documentElement.dataset.vectorTheme = "light"
  const style = document.createElement("style")
  style.dataset.branchChipTest = ""
  style.textContent = css
  document.head.append(style)
  document.body.innerHTML = ROUTE
}

function chip(id: string) {
  const style = getComputedStyle(document.getElementById(id)!)
  return { background: style.backgroundColor, color: style.color, border: style.borderTopColor }
}

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// WCAG contrast of an element's text against what is behind it: its own background laid over the
// header's. Only plain hex and rgb()/rgba() values resolve here; happy-dom drops color-mix()
// declarations, so the open chip is measured on the resting chip's fill, not its 6% text-colour tint.
function contrast(id: string) {
  const style = getComputedStyle(document.getElementById(id)!)
  const behind = over(
    rgba(style.backgroundColor),
    rgba(getComputedStyle(document.getElementById("header")!).backgroundColor),
  )
  const [light, dark] = [luminance(over(rgba(style.color), behind)), luminance(behind)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

function rgba(value: string) {
  if (value.startsWith("#")) return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)).concat(1)
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]
  return parts.length === 3 ? parts.concat(1) : parts
}

function over(top: number[], under: number[]) {
  return top
    .slice(0, 3)
    .map((channel, index) => channel * top[3] + under[index] * (1 - top[3]))
    .concat(1)
}

function luminance(color: number[]) {
  const [r, g, b] = color
    .slice(0, 3)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
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

  test("tints the hover and open background with the text colour, not a violet", () => {
    // happy-dom drops color-mix(), so the computed style cannot show this fill; read the rule itself.
    const rule = picker.match(/button\[data-vector-branch-picker\]\[data-expanded\]\s*\{([^}]*)\}/)?.[1]
    expect(rule).toContain("background: color-mix(in srgb, var(--vx-text) 6%, transparent)")
    expect(rule).not.toMatch(/purple|--vx-ref-/)
  })

  test("has no reference-only violet palette to fall back on", () => {
    mount("dark")
    expect(css.includes("--vx-ref-")).toBe(false)
    expect(token("--vx-ref-surface")).toBe("")
    expect(token("--vx-ref-text")).toBe("")
  })
})

describe("session header readability", () => {
  test("takes the light stage colour in the light theme", () => {
    mount("light")
    expect(chip("header").background).toBe(token("--vx-stage"))
    expect(chip("title-bar").background).toBe(token("--vx-stage"))
    expect(getComputedStyle(document.querySelector("[data-vector-session-route]")!).backgroundColor).toBe(
      token("--vx-canvas"),
    )
  })

  test.each(["dark", "light"] as const)("keeps header text at 4.5:1 or better in the %s theme", (theme) => {
    mount(theme)
    expect(["title", "branch", "picker", "open", "status", "count"].filter((id) => contrast(id) < 4.5)).toEqual([])
  })

  test.each(["dark", "light"] as const)("dims the switching chip without losing it in the %s theme", (theme) => {
    mount(theme)
    // The switching state uses --vx-text-muted, as it did before 9 October. On the chip that measures
    // 4.0:1 in the dark theme and 3.8:1 in the light one, under 4.5:1 in both, so this only holds it
    // dimmer than the resting chip and above the 3:1 floor for a component state.
    expect(contrast("busy")).toBeLessThan(contrast("picker"))
    expect(contrast("busy")).toBeGreaterThanOrEqual(3)
  })
})
