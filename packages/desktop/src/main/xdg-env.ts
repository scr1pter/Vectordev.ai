import { dirname } from "node:path"

const APP_XDG_HOMES = {
  XDG_DATA_HOME: "xdg-data",
  XDG_CONFIG_HOME: "xdg-config",
  XDG_CACHE_HOME: "xdg-cache",
  XDG_STATE_HOME: "xdg-state",
}

// Vector 1.99.99 and earlier wrote <userData>/xdg-* into the main process environment. On Linux Electron derives
// appData from XDG_CONFIG_HOME, and app.relaunch() and electron-updater's AppImage install hand this environment to the
// next launch, so Restart and every Linux update opened an empty profile nested inside the real one. Those values were
// only written when the variable was unset, so one ending in /<appId>/xdg-* can only be that leak. Returns the keys to
// drop and, when XDG_CONFIG_HOME leaked, the appData Electron would have used without it.
export function leakedXdgHomes(env: Record<string, string | undefined>, appId: string) {
  const keys = Object.entries(APP_XDG_HOMES)
    .filter((entry) => env[entry[0]]?.endsWith(`/${appId}/${entry[1]}`))
    .map((entry) => entry[0])
  const config = keys.includes("XDG_CONFIG_HOME") ? env.XDG_CONFIG_HOME : undefined
  return { keys, appData: config ? dirname(dirname(config)) : undefined }
}
