import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let userDataPath = ""
let encryptionAvailable = true
let encryptFailure: Error | undefined
let decryptFailure: Error | undefined
const electronMock = {
  app: {
    isPackaged: true,
    getPath: () => userDataPath,
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => {
      if (encryptFailure) throw encryptFailure
      return Buffer.from(`sealed:${value}`)
    },
    decryptString: (value: Buffer) => {
      if (decryptFailure) throw decryptFailure
      return value.toString().replace(/^sealed:/, "")
    },
  },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))

const { setupSecureRuntimeSecrets } = await import("./secure-runtime")
const previousCredentialKey = process.env.VECTOR_CREDENTIAL_KEY
const previousMcpKey = process.env.VECTOR_MCP_AUTH_KEY
const previousRequirement = process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), "vector-secure-runtime-"))
  electronMock.app.isPackaged = true
  encryptionAvailable = true
  encryptFailure = undefined
  decryptFailure = undefined
  delete process.env.VECTOR_CREDENTIAL_KEY
  delete process.env.VECTOR_MCP_AUTH_KEY
  delete process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE
})

afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true })
  if (previousCredentialKey === undefined) delete process.env.VECTOR_CREDENTIAL_KEY
  else process.env.VECTOR_CREDENTIAL_KEY = previousCredentialKey
  if (previousMcpKey === undefined) delete process.env.VECTOR_MCP_AUTH_KEY
  else process.env.VECTOR_MCP_AUTH_KEY = previousMcpKey
  if (previousRequirement === undefined) delete process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE
  else process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE = previousRequirement
})

test("migrates the legacy file key into OS-backed encrypted storage", async () => {
  const key = Buffer.alloc(32, 9).toString("base64")
  const directory = join(userDataPath, "secure-runtime")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "credential-key.v1"), `${key}\n`)

  await setupSecureRuntimeSecrets()

  const stored = await readFile(join(directory, "credential-key.v1"), "utf8")
  expect(stored).not.toContain(key)
  expect(JSON.parse(stored)).toEqual({
    version: 2,
    ciphertext: Buffer.from(`sealed:${key}`).toString("base64"),
  })
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBe(key)
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBe(key)
  expect(process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE).toBe("1")

  await setupSecureRuntimeSecrets()
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBe(key)
})

test("fails closed in packaged builds without OS-backed secure storage", async () => {
  encryptionAvailable = false

  await expect(setupSecureRuntimeSecrets()).rejects.toThrow("no OS-backed secure storage")
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBeUndefined()
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBeUndefined()
})

test("explains OS credential-store access failures while sealing the key", async () => {
  const key = Buffer.alloc(32, 7).toString("base64")
  const directory = join(userDataPath, "secure-runtime")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "credential-key.v1"), `${key}\n`)
  encryptFailure = new Error("The user denied Keychain access")

  const error = await setupSecureRuntimeSecrets().catch((cause) => cause)

  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain("could not access the operating system's secure credential store")
  expect(error.cause).toBe(encryptFailure)
  expect(await readFile(join(directory, "credential-key.v1"), "utf8")).toBe(`${key}\n`)
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBeUndefined()
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBeUndefined()
})

test("explains OS credential-store access failures while opening the key", async () => {
  await setupSecureRuntimeSecrets()
  decryptFailure = new Error("The user denied Keychain access")
  delete process.env.VECTOR_CREDENTIAL_KEY
  delete process.env.VECTOR_MCP_AUTH_KEY

  const error = await setupSecureRuntimeSecrets().catch((cause) => cause)

  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain("could not access the operating system's secure credential store")
  expect(error.cause).toBe(decryptFailure)
  expect(process.env.VECTOR_CREDENTIAL_KEY).toBeUndefined()
  expect(process.env.VECTOR_MCP_AUTH_KEY).toBeUndefined()
})
