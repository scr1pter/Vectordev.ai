export const SETTINGS_STORE = "vector.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_SERVERS_KEY = "wslServers"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"
export const WINDOW_IDS_KEY = "windowIds"
export const GITHUB_CLONE_PARENT_KEY = "githubCloneParent"

// The renderer's own stores all end in .dat (default.dat, vector.global.dat, vector.workspace.*.dat, ...). Every other
// store belongs to the main process, including vector.settings and the encrypted sign-in tokens, and the store IPC must
// not let a renderer read or rewrite them.
export function isRendererStoreName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9._-]+\.dat$/.test(name)
}
