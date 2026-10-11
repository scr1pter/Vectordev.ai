import { afterAll, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "vector-server-credentials-"))
let available = true
// A stand-in keychain: sealed bytes differ from the plaintext, as with the real safeStorage.
const electronMock = {
  app: { getPath: () => home, isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(value).reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString(),
  },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))

const { deleteServerCredential, readServerCredential, saveServerCredential } = await import("./server-credentials")

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe("server credentials", () => {
  test("seals a saved password with the keychain and reads it back", () => {
    const url = "https://engine.example.test"
    expect(saveServerCredential(url, { username: "vector", password: "placeholder-password" })).toBe(true)

    expect(readFileSync(join(home, "vector.server-credentials"), "utf8")).not.toContain("placeholder-password")
    expect(readServerCredential(url)).toEqual({ username: "vector", password: "placeholder-password" })

    deleteServerCredential(url)
    expect(readServerCredential(url)).toBeUndefined()
  })

  test("saves nothing without a keychain, so the app keeps the password where it was", () => {
    available = false
    try {
      expect(saveServerCredential("http://192.168.1.20:4096", { password: "placeholder-password" })).toBe(false)
      expect(readServerCredential("http://192.168.1.20:4096")).toBeUndefined()
    } finally {
      available = true
    }
  })
})
