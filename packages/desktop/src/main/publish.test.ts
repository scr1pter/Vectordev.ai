import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
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

const { publishProject, runVercel } = await import("./publish")
const { cloudProjectScopeKey, listDeployments, setBuildSettings, setEnv } = await import("./cloud-console")
const { encryptCloudCredential } = await import("./cloud-connections")
const { getStore } = await import("./store")

let directory = ""

beforeEach(async () => {
  stores.clear()
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 6).toString("base64")
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

// Vercel connected in Vector Cloud with a placeholder token and, unless told
// otherwise, a Vercel project linked to this one.
function connectVercel(project: string, link = true) {
  getStore("cloud-provider-connections").set("records", [
    {
      provider: "vercel",
      accessToken: encryptCloudCredential("fixture-vercel-token"),
      connectedAt: "2026-01-01T00:00:00.000Z",
    },
  ])
  if (!link) return
  getStore("cloud-provider-links").set(cloudProjectScopeKey(project), [
    { provider: "vercel", projectId: "prj_shop", projectName: "shop", linkedAt: "2026-01-01T00:00:00.000Z" },
  ])
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

describe.skipIf(process.platform === "win32")("publishing a project", () => {
  test("deploys with the Vercel CLI and never rewrites the project's source", async () => {
    const project = await mkdtemp(join(tmpdir(), "vector-publish-project-"))
    try {
      const page = "<!doctype html>\n<html>\n  <body>\n    <h1>Shop</h1>\n  </body>\n</html>\n"
      await writeFile(join(project, "index.html"), page)
      await mkdir(join(project, "public"))
      await writeFile(join(project, "public", "index.html"), page)
      setBuildSettings(project, undefined, {
        framework: "Static",
        packageManager: "static",
        installCommand: "",
        testCommand: "",
        buildCommand: "",
        outputDirectory: ".",
        nodeVersion: "",
        healthPath: "/",
        requiredChecks: { test: false, secrets: true, health: false, browser: false },
      })
      connectVercel(project)
      const cli = await fakeVercel()
      const result = await publishProject(
        { projectPath: project, target: "vercel", production: false },
        undefined,
        async () => [{ id: "vercel", label: "Vercel", command: [cli], loginHint: "", available: true }],
      )
      expect(result).toMatchObject({ ok: true, target: "vercel", url: "https://fixture-app-abc123.vercel.app/" })
      expect(result.log).toContain("args --yes --project prj_shop")
      expect(result.log).not.toContain("fixture-vercel-token")
      expect(await readFile(join(project, "index.html"), "utf8")).toBe(page)
      expect(await readFile(join(project, "public", "index.html"), "utf8")).toBe(page)
      expect((await readdir(project)).sort()).toEqual(["index.html", "public"])
      expect(listDeployments(project)).toEqual([
        expect.objectContaining({ target: "vercel", environment: "preview", releaseStatus: "preview" }),
      ])
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  test("publishes a preview when production is not asked for", async () => {
    const project = await mkdtemp(join(tmpdir(), "vector-publish-project-"))
    try {
      await writeFile(join(project, "index.html"), "<h1>Shop</h1>\n")
      setBuildSettings(project, undefined, staticSettings(""))
      connectVercel(project)
      const cli = await fakeVercel()
      const result = await publishProject({ projectPath: project, target: "vercel" }, undefined, async () => [
        { id: "vercel", label: "Vercel", command: [cli], loginHint: "", available: true },
      ])
      expect(result.ok).toBe(true)
      expect(listDeployments(project)).toEqual([
        expect.objectContaining({ environment: "preview", releaseStatus: "preview", promotedAt: undefined }),
      ])
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  test("refuses a Vercel CLI login alone, and a connected account with no linked project", async () => {
    const project = await mkdtemp(join(tmpdir(), "vector-publish-project-"))
    try {
      await writeFile(join(project, "index.html"), "<h1>Shop</h1>\n")
      setBuildSettings(project, undefined, staticSettings(""))
      const cli = await fakeVercel()
      // A machine signed in with the CLI reports the target available, but a
      // deploy without a linked project would create or link one nobody chose.
      const targets = async () => [
        { id: "vercel" as const, label: "Vercel", command: [cli], loginHint: "", available: true, account: "cli-user" },
      ]
      expect(await publishProject({ projectPath: project, target: "vercel" }, undefined, targets)).toEqual({
        ok: false,
        target: "vercel",
        log: "",
        error: "Connect Vercel in Vector Cloud > Connections with an access token.",
      })
      connectVercel(project, false)
      expect(await publishProject({ projectPath: project, target: "vercel" }, undefined, targets)).toEqual({
        ok: false,
        target: "vercel",
        log: "",
        error: "Link a Vercel project in Vector Cloud > Connections before publishing.",
      })
      expect(listDeployments(project)).toEqual([])
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  test("returns a failed build's evidence with the project's secrets redacted", async () => {
    const project = await mkdtemp(join(tmpdir(), "vector-publish-project-"))
    try {
      await writeFile(join(project, "index.html"), "<h1>Shop</h1>\n")
      setEnv(project, undefined, "PAYMENTS_SECRET", "fixture-payments-value-123", "server")
      setBuildSettings(
        project,
        undefined,
        staticSettings('echo "connecting with fixture-payments-value-123" && exit 3'),
      )
      connectVercel(project)
      const result = await publishProject({ projectPath: project, target: "vercel" }, undefined, async () => [
        { id: "vercel", label: "Vercel", command: ["never-run"], loginHint: "", available: true },
      ])
      expect(result.ok).toBe(false)
      const build = result.checks?.find((check) => check.id === "build")
      expect(build).toMatchObject({ status: "failed", required: true, details: "Production build failed." })
      expect(build?.output).toContain("connecting with [redacted]")
      expect(JSON.stringify(result)).not.toContain("fixture-payments-value-123")
      expect(listDeployments(project)).toEqual([])
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})

function staticSettings(buildCommand: string) {
  return {
    framework: "Static",
    packageManager: "static" as const,
    installCommand: "",
    testCommand: "",
    buildCommand,
    outputDirectory: ".",
    nodeVersion: "",
    healthPath: "/",
    requiredChecks: { test: false, secrets: true, health: false, browser: false },
  }
}
