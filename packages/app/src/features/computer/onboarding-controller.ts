import type { Computer } from "@vectordevai/schema/computer"
import type { dict } from "@/i18n/en"
import { ComputerOnboarding } from "./onboarding-model"

type Status = Awaited<ReturnType<Computer.ComputerPlatform["status"]>>
type CopyKey = keyof typeof dict
export type OnboardingState = {
  step: ComputerOnboarding.Step
  loading: boolean
  checking: boolean
  saving: boolean
  permissions?: Computer.PermissionsView
  settings?: Computer.ResolvedComputerSettings
  status?: Status
  backend?: Computer.ComputerState["backend"]
  error?: CopyKey
}

/** Owns the asynchronous setup boundary, including close-start disposal before the dialog's exit animation. */
export function createComputerOnboarding(
  computer: Computer.ComputerPlatform,
  options: { focus?: Pick<EventTarget, "addEventListener" | "removeEventListener">; now?: () => number } = {},
) {
  let state: OnboardingState = { step: "consent", loading: true, checking: false, saving: false }
  const listeners = new Set<(state: OnboardingState) => void>()
  let disposed = false
  let started = false
  let timer: ReturnType<typeof setInterval> | undefined
  let tail = Promise.resolve()
  let checking: Promise<boolean> | undefined
  let mutation: { kind: string; promise: Promise<boolean> } | undefined
  const focus = options.focus ?? globalThis.window
  const publish = (patch: Partial<OnboardingState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }
  const enqueue = (work: () => Promise<boolean>) => {
    const task = tail.then(() => (disposed ? false : work()))
    tail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }
  const platform = (view = state): ComputerOnboarding.Platform =>
    view.backend === "local-windows" ? "windows" : "macos"
  const blocked = (view = state): CopyKey | undefined => {
    if (!computer.supported) return "computer.status.linux"
    if (!view.settings || !view.status || !view.backend) return "computer.onboarding.checkFailed"
    if (!view.settings.policy.enabled || view.status.reason === "policy_disabled")
      return "computer.availability.company"
    if (view.settings.locked.includes("enabled") || view.settings.locked.includes("consentedAt"))
      return "computer.settings.managed"
    if (view.backend !== "local-macos" && view.backend !== "local-windows") return "computer.availability.desktop"
    if ((view.backend === "local-windows") !== !!view.permissions?.windows) return "computer.onboarding.checkFailed"
    if (view.status.reason === "elevated") return "computer.availability.elevated"
    if (view.status.reason === "blocked_by_os") return "computer.onboarding.windows.captureBlocked"
    if (view.status.reason === "unsupported_os")
      return view.backend === "local-macos" ? "computer.availability.macos" : "computer.availability.desktop"
    if (["helper_missing", "helper_incompatible", "responsible_missing"].includes(view.status.reason ?? ""))
      return "computer.onboarding.helperFailed"
    if (!view.status.available && view.status.reason !== "permissions") return "computer.onboarding.checkFailed"
  }
  const ready = (view = state) =>
    !blocked(view) && ComputerOnboarding.canFinish(view.permissions, view.settings?.prefs.consentedAt)

  const settings = async () => {
    const [settings, status, snapshot] = await Promise.all([computer.prefs(), computer.status(), computer.state()])
    if (disposed) return false
    publish({ settings, status, backend: snapshot.backend })
    return true
  }
  const read = async (initial = false) => {
    try {
      const permissions = await (initial ? computer.permissions() : computer.recheck())
      if (disposed) return false
      // Read policy after the probe finishes. A company change during a slow probe must win over its old snapshot.
      if (!(await settings())) return false
      publish({ permissions, error: state.error === "computer.onboarding.checkFailed" ? undefined : state.error })
      if (state.step === "try" && !ready()) publish({ step: "permissions" })
      return true
    } catch {
      publish({ permissions: undefined, error: "computer.onboarding.checkFailed" })
      return false
    }
  }
  const check = (initial = false) => {
    if (disposed || mutation) return Promise.resolve(false)
    if (checking) return checking
    publish({ checking: true })
    const task = enqueue(() => read(initial)).finally(() => {
      checking = undefined
      publish({ checking: false, loading: false })
    })
    checking = task
    return task
  }
  const mutate = (kind: string, work: () => Promise<boolean>) => {
    if (disposed) return Promise.resolve(false)
    if (mutation) return mutation.kind === kind ? mutation.promise : Promise.resolve(false)
    publish({ saving: true, error: undefined })
    const promise = enqueue(work)
      .catch(() => {
        publish({ error: "computer.onboarding.saveFailed" })
        return false
      })
      .finally(() => {
        mutation = undefined
        publish({ saving: false })
      })
    mutation = { kind, promise }
    return promise
  }
  const onFocus = () => {
    void check()
  }

  return {
    get state() {
      return state
    },
    active: () => !disposed,
    platform,
    blocked,
    ready,
    subscribe(listener: (state: OnboardingState) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (started || disposed) return Promise.resolve(false)
      started = true
      if (!computer.supported) {
        publish({ loading: false })
        return Promise.resolve(false)
      }
      timer = setInterval(onFocus, 2000)
      focus?.addEventListener("focus", onFocus)
      return check(true)
    },
    dispose() {
      disposed = true
      clearInterval(timer)
      focus?.removeEventListener("focus", onFocus)
      listeners.clear()
    },
    check: () => check(),
    consent: () =>
      mutate("consent", async () => {
        if (!(await settings()) || blocked()) return false
        const consentedAt = (options.now ?? Date.now)()
        if (!Number.isSafeInteger(consentedAt) || consentedAt <= 0) return false
        if (disposed) return false
        const saved = await computer.setPrefs({ consentedAt })
        if (disposed) return false
        publish({ settings: saved })
        if (saved.prefs.consentedAt !== consentedAt) {
          publish({ error: "computer.onboarding.saveFailed" })
          return false
        }
        publish({ step: ComputerOnboarding.next("consent", state.permissions) })
        return true
      }),
    advance() {
      if (disposed || mutation || state.step !== "permissions" || !ready()) return false
      publish({ step: "try" })
      return true
    },
    finish: () =>
      mutate("finish", async () => {
        if (state.step !== "try") return false
        // Always start a new probe after earlier queued checks, even when Finish was clicked during a poll.
        if (!(await read()) || disposed || !ready()) return false
        const consentedAt = state.settings!.prefs.consentedAt!
        const saved = await computer.setPrefs({ enabled: true, consentedAt })
        if (disposed) return false
        publish({ settings: saved })
        if (!saved.prefs.enabled || !saved.policy.enabled || saved.prefs.consentedAt !== consentedAt) {
          publish({ error: "computer.onboarding.saveFailed" })
          return false
        }
        return true
      }),
    reset: (id: "screen" | "accessibility") =>
      mutate(`reset:${id}`, async () => {
        if (platform() !== "macos" || !state.permissions?.canReset) return false
        if (!ComputerOnboarding.rowsFor(state.permissions, state.settings?.prefs ?? {}).some((row) => row.reset === id))
          return false
        const permissions = await computer.reset(id)
        if (disposed || !(await settings())) return false
        publish({ permissions })
        if (state.step === "try" && !ready()) publish({ step: "permissions" })
        return true
      }),
    openPane: (id: "screen" | "accessibility" | "windows-capture") =>
      mutate(`open:${id}`, async () => {
        if (disposed) return false
        if (platform() === "windows" ? id !== "windows-capture" : id === "windows-capture") return false
        await computer.openPane(id)
        return !disposed
      }),
  }
}
