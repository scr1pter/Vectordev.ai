import { describe, expect, test } from "bun:test"
import { isSettingsTab } from "@/components/settings-v2/settings-registry"
import { createSpotlightSteps } from "./spotlight-steps"

const noop = () => {}
const steps = createSpotlightSteps({
  goHome: noop,
  ensureWorkspace: noop,
  showSidebar: noop,
  goCloud: noop,
  openSettingsDialog: noop,
  closeSettingsDialog: noop,
})

describe("spotlight tour", () => {
  // A step whose page is gone waits for its target and then skips, which stalls the tour.
  test("every Settings step points at a page Settings still has", () => {
    const tabs = steps.flatMap((step) =>
      typeof step.target === "string"
        ? [...step.target.matchAll(/tabs-v2-trigger"\]\[data-value="([^"]+)"/g)].map((match) => match[1])
        : [],
    )
    expect(tabs).toEqual(["providers", "models", "usage", "servers"])
    for (const tab of tabs) expect(isSettingsTab(tab)).toBe(true)
  })

  test("never mentions the removed Appearance, Editor, Chat or Project rules pages", () => {
    for (const step of steps) {
      const copy = [step.title, step.body, step.tip ?? ""].join(" ")
      expect(copy).not.toMatch(/appearance|Editor and Chat|Project rules|Keybinds/i)
    }
  })
})
