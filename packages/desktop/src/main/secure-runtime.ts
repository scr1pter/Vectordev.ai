import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"

const KEY_DIRECTORY = "secure-runtime"
const KEY_FILE = "credential-key.v1"

export async function setupSecureRuntimeSecrets() {
  const directory = join(app.getPath("userData"), KEY_DIRECTORY)
  const path = join(directory, KEY_FILE)
  const existing = await readFile(path, "utf8").then(readKey).catch(() => undefined)
  const key = existing ?? randomBytes(32)
  if (!existing) {
    await mkdir(directory, { recursive: true })
    await writeFile(path, `${key.toString("base64")}\n`, { mode: 0o600 })
    await chmod(path, 0o600).catch(() => undefined)
  }
  process.env.VECTOR_CREDENTIAL_KEY = key.toString("base64")
  process.env.VECTOR_MCP_AUTH_KEY = key.toString("base64")
}

function readKey(value: string) {
  const key = Buffer.from(value.trim(), "base64")
  if (key.byteLength !== 32) throw new Error("Vector's secure runtime key is invalid.")
  return key
}
