import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// publish reaches electron-store through cloud-console and electron's shell
// through cloud-connections, so both are mocked before it is imported.
const userDataPath = join(tmpdir(), "vector-publish-test")
const electron = {
  app: { getPath: () => userDataPath },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}
mock.module("electron", () => ({ default: electron, ...electron }))
const stores = new Map<string, Map<string, unknown>>()
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!stores.has(name)) stores.set(name, new Map())
    const bucket = stores.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => {
        mkdirSync(userDataPath, { recursive: true })
        writeFileSync(join(userDataPath, name), "", { flag: "a" })
        bucket.set(key, value)
      },
      delete: (key: string) => bucket.delete(key),
      path: join(userDataPath, name),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const { runVercel } = await import("./publish")

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vector-publish-cli-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

// A stand-in for the Vercel CLI that echoes its token back in two separate
// writes, so the token arrives split across output chunks.
async function fakeVercel() {
  const path = join(directory, "vercel")
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'printf "token-set=%s\\n" "${VERCEL_TOKEN:+yes}"',
      'printf "auth %s" "$(printf %s "$VERCEL_TOKEN" | cut -c1-10)"',
      "sleep 0.2",
      'printf "%s\\n" "$(printf %s "$VERCEL_TOKEN" | cut -c11-)"',
      'printf "args %s\\n" "$*"',
      'printf "Preview: https://fixture-app-abc123.vercel.app\\n"',
    ].join("\n"),
  )
  await chmod(path, 0o755)
  return path
}

describe.skipIf(process.platform === "win32")("Vercel CLI runs", () => {
  test("give the CLI the token but never stream, log or return it", async () => {
    const token = "fixtureVercelToken0123456789"
    const chunks: string[] = []
    const result = await runVercel({
      command: [await fakeVercel()],
      args: ["--yes", "--project", "prj_fixture"],
      cwd: directory,
      token,
      onOutput: (output) => chunks.push(output),
    })
    expect(result.ok).toBe(true)
    expect(result.log).toContain("token-set=yes")
    expect(result.log).toContain("auth [redacted]")
    expect(result.log).toContain("args --yes --project prj_fixture")
    expect(result.log).not.toContain(token)
    expect(result.log).not.toContain(token.slice(0, 10))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join("")).toBe(result.log)
    expect(chunks.join("")).not.toContain(token)
  })

  test("set no token when the user signed in with the CLI instead", async () => {
    const result = await runVercel({ command: [await fakeVercel()], args: [], cwd: directory })
    expect(result.log).toContain("token-set=\n")
  })
})
