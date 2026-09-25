import { BrowserWindow, safeStorage, shell } from "electron"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { createVectorAccount, syncVectorAccount } from "./vector-account"

const STORE = "vector-account"
const engine: { ready?: () => Promise<{ url: string; username: string | null; password: string | null }> } = {}

async function available() {
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return false
  return (await safeStorage.isAsyncEncryptionAvailable().catch(() => false)) || safeStorage.isEncryptionAvailable()
}

export const vectorAccount = createVectorAccount({
  read: () => getStore(STORE).get("account"),
  write: (value) => getStore(STORE).set("account", value),
  clear: async () => {
    getStore(STORE).delete("account")
    await removeStoreFileIfEmpty(STORE)
  },
  available,
  encrypt: async (token) => {
    if (!(await available())) throw new Error("Secure storage is unavailable.")
    const encrypted = (await safeStorage.isAsyncEncryptionAvailable().catch(() => false))
      ? await safeStorage.encryptStringAsync(token)
      : safeStorage.encryptString(token)
    return encrypted.toString("base64")
  },
  decrypt: async (ciphertext) => {
    if (!(await available())) throw new Error("Secure storage is unavailable.")
    const encrypted = Buffer.from(ciphertext, "base64")
    if (await safeStorage.isAsyncEncryptionAvailable().catch(() => false))
      return (await safeStorage.decryptStringAsync(encrypted)).result
    return safeStorage.decryptString(encrypted)
  },
  openBrowser: (url) => shell.openExternal(url),
  fetch: (url, init) => fetch(url, init),
  sync: async (token) => {
    if (!engine.ready) throw new Error("The local server is not ready.")
    await syncVectorAccount(await engine.ready(), token)
  },
  changed: (status) =>
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send("vector-account-changed", status)
    }),
})

export function initializeVectorAccount(ready: NonNullable<typeof engine.ready>) {
  engine.ready = ready
}
