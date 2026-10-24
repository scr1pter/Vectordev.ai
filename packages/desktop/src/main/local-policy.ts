import { join } from "node:path"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalStartup } from "@vectordevai/core/local-mode/startup"

// Vector Local's policy in the desktop's main process. The backstop, this process's first import, holds every request
// but this computer's when anything it reads may turn Vector Local on, and it reads before the desktop's folders are
// set, so the CLI's own config folder counts there. Nothing in this process resolves it the way the engine's config
// does, so once preferAppEnv has set the desktop's folders, and before app.whenReady, it is resolved here from the
// sources the desktop's engine reads: company policy, read as the engine's config reads it (only what an administrator
// alone could have written), the global config folder prepareSidecarEnv (sidecar.ts) points the engine at, the
// desktop's own folder (VECTOR_AGENT_CONFIG_DIR), and the engine's state folder (LocalStartup.policy). While the app
// runs, local-mode.ts reads them again each time it compares with the engine (connectDesktopLocal).

/** Resolves this process's Vector Local policy from the desktop's own folders; preferAppEnv must have run. */
export function resolveDesktopLocal(userData: string) {
  return Egress.configure(readDesktopLocal(userData))
}

/** Vector Local's policy as the desktop's folders say it now, without applying it. */
export function readDesktopLocal(userData: string) {
  return LocalStartup.policy(desktopLocalFolders(userData))
}

/** The folders the desktop's engine reads Vector Local from: its global config folder and its state folder. */
export function desktopLocalFolders(userData: string) {
  return {
    config: join(process.env.XDG_CONFIG_HOME ?? join(userData, "xdg-config"), "vector"),
    state: join(process.env.XDG_STATE_HOME ?? join(userData, "xdg-state"), "vector"),
  }
}
