import type { UpdaterState } from "@vectordevai/app/updater"

export type { UpdaterState } from "@vectordevai/app/updater"

export type UpdaterReadyRecord = { version: string }

// An install of `version` that failed, recorded by the running version `from` so it is reported instead of being
// offered again unnoticed.
export type UpdaterFailure = { from: string; version: string; reason: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(): Promise<unknown>
  // Runs every check that can refuse the install while Vector is still fully running, then returns the hand-off to
  // the platform installer and a discard that removes whatever was prepared if the install fails before it completes.
  prepareInstall(version: string): Promise<{ handOff(): void | Promise<void>; discard?(): void | Promise<void> }>
}

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>
  set(value: UpdaterReadyRecord): void | Promise<void>
  clear(): void | Promise<void>
}

const DOWNLOADS =
  "vectordev.ai/download (sign in with a free Vector account) or https://github.com/scr1pter/Vectordev.ai/releases/latest"

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  // A failure recorded by an earlier run, such as the macOS helper's report after Vector quit.
  failure?: UpdaterFailure
  stop: () => Promise<void>
  // Saves a failure for the next launch to report; restart may relaunch, which loses the in-memory state.
  record: (failure: UpdaterFailure) => void | Promise<void>
  // Brings Vector back after stop() when the install then fails.
  restart: () => void | Promise<void>
  log?: (message: string, data?: object) => void
}) {
  // Only the build that attempted the install reports its failure. Any other build, such as the update itself or a
  // newer one installed by hand, would show a stale error.
  const previous =
    input.failure?.from === input.currentVersion && input.failure.version !== input.currentVersion
      ? input.failure
      : undefined
  let failed = previous && { version: previous.version, message: installFailedMessage(previous) }
  let state: UpdaterState = !input.enabled
    ? { status: "disabled" }
    : failed
      ? { status: "error", message: failed.message }
      : { status: "idle" }
  let pending: Promise<UpdaterState> | undefined
  const listeners = new Set<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  const refuse = (failure: UpdaterFailure) => {
    input.log?.("updater install failed", failure)
    failed = { version: failure.version, message: installFailedMessage(failure) }
    transition({ status: "error", message: failed.message })
    return new Error(failed.message)
  }

  // Runs one recovery step and logs its failure, so the steps after it still run.
  const attempt = (step: string, run: () => unknown) =>
    Promise.resolve()
      .then(run)
      .catch((error) => input.log?.(`updater ${step} failed`, { error: messageOf(error) }))

  // Automatic checks: launch and the periodic timer.
  const poll = () => {
    if (!input.enabled) return Promise.resolve(state)
    // A check during an install would replace the installing state and could offer the update again.
    if (state.status === "ready" || state.status === "installing") return Promise.resolve(state)
    if (pending) return pending

    pending = (async () => {
      transition({ status: "checking" })
      const result = await input.backend.checkForUpdates()
      // electron-updater resolves null when it is inactive and checked nothing, e.g. Linux not launched as an AppImage.
      if (!result) {
        input.log?.("updater inactive; no update check performed")
        return transition({
          status: "error",
          message: `In-app updates are not available for this installation, so Vector did not check for a new version. On Linux they need Vector to run from its AppImage. Download the latest Vector from ${DOWNLOADS}.`,
        })
      }
      const version = result.updateInfo?.version
      if (!result.isUpdateAvailable || !version || version === input.currentVersion) {
        await input.persistence.clear()
        return transition({ status: "up-to-date" })
      }
      // Only an explicit check offers an update whose install already failed again.
      if (version === failed?.version) return transition({ status: "error", message: failed.message })

      transition({ status: "downloading", version })
      await input.backend.downloadUpdate()
      await input.persistence.set({ version })
      return transition({ status: "ready", version })
    })()
      .catch((error) => transition({ status: "error", message: messageOf(error) }))
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async start() {
      const ready = await input.persistence.get()
      if (ready?.version === input.currentVersion) await input.persistence.clear()
      return poll()
    },
    poll,
    // An explicit check from the user, which also retries an update whose install failed.
    check() {
      failed = undefined
      return poll()
    },
    async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install")
      const version = state.version
      transition({ status: "installing", version })
      // Nothing is stopped until every check that can refuse the install has passed, so a refusal leaves Vector and
      // its local server running.
      const prepared = await input.backend.prepareInstall(version).catch((error) => {
        throw refuse({ from: input.currentVersion, version, reason: messageOf(error) })
      })
      await input
        .stop()
        .then(() => prepared.handOff())
        .catch(async (error) => {
          const failure = { from: input.currentVersion, version, reason: messageOf(error) }
          const refused = refuse(failure)
          // Vector must come back even if a step before the restart fails: a full disk, a likely cause of the failed
          // install, also stops the failure from being recorded.
          await attempt("cleanup", () => prepared.discard?.())
          await attempt("failure record", () => input.record(failure))
          await attempt("restart", input.restart)
          throw refused
        })
    },
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>

// electron-updater's quitAndInstall only logs an install it refuses (an AppImage it cannot replace, a cancelled
// package-manager prompt) and keeps the app running. It dispatches that refusal synchronously as an "error" event,
// while an accepted install schedules the quit, so the event tells the two apart.
export function startPlatformInstall(updater: {
  on(event: "error", listener: (error: Error) => void): unknown
  off(event: "error", listener: (error: Error) => void): unknown
  quitAndInstall(): void
}) {
  const refusals: Error[] = []
  const onError = (error: Error) => {
    refusals.push(error)
  }
  updater.on("error", onError)
  updater.quitAndInstall()
  updater.off("error", onError)
  return refusals[0]
}

function installFailedMessage(failure: UpdaterFailure) {
  return `Vector ${failure.version} could not be installed. ${failure.reason.trim().replace(/\.?$/, ".")} You can also download the latest Vector from ${DOWNLOADS}.`
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
