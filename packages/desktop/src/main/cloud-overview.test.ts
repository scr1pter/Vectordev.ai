import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const userDataPath = join(tmpdir(), "vector-cloud-overview-test")
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

// An in-memory electron-store that reports changes the way the real one does.
// Removing an entry from `stores` stands for a store file deleted when it
// emptied: the next getStore returns a new instance.
type FakeStore = ReturnType<typeof fakeStore>
const stores = new Map<string, FakeStore>()
function fakeStore(name: string) {
  const values = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  const path = join(userDataPath, name)
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(path, "", { flag: "a" })
  const changed = () => listeners.forEach((listener) => listener())
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value)
      changed()
    },
    delete: (key: string) => {
      values.delete(key)
      changed()
    },
    onDidAnyChange: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    path,
  }
}
// Bun keeps a module mock for the rest of the run, so it carries every export a later test file's imports bind.
mock.module("./store", () => ({
  getStore: (name = "default") => {
    const existing = stores.get(name)
    if (existing) return existing
    const created = fakeStore(name)
    stores.set(name, created)
    return created
  },
  removeStoreFileIfEmpty: () => undefined,
  removeStoreFile: () => undefined,
}))

const { cloudOverview, recordPublishAttempt, watchCloudChanges } = await import("./cloud-overview")
const { cloudProjectScopeKey, connectDatabase, recordDeployment } = await import("./cloud-console")
const { getStore } = await import("./store")

let project = ""
let worktree = ""

beforeEach(async () => {
  stores.clear()
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64")
  project = await mkdtemp(join(tmpdir(), "vector-cloud-overview-project-"))
  worktree = await mkdtemp(join(tmpdir(), "vector-cloud-overview-worktree-"))
})

afterEach(async () => {
  await rm(project, { recursive: true, force: true })
  await rm(worktree, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
})

function connectVercel() {
  getStore("cloud-provider-connections").set("records", [
    { provider: "vercel", accessToken: "never-decrypt-fixture", account: "fixture-account", connectedAt: "2026-01-01" },
  ])
  getStore("cloud-provider-links").set(cloudProjectScopeKey(project), [
    { provider: "vercel", projectId: "prj_shop", projectName: "shop", linkedAt: "2026-01-01" },
  ])
}

function release(environment: "preview" | "production", checks: { label: string; status: "passed" | "failed" }[]) {
  return recordDeployment({
    slug: `shop-${environment}`,
    url: `https://shop-${environment}.vercel.app`,
    name: "shop",
    projectPath: project,
    target: "vercel",
    environment,
    checks: checks.map((check) => ({
      id: check.label,
      type: "browser",
      label: check.label,
      status: check.status,
      required: true,
      details: `${check.label} ${check.status}.`,
      checkedAt: "2026-01-01T00:00:00.000Z",
    })),
  })
}

describe("cloud overview", () => {
  test("summarizes a project's hosting, database, releases and last failed publish from an agent worktree", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project })
    await writeFile(join(project, "index.html"), "<h1>Shop</h1>\n")
    execFileSync("git", ["add", "."], { cwd: project })
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "init"],
      {
        cwd: project,
      },
    )
    connectVercel()
    await connectDatabase(project, undefined, {
      provider: "supabase",
      url: "https://fixtureref.supabase.co",
      anonKey: "sb_publishable_fixture_key",
      projectRef: "fixtureref",
      projectName: "shop-db",
    })
    release("production", [{ label: "Browser smoke test", status: "passed" }])
    release("preview", [{ label: "Browser smoke test", status: "failed" }])
    recordPublishAttempt(project, false, {
      ok: false,
      target: "vercel",
      error: "Required pre-deploy checks failed.",
      log: "build output",
      checks: [
        {
          id: "install",
          type: "install",
          label: "Install dependencies",
          status: "passed",
          required: true,
          checkedAt: "",
        },
        {
          id: "build",
          type: "build",
          label: "Production build",
          status: "failed",
          required: true,
          details: "Production build failed.",
          output: "error TS2322",
          checkedAt: "",
        },
      ],
    })

    const workspace = { id: "ws_1", name: "checkout", sourcePath: project, isolatedPath: worktree }
    const fromWorktree = await cloudOverview(worktree, [workspace])
    expect(fromWorktree).toMatchObject({
      projectPath: project,
      directory: worktree,
      workspace: { id: "ws_1", name: "checkout" },
      hosting: { provider: "Vercel", connected: true, account: "fixture-account", project: { name: "shop" } },
      database: { provider: "Supabase", connected: true, name: "shop-db", accountConnected: false },
      latest: {
        environment: "preview",
        releaseStatus: "preview",
        failedChecks: [{ label: "Browser smoke test", details: "Browser smoke test failed." }],
      },
      production: { environment: "production", releaseStatus: "current", url: "https://shop-production.vercel.app/" },
      failure: {
        environment: "preview",
        error: "Required pre-deploy checks failed.",
        checks: [{ label: "Production build", details: "Production build failed.", output: "error TS2322" }],
        log: "build output",
      },
    })
    // The worktree is not a git repository; the main project is, and connecting
    // the database wrote its .env and client there.
    expect(fromWorktree.git).toBeUndefined()
    expect((await cloudOverview(project)).git).toMatchObject({ branch: "main", dirty: true })
    // Names and states only: no token, key or environment value.
    const serialized = JSON.stringify(fromWorktree)
    expect(serialized).not.toContain("never-decrypt-fixture")
    expect(serialized).not.toContain("sb_publishable_fixture_key")
  })

  test("a publish that produced a deployment replaces the remembered failure", async () => {
    recordPublishAttempt(project, true, { ok: false, target: "vercel", log: "", error: "Vercel exited with code 1." })
    expect((await cloudOverview(project)).failure).toMatchObject({ environment: "production" })
    recordPublishAttempt(project, false, { ok: true, target: "vercel", log: "", deploymentId: "dep_1" })
    const overview = await cloudOverview(project)
    expect(overview.failure).toBeUndefined()
    expect(overview.hosting).toEqual({ provider: "Vercel", connected: false, account: undefined, project: undefined })
    expect(overview.database).toMatchObject({ connected: false })
    expect(overview.latest).toBeUndefined()
  })

  test("reports a burst of changes once, follows a recreated store, and stops when asked", async () => {
    const changes: number[] = []
    const stop = watchCloudChanges(() => changes.push(Date.now()))
    const settle = () => new Promise((done) => setTimeout(done, 300))
    try {
      release("preview", [])
      release("preview", [])
      await settle()
      expect(changes).toHaveLength(1)

      // Disconnecting the last account deletes the empty store; the next read
      // creates a new one, which has to be watched too.
      stores.delete("cloud-provider-links")
      await cloudOverview(project)
      getStore("cloud-provider-links").set(cloudProjectScopeKey(project), [])
      await settle()
      expect(changes).toHaveLength(2)

      recordPublishAttempt(project, false, { ok: false, target: "vercel", log: "", error: "failed" })
      await settle()
      expect(changes).toHaveLength(3)
    } finally {
      stop()
    }
    release("preview", [])
    await settle()
    expect(changes).toHaveLength(3)
  })
})
