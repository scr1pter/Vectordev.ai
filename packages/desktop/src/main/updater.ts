import { constants, existsSync, readFileSync } from "node:fs"
import { access } from "node:fs/promises"
import { dirname, join } from "node:path"
import { app, dialog, session } from "electron"
import pkg from "electron-updater"
import { UPDATER_DISABLED_REASON, UPDATER_ENABLED } from "./constants"
import { createUpdaterController, startPlatformInstall, type UpdaterReadyRecord } from "./updater-controller"
import { createUpdateGate, duringUpdateCheck } from "./local-mode"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { setAppQuitting } from "./windows"
import { prepareMacUpdateInstaller, recordUpdateFailure, takeUpdateFailure } from "./mac-update-installer"

const { autoUpdater } = pkg
const key = "ready"

export function setupAutoUpdater(input: { stop: () => Promise<void>; relaunch: () => void }) {
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
    enabled: UPDATER_ENABLED,
    disabledReason: UPDATER_DISABLED_REASON,
  })

  const store = getStore("vector.updater")
  const userData = app.getPath("userData")
  let downloadedFiles: string[] = []
  const controller = createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      downloadUpdate: async () => {
        downloadedFiles = await autoUpdater.downloadUpdate()
        return downloadedFiles
      },
      prepareInstall: async (version) => {
        if (process.platform === "darwin") {
          const installer = await prepareMacUpdateInstaller({
            archive: downloadedFiles.find((file) => file.endsWith(".zip")),
            executable: app.getPath("exe"),
            userData,
            version,
            from: app.getVersion(),
          })
          return {
            handOff: () => {
              installer.launch()
              setAppQuitting()
              app.quit()
            },
            discard: installer.discard,
          }
        }

        // electron-updater replaces an AppImage by deleting it and moving the download into its folder.
        const appImage = process.env.APPIMAGE
        if (appImage) {
          await access(dirname(appImage), constants.W_OK).catch(() => {
            throw new Error(
              `Vector cannot replace ${appImage} because its folder is not writable for your account. Move the AppImage to a folder you can write to, reopen it and try again.`,
            )
          })
        }
        return {
          handOff: () => {
            // quitAndInstall closes all windows before emitting before-quit, so
            // flag the quit first to keep window ids persisted for restore.
            setAppQuitting()
            const refused = startPlatformInstall(autoUpdater)
            if (!refused) return
            // The app keeps running; clear the flag so deliberate window closes prune ids again.
            setAppQuitting(false)
            throw refused
          },
        }
      },
    },
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return { version: value.version } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    failure: takeUpdateFailure(userData),
    stop: input.stop,
    record: (failure) => recordUpdateFailure(userData, failure),
    // Relaunching is the one reliable way back to a running local server; the next launch reports the recorded failure.
    restart: input.relaunch,
    log: (message, data) => logger.log(message, data),
  })

  // The only error a new controller starts in is an install the previous run could not finish, e.g. the macOS helper
  // reopened the old app after it failed.
  const state = controller.getState()
  if (state.status === "error") {
    void dialog.showMessageBox({
      type: "error",
      title: "Update Error",
      message: "Vector couldn't install the update.",
      detail: state.message,
    })
  }

  // Vector Local turns automatic checks off (a company mirror excepted) and asks before each check the person starts;
  // the first run's hold keeps automatic checks back until the person has chosen how to run models.
  const feed = updateFeed()
  const local = createUpdateGate({
    feed: () => feed,
    ask: async (question) =>
      (
        await dialog.showMessageBox({
          type: "question",
          title: "Vector Local",
          message: question.message,
          detail: question.detail,
          buttons: ["Check once", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        })
      ).response === 0,
    tell: async (notice) =>
      void (await dialog.showMessageBox({
        type: "info",
        title: "Vector Local",
        message: notice.message,
        detail: notice.detail,
      })),
    during: (origins, run) =>
      duringUpdateCheck((partition, options) => session.fromPartition(partition, options), origins, run),
  })
  return {
    ...controller,
    start: () => (local.automatic() ? controller.start() : Promise.resolve(controller.getState())),
    poll: () => (local.automatic() ? controller.poll() : Promise.resolve(controller.getState())),
    check: async () => {
      // An installation without in-app updates checks nothing, so there is nothing to ask about.
      if (!UPDATER_ENABLED || (await local.manual())) return local.run(() => controller.check())
      return controller.getState()
    },
  }
}

// The feed electron-updater reads, from the app-update.yml electron-builder writes beside the app's resources; none in
// a development build.
function updateFeed() {
  const file = join(process.resourcesPath ?? "", "app-update.yml")
  if (!process.resourcesPath || !existsSync(file)) return undefined
  return readFileSync(file, "utf8").match(/^url:\s*['"]?([^'"\s]+)/m)?.[1]
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "error",
      message: "Update check failed.",
      detail: state.message,
      title: "Update Error",
    })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${state.version} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response !== 0) return
  await controller.install().catch((error) =>
    dialog.showMessageBox({
      type: "error",
      message: "Vector couldn't install the update.",
      detail: error instanceof Error ? error.message : String(error),
      title: "Update Error",
    }),
  )
}
