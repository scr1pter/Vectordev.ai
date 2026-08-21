export const telemetryPreferenceChanged = "vector:telemetry-preference-changed"

const key = "vector.privacy.crash-diagnostics"

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">
type PreferenceEventTarget = {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}
type DiagnosticEvent = {
  request?: unknown
  user?: unknown
  breadcrumbs?: unknown[]
  extra?: unknown
}

function defaultStorage() {
  if (typeof localStorage === "undefined") return
  return localStorage
}

function defaultEventTarget(): PreferenceEventTarget | undefined {
  if (typeof window === "undefined") return
  return window
}

export function telemetryEnabled(storage: PreferenceStorage | undefined = defaultStorage()) {
  if (!storage) return false
  try {
    return storage.getItem(key) === "enabled"
  } catch {
    return false
  }
}

export function setTelemetryEnabled(enabled: boolean, storage: PreferenceStorage | undefined = defaultStorage()) {
  if (!storage) return false
  try {
    storage.setItem(key, enabled ? "enabled" : "disabled")
  } catch {
    return false
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(telemetryPreferenceChanged, { detail: { enabled } }))
  return true
}

export function observeTelemetryPreference(
  listener: (enabled: boolean) => void,
  options: { storage?: PreferenceStorage; target?: PreferenceEventTarget } = {},
) {
  const target = options.target ?? defaultEventTarget()
  if (!target) return () => {}

  const refresh: EventListener = () => listener(telemetryEnabled(options.storage))
  const refreshFromStorage: EventListener = (event) => {
    const changedKey = (event as StorageEvent).key
    if (changedKey !== key && changedKey !== null) return
    refresh(event)
  }

  target.addEventListener(telemetryPreferenceChanged, refresh)
  target.addEventListener("storage", refreshFromStorage)
  return () => {
    target.removeEventListener(telemetryPreferenceChanged, refresh)
    target.removeEventListener("storage", refreshFromStorage)
  }
}

export function diagnosticReportingAvailable(preferenceEnabled: boolean, sentryEnabled: boolean) {
  return preferenceEnabled && sentryEnabled
}

export function scrubDiagnosticEvent<T extends DiagnosticEvent>(event: T): Omit<T, keyof DiagnosticEvent> {
  const scrubbed = { ...event }
  Reflect.deleteProperty(scrubbed, "request")
  Reflect.deleteProperty(scrubbed, "user")
  Reflect.deleteProperty(scrubbed, "breadcrumbs")
  Reflect.deleteProperty(scrubbed, "extra")
  return scrubbed
}
