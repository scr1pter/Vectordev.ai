import { describe, expect, test } from "bun:test"
import { AppImageUpdater } from "electron-updater"
import {
  createUpdaterController,
  startPlatformInstall,
  type UpdaterBackend,
  type UpdaterFailure,
  type UpdaterReadyRecord,
} from "./updater-controller"

function setup(input?: {
  currentVersion?: string
  ready?: UpdaterReadyRecord
  failure?: UpdaterFailure
  check?: UpdaterBackend["checkForUpdates"]
  prepare?: () => Promise<void>
  handOff?: () => void
  discard?: () => void
  stop?: () => Promise<void>
  record?: () => void
}) {
  const calls: string[] = []
  const records: UpdaterFailure[] = []
  const backend: UpdaterBackend = {
    async checkForUpdates() {
      calls.push("check")
      if (input?.check) return input.check()
      return { isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }
    },
    async downloadUpdate() {
      calls.push("download")
    },
    async prepareInstall(version) {
      calls.push(`prepare ${version}`)
      await input?.prepare?.()
      return {
        handOff: () => {
          calls.push("hand-off")
          input?.handOff?.()
        },
        discard: () => {
          calls.push("discard")
          input?.discard?.()
        },
      }
    },
  }
  let ready = input?.ready
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = value
      },
      clear: () => {
        ready = undefined
      },
    },
    failure: input?.failure,
    stop: async () => {
      calls.push("stop")
      await input?.stop?.()
    },
    record: (failure) => {
      calls.push("record")
      records.push(failure)
      input?.record?.()
    },
    restart: () => {
      calls.push("restart")
    },
  })
  return { controller, calls, records, getReady: () => ready }
}

describe("updater controller", () => {
  test("checks, downloads, persists, and publishes one authoritative ready state", async () => {
    const app = setup()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((state) => states.push(state))

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(states.map((state) => state.status)).toEqual(["idle", "checking", "downloading", "ready"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("revalidates a persisted target through the updater cache on launch", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("clears a target already installed before checking", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
  })

  test("coalesces concurrent checks", async () => {
    const app = setup()

    await Promise.all([app.controller.check(), app.controller.check(), app.controller.check()])

    expect(app.calls).toEqual(["check", "download"])
  })

  test("does not report up to date when the updater is inactive and checked nothing", async () => {
    // electron-updater resolves null when its updater is inactive, e.g. Linux not running as an AppImage.
    const app = setup({ ready: { version: "2.0.0" }, check: async () => null })

    const state = await app.controller.start()

    expect(state.status).toBe("error")
    if (state.status !== "error") return
    expect(state.message).toContain("AppImage")
    expect(state.message).toContain("https://github.com/scr1pter/Vectordev.ai/releases/latest")
    expect(app.calls).toEqual(["check"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
  })

  test("stays installing after handing the update to the platform installer", async () => {
    const app = setup()
    await app.controller.start()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "prepare 2.0.0", "stop", "hand-off"])
    expect(app.controller.getState()).toEqual({ status: "installing", version: "2.0.0" })
  })

  test("refuses an install that cannot start without stopping anything", async () => {
    const app = setup({
      prepare: async () => {
        throw new Error("Vector is running from a disk image. Move Vector to your Applications folder.")
      },
    })
    await app.controller.start()

    await expect(app.controller.install()).rejects.toThrow("Vector 2.0.0 could not be installed")

    expect(app.calls).toEqual(["check", "download", "prepare 2.0.0"])
    const state = app.controller.getState()
    expect(state.status).toBe("error")
    if (state.status !== "error") return
    expect(state.message).toContain("Move Vector to your Applications folder.")
    expect(state.message).toContain("vectordev.ai/download")
  })

  test("brings Vector back and reports the error when the platform installer refuses after stopping", async () => {
    const app = setup({
      handOff: () => {
        throw new Error("EACCES: permission denied, unlink '/opt/Vector.AppImage'")
      },
    })
    await app.controller.start()

    await expect(app.controller.install()).rejects.toThrow("permission denied")

    expect(app.calls).toEqual([
      "check",
      "download",
      "prepare 2.0.0",
      "stop",
      "hand-off",
      "discard",
      "record",
      "restart",
    ])
    expect(app.records).toEqual([
      { from: "1.0.0", version: "2.0.0", reason: "EACCES: permission denied, unlink '/opt/Vector.AppImage'" },
    ])
    expect(app.controller.getState().status).toBe("error")
  })

  test("brings Vector back when stopping its services fails part way", async () => {
    const app = setup({
      stop: async () => {
        throw new Error("stop failed")
      },
    })
    await app.controller.start()

    await expect(app.controller.install()).rejects.toThrow("stop failed")

    expect(app.calls).toEqual(["check", "download", "prepare 2.0.0", "stop", "discard", "record", "restart"])
    expect(app.controller.getState().status).toBe("error")
  })

  test("brings Vector back even when cleaning up or recording the failure fails", async () => {
    // A full disk is a likely cause of the failed install, and it also stops the failure report from being written.
    const app = setup({
      handOff: () => {
        throw new Error("install refused")
      },
      discard: () => {
        throw new Error("EROFS: read-only file system")
      },
      record: () => {
        throw new Error("ENOSPC: no space left on device")
      },
    })
    await app.controller.start()

    await expect(app.controller.install()).rejects.toThrow("Vector 2.0.0 could not be installed. install refused.")

    expect(app.calls.slice(-3)).toEqual(["discard", "record", "restart"])
    expect(app.controller.getState().status).toBe("error")
  })

  test("does not check again while an install is stopping Vector", async () => {
    const stopping = Promise.withResolvers<void>()
    const app = setup({ stop: () => stopping.promise })
    await app.controller.start()

    const install = app.controller.install()
    await new Promise((resolve) => setImmediate(resolve))
    expect(app.calls).toEqual(["check", "download", "prepare 2.0.0", "stop"])

    expect(await app.controller.check()).toEqual({ status: "installing", version: "2.0.0" })
    expect(await app.controller.poll()).toEqual({ status: "installing", version: "2.0.0" })
    stopping.resolve()
    await install

    expect(app.calls).toEqual(["check", "download", "prepare 2.0.0", "stop", "hand-off"])
    expect(app.controller.getState()).toEqual({ status: "installing", version: "2.0.0" })
  })

  test("keeps reporting a failed install on automatic checks and retries it on an explicit check", async () => {
    const app = setup({
      handOff: () => {
        throw new Error("install refused")
      },
    })
    await app.controller.start()
    await app.controller.install().catch(() => undefined)
    app.calls.length = 0

    const polled = await app.controller.poll()

    expect(polled.status).toBe("error")
    expect(app.calls).toEqual(["check"])

    const checked = await app.controller.check()

    expect(checked).toEqual({ status: "ready", version: "2.0.0" })
    expect(app.calls).toEqual(["check", "check", "download"])
  })

  test("reports an install that failed after the previous run quit instead of offering it again", async () => {
    const app = setup({
      failure: { from: "1.0.0", version: "2.0.0", reason: "Could not extract the downloaded update" },
    })

    const initial = app.controller.getState()
    expect(initial.status).toBe("error")
    if (initial.status !== "error") return
    expect(initial.message).toContain("Vector 2.0.0 could not be installed. Could not extract the downloaded update.")

    const started = await app.controller.start()

    expect(started.status).toBe("error")
    expect(app.calls).toEqual(["check"])
  })

  test("offers a newer update than the one whose install failed", async () => {
    const app = setup({
      failure: { from: "1.0.0", version: "2.0.0", reason: "Could not extract the downloaded update" },
      check: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.1" } }),
    })

    expect(await app.controller.start()).toEqual({ status: "ready", version: "2.0.1" })
  })

  test("ignores a recorded failure for the version that is already running", () => {
    const app = setup({ currentVersion: "2.0.0", failure: { from: "1.0.0", version: "2.0.0", reason: "Timed out" } })

    expect(app.controller.getState()).toEqual({ status: "idle" })
  })

  test("ignores a failure that an older build recorded before a newer one was installed by hand", () => {
    const app = setup({
      currentVersion: "2.0.1",
      failure: { from: "1.0.0", version: "2.0.0", reason: "Could not open the updated Vector" },
    })

    expect(app.controller.getState()).toEqual({ status: "idle" })
  })
})

describe("platform install hand-off", () => {
  test("surfaces an install electron-updater refuses instead of leaving the app waiting", async () => {
    let quits = 0
    const updater = new AppImageUpdater(null, {
      version: "1.0.0",
      name: "Vector",
      isPackaged: true,
      appUpdateConfigPath: "/nonexistent/app-update.yml",
      userDataPath: "/nonexistent",
      baseCachePath: "/nonexistent",
      whenReady: async () => {},
      relaunch() {},
      quit() {
        quits++
      },
      onQuit() {},
    })
    updater.logger = null
    const listeners = updater.listenerCount("error")

    // Nothing was downloaded, so electron-updater refuses the install the way it refuses an AppImage it cannot replace.
    const refused = startPlatformInstall(updater)
    await new Promise((resolve) => setImmediate(resolve))

    expect(refused).toBeInstanceOf(Error)
    expect(String(refused)).toContain("can't quit and install")
    expect(quits).toBe(0)
    expect(updater.listenerCount("error")).toBe(listeners)
  })

  test("reports nothing when the platform installer accepts the update", () => {
    const listeners = new Set<(error: Error) => void>()
    const calls: string[] = []
    const refused = startPlatformInstall({
      on: (_event: "error", listener: (error: Error) => void) => listeners.add(listener),
      off: (_event: "error", listener: (error: Error) => void) => listeners.delete(listener),
      quitAndInstall: () => {
        calls.push("quitAndInstall")
      },
    })

    expect(refused).toBeUndefined()
    expect(calls).toEqual(["quitAndInstall"])
    expect(listeners.size).toBe(0)
  })
})
