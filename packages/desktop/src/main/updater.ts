import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { dirname } from "node:path"
import { app, dialog, session } from "electron"
import pkg from "electron-updater"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { UPDATER_DISABLED_REASON, UPDATER_ENABLED } from "./constants"
import { createUpdaterController, startPlatformInstall, type UpdaterReadyRecord } from "./updater-controller"
import { createUpdateGate, duringUpdateCheck } from "./local-mode"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { setAppQuitting } from "./windows"
import { prepareMacUpdateInstaller, recordUpdateFailure, takeUpdateFailure } from "./mac-update-installer"
import { updateFeed, VECTOR_DOWNLOADS } from "./update-feed"

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
  // A company's mirror replaces the feed app-update.yml names (update-feed.ts); the checks on what installs stay.
  const { feed, ignored } = updateFeed({ policy: Egress.policy(), resources: process.resourcesPath })
  if (feed?.options) autoUpdater.setFeedURL(feed.options)
  if (ignored) logger.warn(ignored)
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
    enabled: UPDATER_ENABLED,
    disabledReason: UPDATER_DISABLED_REASON,
    mirror: feed?.mirror === true,
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
  const local = createUpdateGate({
    feed: () => feed?.url,
    downloads: () => (feed?.mirror ? [] : [VECTOR_DOWNLOADS]),
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
  // A check the person started, or undefined when they cancelled Vector Local's question or it refused the check. An
  // installation without in-app updates checks nothing, so there is nothing to ask about.
  const checked = () => (UPDATER_ENABLED ? local.checked(() => controller.check()) : controller.check())
  return {
    ...controller,
    start: () => (local.automatic() ? controller.start() : Promise.resolve(controller.getState())),
    poll: () => (local.automatic() ? controller.poll() : Promise.resolve(controller.getState())),
    checked,
    check: async () => (await checked()) ?? controller.getState(),
  }
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  // A check the person cancelled shows nothing, not the state an earlier check left.
  const state = await controller.checked()
  if (!state) return
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
