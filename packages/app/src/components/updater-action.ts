import { createMemo } from "solid-js"
import type { UpdaterPlatform, UpdaterState } from "@/updater"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function updaterAction(state: UpdaterState | undefined) {
  if (!state) return { label: "settings.updates.action.checkNow" as const }
  switch (state.status) {
    case "checking":
      return { label: "settings.updates.action.checking" as const }
    case "downloading":
      return { label: "settings.updates.action.downloading" as const }
    case "ready":
      return { label: "toast.update.action.installRestart" as const, run: "install" as const }
    case "installing":
      return { label: "settings.updates.action.installing" as const }
    case "disabled":
      // Distinct from the idle label. This state renders a greyed-out button,
      // and labelling it "Check now" made the updater look broken: the control
      // invites a click, does nothing, and never says why. Automatic updates
      // only run in a packaged release build (see updaterEnabled) — a local or
      // dev-channel build has no release feed to check against.
      return { label: "settings.updates.action.unavailable" as const }
    default:
      return { label: "settings.updates.action.checkNow" as const, run: "check" as const }
  }
}

export async function updateVectorToLatest(updater: UpdaterPlatform | undefined) {
  if (!updater) return { status: "disabled" } as const

  let state = updater.state()
  if (["checking", "downloading", "installing", "disabled"].includes(state.status)) return state

  if (state.status !== "ready") state = await updater.check()
  if (state.status !== "ready") return state

  await updater.install()
  return updater.state()
}

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))

  return {
    action,
    async run() {
      const run = action().run
      if (run === "install") return platform.updater?.install()
      if (run !== "check") return

      const state = await platform.updater?.check()
      if (state?.status === "up-to-date") {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.updates.toast.latest.title"),
          description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
        })
      }
      if (state?.status === "error") {
        showToast({ title: language.t("common.requestFailed"), description: state.message })
      }
    },
    async updateLatest() {
      try {
        const state = await updateVectorToLatest(platform.updater)
        if (state.status === "up-to-date") {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
        }
        if (state.status === "error") {
          showToast({ title: language.t("common.requestFailed"), description: state.message })
        }
      } catch (error) {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
