import { describe, expect, test } from "bun:test"
import {
  diagnosticReportingAvailable,
  observeTelemetryPreference,
  scrubDiagnosticEvent,
  setTelemetryEnabled,
  telemetryEnabled,
  telemetryPreferenceChanged,
} from "./telemetry"

function storage(initial?: string) {
  const values = new Map<string, string>()
  if (initial) values.set("vector.privacy.crash-diagnostics", initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe("crash diagnostics preference", () => {
  test("is disabled by default and only enables through explicit consent", () => {
    const preferences = storage()
    expect(telemetryEnabled(preferences)).toBe(false)
    expect(setTelemetryEnabled(true, preferences)).toBe(true)
    expect(telemetryEnabled(preferences)).toBe(true)
  })

  test("persists an explicit disabled state", () => {
    const preferences = storage("enabled")
    expect(setTelemetryEnabled(false, preferences)).toBe(true)
    expect(telemetryEnabled(preferences)).toBe(false)
  })

  test("fails closed when browser storage is unavailable", () => {
    const unavailable = {
      getItem: () => {
        throw new Error("storage denied")
      },
      setItem: () => {
        throw new Error("storage denied")
      },
    }
    expect(telemetryEnabled(unavailable)).toBe(false)
    expect(setTelemetryEnabled(true, unavailable)).toBe(false)
  })

  test("propagates preference changes from this window and other windows", () => {
    const preferences = storage()
    const target = new EventTarget()
    const observed: boolean[] = []
    const stop = observeTelemetryPreference((enabled) => observed.push(enabled), {
      storage: preferences,
      target,
    })

    preferences.setItem("vector.privacy.crash-diagnostics", "enabled")
    target.dispatchEvent(new CustomEvent(telemetryPreferenceChanged))

    preferences.setItem("vector.privacy.crash-diagnostics", "disabled")
    const storageEvent = new Event("storage")
    Object.defineProperty(storageEvent, "key", { value: "vector.privacy.crash-diagnostics" })
    target.dispatchEvent(storageEvent)

    preferences.setItem("vector.privacy.crash-diagnostics", "enabled")
    const unrelatedStorageEvent = new Event("storage")
    Object.defineProperty(unrelatedStorageEvent, "key", { value: "another.preference" })
    target.dispatchEvent(unrelatedStorageEvent)
    stop()
    target.dispatchEvent(new CustomEvent(telemetryPreferenceChanged))

    expect(observed).toEqual([true, false])
  })

  test("only offers reporting when consent and the diagnostics client are both active", () => {
    expect(diagnosticReportingAvailable(true, true)).toBe(true)
    expect(diagnosticReportingAvailable(false, true)).toBe(false)
    expect(diagnosticReportingAvailable(true, false)).toBe(false)
  })

  test("removes request, identity, breadcrumb, and extra payloads before transmission", () => {
    expect(
      scrubDiagnosticEvent({
        message: "render failed",
        request: { url: "http://localhost:3000/?token=secret" },
        user: { email: "developer@example.com" },
        breadcrumbs: [{ category: "console", message: "prompt contents" }],
        extra: { repository: "/Users/developer/private-project" },
      }),
    ).toEqual({ message: "render failed" })
  })
})
