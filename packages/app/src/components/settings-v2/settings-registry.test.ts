import { describe, expect, test } from "bun:test"
import { filterSettingsGroups, isSettingsTab, settingsGroups, settingsItemCount } from "./settings-registry"

describe("settings registry", () => {
  test("keeps every settings page reachable", () => {
    expect(settingsItemCount(settingsGroups)).toBe(16)
    expect(settingsGroups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "general",
      "usage",
      "billing",
      "appearance",
      "voice",
      "personalization",
      "subagents",
      "providers",
      "models",
      "servers",
      "rules",
      "editor",
      "chat",
      "notifications",
      "accessibility",
      "about",
    ])
  })

  test("searches labels, categories, and feature vocabulary", () => {
    expect(filterSettingsGroups("BYOK").flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "providers",
    ])
    expect(filterSettingsGroups("update").flatMap((group) => group.items.map((item) => item.value))).toEqual(["about"])
    expect(filterSettingsGroups("memory").flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "general",
      "personalization",
    ])
  })

  test("returns the complete registry for whitespace", () => {
    expect(filterSettingsGroups("   ")).toBe(settingsGroups)
  })

  test("validates tab values before navigation", () => {
    expect(isSettingsTab("providers")).toBe(true)
    expect(isSettingsTab("canvas")).toBe(false)
  })
})
