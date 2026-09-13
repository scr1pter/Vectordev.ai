// Components that feed the launch screen its ready signals. They render
// nothing and never throw: a probe must not be able to take the app down.

import { createEffect, onMount } from "solid-js"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { afterPaint, launchScreen, writeLaunchPreferences } from "./launch-bridge"

const safely = <T,>(read: () => T, fallback: T): T => {
  try {
    return read()
  } catch {
    return fallback
  }
}

// Inside AppBaseProviders, just outside the ErrorBoundary. Once this renders,
// the bundle evaluated and mounted its root, so later uncaught errors are app
// errors for the ErrorBoundary rather than a failed bundle.
export function LaunchAttach() {
  launchScreen.attach()
  return null
}

// Beside NewLayout in NewAppLayout: the shell mounted and painted, the engine
// answered, global data settled and persisted settings loaded.
export function LaunchReadyProbe() {
  const settings = useSettings()
  const global = useGlobal()
  const server = useServer()
  const sync = useServerSync()

  onMount(() => afterPaint(() => launchScreen.signal("shell")))

  createEffect(() =>
    launchScreen.signal(
      "settings",
      safely(() => settings.ready(), false),
    ),
  )

  createEffect(() => {
    const healthy = safely(() => global.servers.health[server.key]?.healthy, undefined)
    // Health polls every 10s; the path query answering is just as good proof.
    const answered = healthy === true || safely(() => Boolean(sync().data.path.directory), false)
    launchScreen.signal("engine", answered)
    launchScreen.unhealthy(healthy === false && !answered)
  })

  // sync.ready also turns true when every bootstrap call failed, which is why
  // the host requires the engine to have answered as well.
  createEffect(() =>
    launchScreen.signal(
      "data",
      safely(() => sync().ready, false),
    ),
  )

  return null
}

// Inside SettingsProvider: mirror the glass and reduce-animations settings to
// localStorage so the next launch's first frame honours them.
export function LaunchSettingsMirror() {
  const settings = useSettings()

  createEffect(() => {
    if (!safely(() => settings.ready(), false)) return
    const glass = settings.appearance.glassmorphism()
    const reduceAnimations = settings.appearance.reduceAnimations() || settings.appearance.animationSpeed() === "off"
    writeLaunchPreferences({ glass, reduceAnimations })
  })

  return null
}
