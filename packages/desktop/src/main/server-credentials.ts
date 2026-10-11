import { safeStorage } from "electron"
import { getStore } from "./store"

// Not a renderer store (those end in .dat), so the generic store IPC cannot read the sealed values.
const STORE = "vector.server-credentials"

export type ServerCredential = { username?: string; password: string }

/**
 * Passwords for remote Vector servers, sealed with the OS keychain (Keychain, DPAPI, libsecret). Without a real
 * keychain nothing is saved and the app keeps the password where it was.
 */
export function saveServerCredential(url: string, credential: ServerCredential) {
  if (!secure()) return false
  const sealed = safeStorage.encryptString(
    JSON.stringify({ username: credential.username, password: credential.password }),
  )
  getStore(STORE).set(key(url), sealed.toString("base64"))
  return true
}

export function readServerCredential(url: string): ServerCredential | undefined {
  const sealed = getStore(STORE).get(key(url))
  if (typeof sealed !== "string" || !secure()) return
  const value: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, "base64")))
  if (!value || typeof value !== "object" || !("password" in value) || typeof value.password !== "string") return
  const username = "username" in value && typeof value.username === "string" ? value.username : undefined
  return { username, password: value.password }
}

export function deleteServerCredential(url: string) {
  getStore(STORE).delete(key(url))
}

function secure() {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"
}

function key(url: string) {
  if (typeof url !== "string" || !URL.canParse(url)) throw new Error("Invalid server address")
  return url
}
