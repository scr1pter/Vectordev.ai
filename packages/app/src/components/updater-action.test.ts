import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createUpdateRestart,
  installUpdate,
  navigationUpdate,
  navigationUpdateFailure,
  runningAgentCount,
  updaterAction,
  updaterFailure,
  updateVectorToLatest,
} from "./updater-action"
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

describe("an install that fails", () => {
  const rejected = new Error(
    "Error invoking remote method 'updater-install': Error: Vector 2.0.0 could not be installed. Move Vector to your Applications folder.",
  )

  test("reports the message the updater published with its error state", () => {
    const updater: UpdaterPlatform = {
      state: () => ({
        status: "error",
        message: "Vector 2.0.0 could not be installed. Move Vector to your Applications folder.",
      }),
      check: async () => ({ status: "up-to-date" }),
      install: async () => {},
    }

    expect(updaterFailure(updater, rejected)).toBe(
      "Vector 2.0.0 could not be installed. Move Vector to your Applications folder.",
    )
  })

  test("falls back to the rejection when the updater published no error", () => {
    const updater: UpdaterPlatform = {
      state: () => ({ status: "ready", version: "2.0.0" }),
      check: async () => ({ status: "ready", version: "2.0.0" }),
      install: async () => {},
    }

    expect(updaterFailure(updater, rejected)).toBe(rejected.message)
    expect(updaterFailure(undefined, "offline")).toBe("offline")
  })

  test("reports a rejected install with the updater's message instead of leaving it unhandled", async () => {
    let state: UpdaterState = { status: "ready", version: "2.0.0" }
    const updater: UpdaterPlatform = {
      state: () => state,
      check: async () => state,
      async install() {
        state = {
          status: "error",
          message: "Vector 2.0.0 could not be installed. Move Vector to your Applications folder.",
        }
        throw rejected
      },
    }
    const errors: string[] = []

    await expect(installUpdate(updater, (message) => errors.push(message))).resolves.toBeUndefined()

    expect(errors).toEqual(["Vector 2.0.0 could not be installed. Move Vector to your Applications folder."])
  })

  test("reports nothing when the install starts", async () => {
    const calls: string[] = []
    const updater: UpdaterPlatform = {
      state: () => ({ status: "installing", version: "2.0.0" }),
      check: async () => ({ status: "ready", version: "2.0.0" }),
      install: async () => {
        calls.push("install")
      },
    }
    const errors: string[] = []

    await installUpdate(updater, (message) => errors.push(message))
    await installUpdate(undefined, (message) => errors.push(message))

    expect(calls).toEqual(["install"])
    expect(errors).toEqual([])
  })
})

describe("navigationUpdate", () => {
  test("shows the Update button only for a downloaded update and while it installs", () => {
    const hidden: (UpdaterState | undefined)[] = [
      undefined,
      { status: "disabled" },
      { status: "idle" },
      { status: "checking" },
      { status: "downloading", version: "2.0.0" },
      { status: "downloading", version: "2.0.0", percent: 40 },
      { status: "up-to-date" },
      { status: "error", message: "offline" },
    ]
    for (const state of hidden) expect(navigationUpdate(state)).toBeUndefined()
    expect(navigationUpdate({ status: "ready", version: "2.0.0" })).toEqual({ version: "2.0.0", installing: false })
    expect(navigationUpdate({ status: "installing", version: "2.0.0" })).toEqual({ version: "2.0.0", installing: true })
  })
})

describe("navigationUpdateFailure", () => {
  test("says the install failed, gives the updater's reason, and opens Updates & about", () => {
    const opened: string[] = []
    const toast = navigationUpdateFailure("The download is damaged.", () => opened.push("updates"))
    expect(toast).toMatchObject({
      variant: "error",
      title: "Vector couldn't install the update",
      description: "The download is damaged.",
    })
    expect(toast.actions.map((action) => action.label)).toEqual(["Open Updates", "Dismiss"])
    const open = toast.actions[0].onClick
    if (typeof open === "function") open()
    expect(opened).toEqual(["updates"])
  })
})

describe("runningAgentCount", () => {
  test("your own busy task counts, with no parallel or background agents running", () => {
    expect(runningAgentCount({ ses_main: { type: "busy" } }, 0)).toBe(1)
  })

  test("busy and retrying sessions anywhere count, idle ones do not, and running parallel agents add to them", () => {
    const sessions = {
      ses_main: { type: "busy" },
      ses_subagent: { type: "busy" },
      ses_other_repository: { type: "retry" },
      ses_done: { type: "idle" },
    }
    expect(runningAgentCount(sessions, 0)).toBe(3)
    expect(runningAgentCount(sessions, 2)).toBe(5)
    expect(runningAgentCount({ ses_done: { type: "idle" } }, 0)).toBe(0)
  })
})

describe("a click on Update", () => {
  const setup = (agents: number) =>
    createRoot((dispose) => {
      const [update, setUpdate] = createSignal<{ version: string; installing: boolean } | undefined>({
        version: "1.99.110",
        installing: false,
      })
      const calls: string[] = []
      const running = { agents }
      const restart = createUpdateRestart({
        update,
        install: () => calls.push("install"),
        runningAgents: async () => running.agents,
      })
      return { restart, setUpdate, calls, running, dispose }
    })

  test("restarts at once when no agent is running", async () => {
    const { restart, calls, dispose } = setup(0)
    expect(await restart.start()).toBe(false)
    expect(calls).toEqual(["install"])
    expect(restart.confirming()).toBe(false)
    dispose()
  })

  test("asks first while agents run, and keeps the count from the click", async () => {
    const { restart, calls, running, dispose } = setup(2)
    expect(await restart.start()).toBe(true)
    expect(restart.confirming()).toBe(true)
    running.agents = 0
    expect(restart.stopping()).toBe(2)
    expect(calls).toEqual([])
    dispose()
  })

  // Closing the question and the ready announcement run as effects, which the browser specs cover.
  test("does nothing once the update is installing or gone", async () => {
    const { restart, setUpdate, calls, dispose } = setup(1)
    setUpdate({ version: "1.99.110", installing: true })
    expect(await restart.start()).toBe(false)
    setUpdate(undefined)
    expect(await restart.start()).toBe(false)
    expect(restart.confirming()).toBe(false)
    expect(calls).toEqual([])
    dispose()
  })
})
