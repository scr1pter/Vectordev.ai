import { describe, expect, test } from "bun:test"
import { updaterAction, updateVectorToLatest } from "./updater-action"
import type { UpdaterPlatform, UpdaterState } from "@/updater"

describe("updaterAction", () => {
  test("disables update actions when the platform has no updater", () => {
    expect(updaterAction(undefined)).toEqual({ label: "settings.updates.action.checkNow" })
  })

  test("projects updater transitions into one settings action", () => {
    expect(updaterAction({ status: "idle" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "checking" })).toEqual({ label: "settings.updates.action.checking" })
    expect(updaterAction({ status: "downloading", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.downloading",
    })
    expect(updaterAction({ status: "ready", version: "2.0.0" })).toEqual({
      label: "toast.update.action.installRestart",
      run: "install",
    })
    expect(updaterAction({ status: "installing", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.installing",
    })
  })

  test("checks, downloads, and installs an update from one action", async () => {
    const calls: string[] = []
    let state: UpdaterState = { status: "idle" }
    const updater: UpdaterPlatform = {
      state: () => state,
      async check() {
        calls.push("check")
        state = { status: "ready", version: "2.0.0" }
        return state
      },
      async install() {
        calls.push("install")
        state = { status: "installing", version: "2.0.0" }
      },
    }

    const result = await updateVectorToLatest(updater)

    expect(calls).toEqual(["check", "install"])
    expect(result).toEqual({ status: "installing", version: "2.0.0" })
  })

  test("installs an already-downloaded update without checking again", async () => {
    const calls: string[] = []
    let state: UpdaterState = { status: "ready", version: "2.0.0" }
    const updater: UpdaterPlatform = {
      state: () => state,
      async check() {
        calls.push("check")
        return state
      },
      async install() {
        calls.push("install")
        state = { status: "installing", version: "2.0.0" }
      },
    }

    await updateVectorToLatest(updater)

    expect(calls).toEqual(["install"])
  })

  test("does not install when Vector is already current", async () => {
    const calls: string[] = []
    const state: UpdaterState = { status: "up-to-date" }
    const updater: UpdaterPlatform = {
      state: () => state,
      async check() {
        calls.push("check")
        return state
      },
      async install() {
        calls.push("install")
      },
    }

    const result = await updateVectorToLatest(updater)

    expect(calls).toEqual(["check"])
    expect(result).toEqual({ status: "up-to-date" })
  })
})

describe("an updater that cannot run", () => {
  test("says so instead of offering a dead Check now button", () => {
    // The reported symptom: "the update feature is unavailable". A local or
    // dev-channel build disables the updater, and the row rendered a greyed
    // "Check now" with no explanation, which reads as a broken feature.
    const action = updaterAction({ status: "disabled" })
    expect(action.label).toBe("settings.updates.action.unavailable")
    expect(action.run).toBeUndefined()
  })

  test("an unchecked updater still offers a real check", () => {
    expect(updaterAction({ status: "idle" }).run).toBe("check")
  })
})

