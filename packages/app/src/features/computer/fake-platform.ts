import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"

type Status = Awaited<ReturnType<Computer.ComputerPlatform["status"]>>
type App = Awaited<ReturnType<Computer.ComputerPlatform["apps"]>>[number]
type PermissionSequence = Computer.PermissionsView | readonly Computer.PermissionsView[]

/** JSON-safe input for addInitScript. These are fixture defaults, not the desktop's settings resolver. */
export interface FakeComputerScript {
  supported?: boolean
  state?: Partial<Computer.ComputerState>
  status?: Partial<Status>
  prefs?: Partial<Computer.ComputerPrefs>
  policy?: Omit<Partial<Computer.ComputerPolicy>, "apps"> & {
    apps?: readonly (readonly [string, "allow" | "deny"])[]
  }
  always?: Computer.AlwaysAllowed[]
  builtins?: Computer.ResolvedComputerSettings["builtins"]
  locked?: Computer.ResolvedComputerSettings["locked"]
  alwaysReset?: boolean
  /** Each method advances its own sequence, then repeats its final response. The first permissions response seeds
   * the initial view; missing sequences use the latest view without consuming another method's sequence. */
  permissions?: PermissionSequence
  recheck?: PermissionSequence
  reset?: PermissionSequence
  apps?: App[]
  removedScreenshots?: number
  /** Fixed timestamp for newly blocked apps; defaults to zero so runs are deterministic. */
  now?: number
}

export type FakeComputerCall =
  | { method: "command"; command: Computer.Command; arg?: { sessionID?: string } }
  | { method: "setPrefs"; prefs: Partial<Computer.ComputerPrefs> }
  | { method: "removeAlways"; key: string }
  | { method: "removeAllAlways" }
  | { method: "block"; app: Computer.AppIdentity }
  | { method: "unblock"; key: string }
  | { method: "openPane"; id: "screen" | "accessibility" | "windows-capture" }
  | { method: "reset"; id: "screen" | "accessibility" }
  | { method: "deleteScreenshots" }

export interface FakeComputer extends Computer.ComputerPlatform {
  /** Commands only record intent. Tests explicitly emit the next desktop state. */
  emit(state: Computer.ComputerState): void
  /** A detached snapshot; callers cannot edit the recorded calls. Read methods are not logged. */
  readonly calls: readonly FakeComputerCall[]
}

export function createFakeComputer(script: FakeComputerScript = {}): FakeComputer {
  const seed = structuredClone(script)
  const supported = seed.supported ?? true
  const windows = seed.state?.backend === "local-windows"
  const settings: Computer.ResolvedComputerSettings = {
    prefs: {
      enabled: false,
      mode: "foreground",
      pointer: "ask",
      blocked: [],
      unblocked: [],
      retention: "7d",
      stopChord: windows ? Hands.STOP_CHORD.win32 : Hands.STOP_CHORD.darwin,
      keepAwake: true,
      notify: true,
      reduceMotion: false,
      ...seed.prefs,
    },
    policy: {
      managed: false,
      enabled: true,
      defaultAccess: "ask",
      allowAlways: true,
      background: true,
      keepAwake: true,
      ignored: [],
      ...seed.policy,
      apps: new Map(seed.policy?.apps ?? []),
    },
    always: seed.always ?? [],
    builtins: seed.builtins ?? [],
    locked: seed.locked ?? [],
    ...(seed.alwaysReset !== undefined ? { alwaysReset: seed.alwaysReset } : {}),
  }
  const current: {
    state: Computer.ComputerState
    permissions: Computer.PermissionsView
    apps: App[]
    removed: number
  } = {
    state: {
      phase: settings.prefs.enabled ? "ready" : "off",
      backend: "local-macos",
      mode: settings.prefs.mode,
      apps: [],
      queue: [],
      escStops: false,
      stopChord: settings.prefs.stopChord,
      lease: 0,
      reduceMotion: settings.prefs.reduceMotion,
      ...seed.state,
    },
    permissions: (seed.permissions && ("rows" in seed.permissions ? seed.permissions : seed.permissions[0])) ?? {
      rows:
        windows || !supported
          ? []
          : [
              {
                id: "screen",
                status: "denied",
                pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
              },
              {
                id: "accessibility",
                status: "denied",
                pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
              },
            ],
      canReset: false,
      adhoc: false,
      helperStart: "ok",
      vectorHoldsGrant: { screen: false, accessibility: false },
      ...(windows ? { windows: { captureBlocked: false, elevated: false } } : {}),
    },
    apps: seed.apps ?? [],
    removed: seed.removedScreenshots ?? 0,
  }
  const status: Status = {
    available: supported,
    backend: "fake",
    ...seed.status,
    ...(!supported ? { available: false, reason: "unsupported_os" as const } : {}),
  }
  const listeners = new Set<(state: Computer.ComputerState) => void>()
  const log: FakeComputerCall[] = []
  const sequences = {
    permissions: sequence(seed.permissions),
    recheck: sequence(seed.recheck),
    reset: sequence(seed.reset),
  }
  const permissionView = (method: keyof typeof sequences) => {
    current.permissions = sequences[method]() ?? current.permissions
    return structuredClone(current.permissions)
  }
  return {
    supported,
    get calls() {
      return structuredClone(log)
    },
    status: async () => structuredClone(status),
    state: async () => structuredClone(current.state),
    onState: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit: (state) => {
      const snapshot = structuredClone(state)
      current.state = snapshot
      // Snapshot the subscriber set as well: subscriptions added by a callback start with the next event.
      for (const listener of [...listeners]) listener(structuredClone(snapshot))
    },
    command: async (command, arg) => {
      log.push({ method: "command", command, ...(arg === undefined ? {} : { arg: structuredClone(arg) }) })
    },
    prefs: async () => structuredClone(settings),
    setPrefs: async (prefs) => {
      log.push({ method: "setPrefs", prefs: structuredClone(prefs) })
      settings.prefs = {
        ...settings.prefs,
        ...structuredClone(
          Object.fromEntries(
            Object.entries(prefs).filter(
              ([key, value]) => value !== undefined && !settings.locked.includes(key as keyof Computer.ComputerPrefs),
            ),
          ),
        ),
      }
      return structuredClone(settings)
    },
    permissions: async () => permissionView("permissions"),
    recheck: async () => permissionView("recheck"),
    openPane: async (id) => {
      log.push({ method: "openPane", id })
    },
    reset: async (id) => {
      log.push({ method: "reset", id })
      return permissionView("reset")
    },
    apps: async (query) =>
      structuredClone(
        current.apps
          .filter((app) => !query || app.name.toLowerCase().includes(query.toLowerCase()))
          .map((app) =>
            settings.prefs.blocked.some((blocked) => blocked.key === app.key) &&
            app.rule !== "never" &&
            app.rule !== "company-deny"
              ? { ...app, rule: "blocked" as const }
              : app,
          ),
      ),
    removeAlways: async (key) => {
      log.push({ method: "removeAlways", key })
      settings.always = settings.always.filter((app) => app.key !== key)
    },
    removeAllAlways: async () => {
      log.push({ method: "removeAllAlways" })
      settings.always = []
    },
    block: async (app) => {
      log.push({ method: "block", app: structuredClone(app) })
      const key = Computer.appKey(app)
      if (settings.locked.includes("blocked")) return
      if (!settings.prefs.blocked.some((blocked) => blocked.key === key))
        settings.prefs.blocked.push({ key, name: app.name, addedAt: seed.now ?? 0 })
      settings.prefs.unblocked = settings.prefs.unblocked.filter((unblocked) => unblocked !== key)
    },
    unblock: async (key) => {
      log.push({ method: "unblock", key })
      if (settings.locked.includes("blocked")) return
      settings.prefs.blocked = settings.prefs.blocked.filter((blocked) => blocked.key !== key)
      if (settings.builtins.some((app) => app.key === key && app.removable) && !settings.prefs.unblocked.includes(key))
        settings.prefs.unblocked.push(key)
      current.apps = current.apps.map((app) => {
        if (app.key !== key || app.rule !== "blocked") return app
        const { rule, ...unblocked } = app
        return unblocked
      })
    },
    deleteScreenshots: async () => {
      log.push({ method: "deleteScreenshots" })
      const removed = current.removed
      current.removed = 0
      return { removed }
    },
  }
}

function sequence(input: PermissionSequence | undefined) {
  const responses: readonly Computer.PermissionsView[] = input === undefined ? [] : "rows" in input ? [input] : input
  let index = 0
  return () => responses[Math.min(index++, responses.length - 1)]
}
