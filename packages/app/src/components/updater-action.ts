import { createContext, createEffect, createMemo, createSignal, on, useContext } from "solid-js"
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

// The sidebar's Update button, which takes the Settings gear's place: shown once an update has downloaded and while
// it installs. Downloading has no progress to show, and an error also covers offline checks, so neither replaces the
// gear; Settings > Updates & about shows both.
export function navigationUpdate(state: UpdaterState | undefined) {
  if (state?.status === "ready") return { version: state.version, installing: false }
  if (state?.status === "installing") return { version: state.version, installing: true }
  return undefined
}

/** A downloaded update, or one installing, as an Update button shows it. */
export type PendingUpdate = { version: string; installing: boolean }

/**
 * What the shell gives every Update button: the update, how to restart into it, and how many agents a restart would
 * stop. The sidebar gets it as props; Home, which shows no sidebar, reads it here.
 */
export const UpdateActionContext = createContext<{
  update: () => PendingUpdate | undefined
  install: () => void
  runningAgents: () => number | Promise<number>
}>()

export const useUpdateAction = () => useContext(UpdateActionContext)

/**
 * A click on Update. It counts the agents a restart would stop and, above zero, asks first, keeping the count from the
 * click rather than a live one, so agents that finish while it is open never turn it into "0 agents will stop". With
 * none running it restarts at once. It also says once, never for what was on screen at launch, that an update is ready.
 */
export function createUpdateRestart(input: {
  update: () => PendingUpdate | undefined
  install: () => void
  runningAgents?: () => number | Promise<number>
}) {
  const [confirming, setConfirming] = createSignal(false)
  const [stopping, setStopping] = createSignal(0)
  const [announcement, setAnnouncement] = createSignal("")
  const ready = () => {
    const update = input.update()
    return update && !update.installing ? update : undefined
  }
  let counting = false
  createEffect(
    on(
      () => ready()?.version,
      (version) => setAnnouncement(version ? `Vector ${version} is ready. Restart to update.` : ""),
      { defer: true },
    ),
  )
  createEffect(() => {
    if (!ready()) setConfirming(false)
  })
  // True when it opened the confirmation, so the caller can move focus into it.
  const start = async () => {
    if (!ready() || counting) return false
    counting = true
    const running = await Promise.resolve()
      .then(() => input.runningAgents?.() ?? 0)
      .catch(() => 0)
    counting = false
    if (!ready()) return false
    if (running > 0) {
      setStopping(running)
      setConfirming(true)
      return true
    }
    input.install()
    return false
  }
  return { confirming, setConfirming, stopping, announcement, start }
}

// The agents a restart into the update stops, from every repository rather than the task on screen: each engine
// session that is busy or retrying (your own task, its subagents and tasks elsewhere) plus the parallel and swarm agents
// still running, which the engine runs without a session status. Background task records mirror those parallel
// agents, so they are not counted again.
export function runningAgentCount(sessions: Readonly<Record<string, { type: string }>>, runningWorkspaces: number) {
  return Object.values(sessions).filter((status) => status.type !== "idle").length + runningWorkspaces
}

// What the sidebar says when Update could not install. The button has already given its place back to the gear (the
// updater is in its error state); Updates & about shows the error with Try again.
export function navigationUpdateFailure(message: string, openUpdates: () => void) {
  return {
    variant: "error" as const,
    title: "Vector couldn't install the update",
    description: message,
    actions: [
      { label: "Open Updates", onClick: openUpdates },
      { label: "Dismiss", onClick: "dismiss" as const },
    ],
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

export function updaterFailure(updater: UpdaterPlatform | undefined, error: unknown) {
  const state = updater?.state()
  // The desktop bridge prefixes a rejected call with its IPC channel, so prefer the message the updater published
  // with its error state.
  if (state?.status === "error") return state.message
  return error instanceof Error ? error.message : String(error)
}

// Reports a failed install through onError instead of rejecting: the install is started from click handlers that
// would otherwise leave the rejection unhandled.
export async function installUpdate(updater: UpdaterPlatform | undefined, onError: (message: string) => void) {
  await updater?.install().catch((error) => onError(updaterFailure(updater, error)))
}

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))
  const failed = (message: string) => {
    showToast({ title: language.t("common.requestFailed"), description: message })
  }
  const install = () => installUpdate(platform.updater, failed)

  return {
    action,
    install,
    async run() {
      const run = action().run
      if (run === "install") return install()
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
        failed(state.message)
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
          failed(state.message)
        }
      } catch (error) {
        failed(updaterFailure(platform.updater, error))
      }
    },
  }
}
