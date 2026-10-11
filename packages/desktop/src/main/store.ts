import Store from "electron-store"
import electron from "electron"
import { rmSync } from "node:fs"

import { SETTINGS_STORE } from "./store-keys"
import { deleteStoreFileIfEmpty } from "./store-cleanup"
import { requireStoreName, resolveStorePath } from "./store-path"

const cache = new Map<string, Store>()

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: a package-scoped default folder vs good: the configured Vector user data folder).
export function getStore(name = SETTINGS_STORE) {
  const safeName = requireStoreName(name)
  const cached = cache.get(safeName)
  if (cached) return cached
  const next = new Store({
    name: safeName,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(safeName, next)
  return next
}

export async function removeStoreFileIfEmpty(name: string) {
  const safeName = requireStoreName(name)
  if (await deleteStoreFileIfEmpty(electron.app.getPath("userData"), safeName)) cache.delete(safeName)
}

export function removeStoreFile(name: string) {
  const safeName = requireStoreName(name)
  rmSync(resolveStorePath(electron.app.getPath("userData"), safeName), { force: true })
  cache.delete(safeName)
}
