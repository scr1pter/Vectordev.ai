import { afterEach, describe, expect, mock, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const electronMock = {
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  shell: { openExternal: async () => {} },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))

const { runGit } = await import("./parallel-workspaces")

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("parallel workspace git environment", () => {
  test("repository-controlled git aliases cannot read Vector runtime secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vector-git-env-"))
    directories.push(directory)
    const output = join(directory, "environment.json")
    const script = join(directory, "capture.mjs")
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs"
writeFileSync(process.argv[2], JSON.stringify({
  vault: process.env.VECTOR_CREDENTIAL_KEY,
  cloud: process.env.VECTOR_CLOUD_TOKEN,
  server: process.env.OPENCODE_SERVER_PASSWORD,
  provider: process.env.OPENAI_API_KEY,
}))
`,
    )
    await chmod(script, 0o700)
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: directory }).exitCode).toBe(0)
    expect(
      Bun.spawnSync(["git", "config", "alias.capture", `!${process.execPath} ${script} ${output}`], { cwd: directory })
        .exitCode,
    ).toBe(0)

    const previous = {
      VECTOR_CREDENTIAL_KEY: process.env.VECTOR_CREDENTIAL_KEY,
      VECTOR_CLOUD_TOKEN: process.env.VECTOR_CLOUD_TOKEN,
      OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    }
    Object.assign(process.env, {
      VECTOR_CREDENTIAL_KEY: "vault-secret",
      VECTOR_CLOUD_TOKEN: "cloud-secret",
      OPENCODE_SERVER_PASSWORD: "server-secret",
      OPENAI_API_KEY: "provider-secret",
    })
    try {
      await runGit(["capture"], directory)
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
    }

    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ provider: "provider-secret" })
  })
})
