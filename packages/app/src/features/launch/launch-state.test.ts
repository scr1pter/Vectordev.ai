import { describe, expect, test } from "bun:test"
import {
  decideLaunchPhase,
  LAUNCH_TIMINGS,
  minVisibleFor,
  nextLaunchDeadline,
  type LaunchSignals,
} from "./launch-state"

const booting = (patch: Partial<LaunchSignals> = {}): LaunchSignals => ({
  elapsed: 0,
  minVisibleMs: minVisibleFor("desktop"),
  shellMounted: false,
  engineAnswered: false,
  dataReady: false,
  settingsReady: false,
  current: "veiled",
  ...patch,
})

const ready = (patch: Partial<LaunchSignals> = {}) =>
  booting({ shellMounted: true, engineAnswered: true, dataReady: true, settingsReady: true, ...patch })

describe("launch timings", () => {
  test("pin the agreed values", () => {
    expect(minVisibleFor("desktop")).toBe(800)
    expect(minVisibleFor("web")).toBe(0)
    expect(LAUNCH_TIMINGS.SLOW_MS).toBe(8_000)
    expect(LAUNCH_TIMINGS.HARD_MAX_MS).toBe(60_000)
    expect(LAUNCH_TIMINGS.EXIT_MS).toBe(600)
    expect(LAUNCH_TIMINGS.EXIT_REDUCED_MS).toBe(200)
  })
})

describe("decideLaunchPhase", () => {
  test("starts veiled", () => {
    expect(decideLaunchPhase(booting())).toBe("veiled")
  })

  test("a warm desktop start holds the glass for the minimum visible time", () => {
    expect(decideLaunchPhase(ready({ elapsed: 300 }))).toBe("veiled")
    expect(decideLaunchPhase(ready({ elapsed: 799 }))).toBe("veiled")
    expect(decideLaunchPhase(ready({ elapsed: 800 }))).toBe("revealing")
  })

  test("the web build reveals as soon as everything is ready", () => {
    expect(decideLaunchPhase(ready({ elapsed: 0, minVisibleMs: minVisibleFor("web") }))).toBe("revealing")
  })

  test("needs the shell, the engine, the data and the settings", () => {
    for (const missing of ["shellMounted", "engineAnswered", "dataReady", "settingsReady"] as const) {
      expect(decideLaunchPhase(ready({ elapsed: 5_000, [missing]: false }))).toBe("veiled")
    }
  })

  test("bootstrap settling alone is not ready: it also settles when every call failed", () => {
    expect(decideLaunchPhase(ready({ elapsed: 5_000, engineAnswered: false }))).toBe("veiled")
  })

  test("soft cap: with the shell and engine up, data still loading reveals at 8s", () => {
    const loading = ready({ dataReady: false })
    expect(decideLaunchPhase({ ...loading, elapsed: 7_999 })).toBe("veiled")
    expect(decideLaunchPhase({ ...loading, elapsed: 8_000 })).toBe("revealing")
  })

  test("the soft cap never reveals before the settings or the shell", () => {
    expect(decideLaunchPhase(ready({ elapsed: 9_000, dataReady: false, settingsReady: false }))).toBe("slow")
    expect(decideLaunchPhase(ready({ elapsed: 9_000, dataReady: false, shellMounted: false }))).toBe("slow")
  })

  test("shows the slow-start hint at 8s", () => {
    expect(decideLaunchPhase(booting({ elapsed: 7_999 }))).toBe("veiled")
    expect(decideLaunchPhase(booting({ elapsed: 8_000 }))).toBe("slow")
    expect(decideLaunchPhase(booting({ elapsed: 30_000, current: "slow" }))).toBe("slow")
  })

  test("the hard cap fails the glass even when every ready signal is lost", () => {
    expect(decideLaunchPhase(booting({ elapsed: 59_999, current: "slow" }))).toBe("slow")
    expect(decideLaunchPhase(booting({ elapsed: 60_000, current: "slow" }))).toBe("failed")
    expect(decideLaunchPhase(booting({ elapsed: 600_000, current: "veiled" }))).toBe("failed")
  })

  test("failed stays failed, but a late recovery still reveals", () => {
    expect(decideLaunchPhase(booting({ elapsed: 61_000, current: "failed" }))).toBe("failed")
    expect(decideLaunchPhase(ready({ elapsed: 61_000, current: "failed" }))).toBe("revealing")
  })

  test("a blocking screen takes over at once", () => {
    for (const reason of ["error", "unreachable", "license"] as const) {
      expect(decideLaunchPhase(booting({ elapsed: 10, yielded: reason }))).toBe("revealing")
      expect(decideLaunchPhase(booting({ elapsed: 70_000, current: "failed", yielded: reason }))).toBe("revealing")
    }
  })

  test("a failed bundle fails at once, unless the error page already took over", () => {
    expect(decideLaunchPhase(booting({ elapsed: 50, bundleFailed: true }))).toBe("failed")
    expect(decideLaunchPhase(booting({ elapsed: 50, bundleFailed: true, yielded: "error" }))).toBe("revealing")
  })

  test("a bundle failure never outranks the app turning out ready", () => {
    expect(decideLaunchPhase(ready({ elapsed: 900, bundleFailed: true }))).toBe("revealing")
    expect(decideLaunchPhase(ready({ elapsed: 900, bundleFailed: true, current: "failed" }))).toBe("revealing")
    // It still waits out the minimum visible time, and wakes for it.
    const early = ready({ elapsed: 300, bundleFailed: true, current: "failed" })
    expect(decideLaunchPhase(early)).toBe("failed")
    expect(nextLaunchDeadline(early)).toBe(800)
  })

  test("a confirmed unreachable engine hands over to the app's offline state", () => {
    const offline = booting({ shellMounted: true, settingsReady: true, elapsed: 5_000 })
    expect(decideLaunchPhase({ ...offline, unhealthyFor: 2_999 })).toBe("veiled")
    expect(decideLaunchPhase({ ...offline, unhealthyFor: 3_000 })).toBe("revealing")
    expect(decideLaunchPhase({ ...offline, shellMounted: false, unhealthyFor: 9_000 })).toBe("veiled")
  })

  test("revealing and gone are terminal", () => {
    expect(decideLaunchPhase(booting({ current: "revealing", bundleFailed: true, elapsed: 90_000 }))).toBe("revealing")
    expect(decideLaunchPhase(booting({ current: "gone", elapsed: 90_000 }))).toBe("gone")
  })
})

describe("nextLaunchDeadline", () => {
  test("a fresh start wakes for the slow hint, then the hard cap", () => {
    expect(nextLaunchDeadline(booting())).toBe(8_000)
    expect(nextLaunchDeadline(booting({ elapsed: 8_000, current: "slow" }))).toBe(60_000)
  })

  test("a warm desktop start wakes when the minimum visible time is up", () => {
    expect(nextLaunchDeadline(ready({ elapsed: 300 }))).toBe(800)
  })

  test("wakes for the soft cap while only data is loading", () => {
    expect(nextLaunchDeadline(ready({ elapsed: 2_000, dataReady: false }))).toBe(8_000)
  })

  test("wakes when the unreachable grace runs out", () => {
    const offline = booting({ shellMounted: true, settingsReady: true, elapsed: 1_500, unhealthyFor: 500 })
    expect(nextLaunchDeadline(offline)).toBe(4_000)
  })

  test("sleeps once nothing but a signal can change the phase", () => {
    expect(nextLaunchDeadline(booting({ elapsed: 61_000, current: "failed" }))).toBeUndefined()
    expect(nextLaunchDeadline(ready({ elapsed: 900 }))).toBeUndefined()
    expect(nextLaunchDeadline(booting({ current: "gone" }))).toBeUndefined()
  })
})
