import { describe, expect, test } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import { dict } from "../../i18n/en"
import { ComputerOnboarding } from "./onboarding-model"

const mac: Computer.PermissionsView = {
  rows: [
    { id: "screen", status: "granted", pane: "untrusted:screen-pane" },
    { id: "accessibility", status: "granted", pane: "untrusted:accessibility-pane" },
  ],
  helperStart: "ok",
  canReset: false,
  adhoc: false,
  vectorHoldsGrant: { screen: false, accessibility: false },
}
const windows: Computer.PermissionsView = {
  ...mac,
  rows: [],
  windows: { captureBlocked: false, elevated: false },
}
const consentedAt = 1_700_000_000_000

describe("computer onboarding eligibility", () => {
  test("Finish requires explicit valid consent even after all permissions are granted", () => {
    for (const consent of [undefined, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ComputerOnboarding.canFinish(mac, consent)).toBe(false)
      expect(ComputerOnboarding.canFinish(windows, consent)).toBe(false)
    }
    expect(ComputerOnboarding.canFinish(mac, consentedAt)).toBe(true)
    expect(ComputerOnboarding.canFinish(windows, consentedAt)).toBe(true)
    expect(ComputerOnboarding.canFinish(undefined, consentedAt)).toBe(false)
  })

  test("macOS needs exactly one granted row for each permission and a healthy helper", () => {
    const views: Computer.PermissionsView[] = [
      { ...mac, rows: [] },
      { ...mac, rows: [mac.rows[0]] },
      { ...mac, rows: [mac.rows[0], mac.rows[0]] },
      { ...mac, rows: [...mac.rows, mac.rows[0]] },
      { ...mac, helperStart: "failed" },
      ...(["denied", "unknown", "reset-after-update"] as const).flatMap((status) =>
        mac.rows.map((_, index) => ({
          ...mac,
          rows: mac.rows.map((row, at) => (at === index ? { ...row, status } : row)),
        })),
      ),
    ]
    for (const view of views) expect(ComputerOnboarding.canFinish(view, consentedAt)).toBe(false)
    expect(ComputerOnboarding.canFinish({ ...mac, rows: [...mac.rows].reverse() }, consentedAt)).toBe(true)
  })

  test("Windows needs explicit clean capture and elevation flags, without macOS grant rows", () => {
    expect(ComputerOnboarding.canFinish(windows, consentedAt)).toBe(true)
    for (const flags of [
      { captureBlocked: true, elevated: false },
      { captureBlocked: false, elevated: true },
      { captureBlocked: true, elevated: true },
    ])
      expect(ComputerOnboarding.canFinish({ ...windows, windows: flags }, consentedAt)).toBe(false)
    expect(ComputerOnboarding.canFinish({ ...windows, helperStart: "failed" }, consentedAt)).toBe(false)
    expect(ComputerOnboarding.canFinish({ ...windows, windows: undefined }, consentedAt)).toBe(false)
    expect(ComputerOnboarding.canFinish({ ...windows, rows: mac.rows }, consentedAt)).toBe(false)
    for (const value of [
      { ...windows, windows: {} },
      { ...windows, windows: { captureBlocked: false } },
      { ...windows, windows: null },
      { ...windows, rows: undefined },
      { ...mac, helperStart: undefined },
      { ...mac, rows: undefined },
    ])
      expect(ComputerOnboarding.canFinish(value as unknown as Computer.PermissionsView, consentedAt)).toBe(false)
  })

  test("main-app grants are warnings and never silently changed or treated as helper grants", () => {
    const view = { ...mac, vectorHoldsGrant: { screen: true, accessibility: true } }
    expect(ComputerOnboarding.canFinish(view, consentedAt)).toBe(true)
    expect(ComputerOnboarding.rowsFor(view, {}).filter((row) => row.id.startsWith("main-"))).toEqual([
      {
        id: "main-screen",
        title: "computer.onboarding.macos.screenRecording",
        description: "computer.onboarding.macos.mainAppGrant",
        open: "screen",
      },
      {
        id: "main-accessibility",
        title: "computer.onboarding.macos.accessibility",
        description: "computer.onboarding.macos.mainAppGrant",
        open: "accessibility",
      },
    ])
    expect(ComputerOnboarding.canFinish({ ...view, rows: [] }, consentedAt)).toBe(false)
  })
})

describe("computer onboarding steps and rows", () => {
  test("Windows goes from consent to Try it only after its permission checks pass", () => {
    expect(ComputerOnboarding.steps("windows", windows).map((step) => step.id)).toEqual(["consent", "try"])
    expect(ComputerOnboarding.next("consent", windows)).toBe("try")
    const blocked = { ...windows, windows: { captureBlocked: true, elevated: false } }
    expect(ComputerOnboarding.steps("windows", blocked).map((step) => step.id)).toEqual([
      "consent",
      "permissions",
      "try",
    ])
    expect(ComputerOnboarding.next("consent", blocked)).toBe("permissions")
    expect(ComputerOnboarding.next("permissions", blocked)).toBe("permissions")
    expect(ComputerOnboarding.next("permissions", windows)).toBe("try")
    expect(ComputerOnboarding.next("try", blocked)).toBe("permissions")
    expect(ComputerOnboarding.next("consent", undefined)).toBe("permissions")
    expect(ComputerOnboarding.canFinish(windows)).toBe(false)
  })

  test("macOS always presents permissions and keeps each consent paragraph", () => {
    const steps = ComputerOnboarding.steps("macos", mac)
    expect(steps.map((step) => step.id)).toEqual(["consent", "permissions", "try"])
    expect(ComputerOnboarding.next("consent", mac)).toBe("permissions")
    expect(ComputerOnboarding.next("permissions", mac)).toBe("try")
    expect(steps[0].description).toEqual([
      "computer.onboarding.description",
      "computer.onboarding.indicators",
      "computer.onboarding.screenPrivacy",
      "computer.onboarding.limits",
    ])
    expect(steps[1].description).toEqual(["computer.onboarding.macos.instruction"])
  })

  test("reset-after-update notes follow the recorded grant version and only expose verified reset actions", () => {
    const denied = { ...mac, rows: mac.rows.map((row) => ({ ...row, status: "denied" as const })) }
    const granted = { granted: { helperVersion: "1.99.112", at: consentedAt } }
    expect(ComputerOnboarding.rowsFor(denied, {}).some((row) => row.id.startsWith("reset-"))).toBe(false)
    const manual = ComputerOnboarding.rowsFor(denied, granted).filter((row) => row.id.startsWith("reset-"))
    expect(manual.map((row) => row.open)).toEqual(["screen", "accessibility"])
    expect(manual.every((row) => row.reset === undefined)).toBe(true)
    const resettable = ComputerOnboarding.rowsFor({ ...denied, canReset: true }, granted)
    expect(resettable.filter((row) => row.id.startsWith("reset-")).map((row) => row.reset)).toEqual([
      "screen",
      "accessibility",
    ])
    expect(ComputerOnboarding.rowsFor(mac, granted).some((row) => row.id.startsWith("reset-"))).toBe(false)
    const explicit = { ...mac, rows: [{ ...mac.rows[0], status: "reset-after-update" as const }, mac.rows[1]] }
    expect(ComputerOnboarding.rowsFor(explicit, {}).find((row) => row.id === "reset-screen")?.description).toBe(
      "computer.onboarding.macos.grantReset",
    )
  })

  test("helper and Windows warnings appear only for their actual conditions", () => {
    expect(ComputerOnboarding.rowsFor(windows, {})).toEqual([])
    expect(ComputerOnboarding.rowsFor({ ...mac, helperStart: "failed" }, {}).some((row) => row.id === "helper")).toBe(
      true,
    )
    const blocked = {
      ...windows,
      helperStart: "failed" as const,
      adhoc: true,
      rows: mac.rows,
      vectorHoldsGrant: { screen: true, accessibility: true },
      windows: { captureBlocked: true, elevated: true },
    }
    expect(ComputerOnboarding.rowsFor(blocked, { granted: { helperVersion: "old", at: 1 } })).toEqual([
      { id: "helper", title: "computer.onboarding.helperFailed" },
      { id: "windows-capture", title: "computer.onboarding.windows.captureBlocked", open: "windows-capture" },
      { id: "windows-elevated", title: "computer.availability.elevated" },
    ])
  })

  test("Preview is macOS-only and all displayed copy uses existing localization keys", () => {
    const preview = { ...mac, adhoc: true }
    expect(ComputerOnboarding.steps("macos", preview)[0].description).toContain("computer.onboarding.preview")
    expect(ComputerOnboarding.steps("windows", { ...windows, adhoc: true })[0].description).not.toContain(
      "computer.onboarding.preview",
    )
    expect(ComputerOnboarding.rowsFor(preview, {}).some((row) => row.id === "preview")).toBe(true)
    expect(ComputerOnboarding.rowsFor(mac, {}).some((row) => row.id === "preview")).toBe(false)
    for (const row of ComputerOnboarding.rowsFor(preview, {})) {
      expect(dict[row.title]).toBeDefined()
      if (row.description) expect(dict[row.description]).toBeDefined()
    }
  })

  test("rows expose only fixed action IDs, preserve inputs and show missing grants as unknown", () => {
    const before = structuredClone(mac)
    const rows = ComputerOnboarding.rowsFor(mac, {})
    expect(rows.filter((row) => row.status).map((row) => [row.id, row.status, row.open])).toEqual([
      ["screen", "granted", "screen"],
      ["accessibility", "granted", "accessibility"],
    ])
    expect(JSON.stringify(rows)).not.toContain("untrusted:")
    expect(mac).toEqual(before)
    const missing = ComputerOnboarding.rowsFor({ ...mac, rows: [] }, {})
    expect(missing.filter((row) => row.status).every((row) => row.status === "unknown")).toBe(true)
    expect(ComputerOnboarding.rowsFor(undefined, {})).toEqual([])
  })
})
