import { beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { fakeVercel } from "../../test/fake-vercel"

// cloud-logs reaches electron-store through ./store and cloud-connections
// imports electron's shell, so both are mocked before the module is imported.
const userDataPath = "/tmp/vector-cloud-logs-test"
const store = new Map<string, Map<string, unknown>>()
// Bun keeps a module mock for the rest of the run, so it carries every export a later test file's imports bind.
const electronMock = {
  app: { getPath: () => userDataPath },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      // electron-store writes its file on set; cloud-console tightens its mode after.
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

const { boundLogLines, fetchCloudLogs, truncateLogTail, vercelLogEntries } = await import("./cloud-logs")
const { cloudProjectScopeKey } = await import("./cloud-console")
const { encryptCloudCredential } = await import("./cloud-credential-vault")

const PROJECT = "/tmp/demo-app"

function seed(name: string, key: string, value: unknown) {
  if (!store.has(name)) store.set(name, new Map())
  store.get(name)!.set(key, value)
}

function seedDeployment(overrides: Record<string, unknown> = {}) {
  seed("cloud-deployments", "records", [
    {
      id: "dep_1",
      slug: "demo",
      url: "https://demo-abc.vercel.app",
      name: "demo",
      projectPath: PROJECT,
      target: "vercel",
      createdAt: "2026-09-01T10:00:00.000Z",
      environment: "production",
      status: "ready",
      log: "recorded build output",
      checks: [],
      ...overrides,
    },
  ])
}

function seedVercelConnection() {
  seed("cloud-provider-connections", "records", [
    {
      provider: "vercel",
      accessToken: encryptCloudCredential("vercel-token"),
      connectedAt: "2026-09-01T09:00:00.000Z",
      teamId: "team_9",
    },
  ])
}

beforeEach(() => {
  store.clear()
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 3).toString("base64")
})

describe("log tail truncation", () => {
  test("puts the newest line last even when the provider returns newest first", () => {
    const events = Array.from({ length: 10 }, (_, index) => ({ at: 1_000 + index, text: `line ${index}` })).reverse()
    expect(truncateLogTail(events, 3)).toEqual({
      log: "line 7\nline 8\nline 9",
      lines: 3,
      droppedLines: 7,
      truncated: true,
    })
  })

  test("keeps composed order when entries carry no timestamps and drops blank lines", () => {
    expect(truncateLogTail([{ text: "first\n\n  second  " }, { text: "third" }], 10).log).toBe("first\n  second\nthird")
  })

  test("caps total characters and counts everything it dropped", () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({ text: `${"x".repeat(100)}${index}` }))
    const tail = truncateLogTail(entries, 50, 500)
    expect(tail.log.length).toBeLessThanOrEqual(500)
    expect(tail.lines + tail.droppedLines).toBe(50)
    expect(tail.log.endsWith("49")).toBe(true)
  })

  test("clamps a single enormous line instead of returning it whole", () => {
    const tail = truncateLogTail([{ text: "y".repeat(1_000) }], 10)
    expect(tail.log).toContain("[+600 chars]")
    expect(tail.log.length).toBeLessThan(500)
  })

  test("bounds the requested line count", () => {
    expect(boundLogLines(undefined)).toBe(100)
    expect(boundLogLines(0)).toBe(1)
    expect(boundLogLines(12.7)).toBe(12)
    expect(boundLogLines(5_000)).toBe(500)
  })
})

describe("provider log parsing", () => {
  test("reads Vercel event payloads and marks the error stream", () => {
    expect(
      vercelLogEntries({
        events: [
          { type: "stdout", created: 1, payload: { text: "ready" } },
          { type: "stderr", created: 2, payload: { text: "boom" } },
          { type: "stdout", created: 3, payload: {} },
        ],
      }),
    ).toEqual([
      { at: 1, text: "ready" },
      { at: 2, text: "[stderr] boom" },
    ])
  })
})

describe("fetchCloudLogs", () => {
  test("asks for setup instead of throwing when nothing has been published", async () => {
    const report = await fetchCloudLogs({ projectPath: PROJECT }, async () => {
      throw new Error("no network call expected")
    })
    expect(report).toMatchObject({ ok: false, needsSetup: true })
    expect(report.nextStep).toContain("Publish")
  })

  test("names the deployment ids it knows when the requested one is gone", async () => {
    seedDeployment()
    const report = await fetchCloudLogs({ projectPath: PROJECT, deploymentId: "dep_missing" }, async () => {
      throw new Error("no network call expected")
    })
    expect(report).toMatchObject({ ok: false, needsSetup: true })
    expect(report.nextStep).toContain("list_deployments")
  })

  // The linked project lives in team_1 while the connection's default is
  // team_9: the build log has to be read in the link's own team.
  function linkFakeProject(api: ReturnType<typeof fakeVercel>) {
    const remote = api.addProject({ name: "demo", teamId: "team_1" })
    seed("cloud-provider-links", cloudProjectScopeKey(PROJECT), [
      { provider: "vercel", projectId: remote.id, projectName: "demo", teamId: "team_1", linkedAt: "2026-09-01" },
    ])
    return remote
  }

  test("reads a recorded deployment's build events from the linked project's team and redacts secrets", async () => {
    const api = fakeVercel({ token: "vercel-token" })
    process.env.VECTOR_VERCEL_API_URL = api.url
    try {
      seedVercelConnection()
      const remote = linkFakeProject(api)
      api.addDeployment({
        projectId: remote.id,
        uid: "dpl_demo",
        url: "demo-abc.vercel.app",
        events: [
          { type: "stdout", created: 2, payload: { text: "API_KEY=s3cr3t-value" } },
          { type: "stderr", created: 3, payload: { text: "TypeError: undefined is not a function" } },
          { type: "stdout", created: 1, payload: { text: "Build started" } },
          { type: "stdout", created: 4, payload: { text: "auth vercel-token" } },
        ],
      })
      seedDeployment({ providerDeploymentId: "dpl_demo" })
      seed("cloud-projects", cloudProjectScopeKey(PROJECT), {
        env: [{ key: "API_KEY", value: "s3cr3t-value" }],
        database: null,
        domains: [],
        build: null,
      })

      const report = await fetchCloudLogs({ projectPath: PROJECT, deploymentId: "dep_1", limit: 5 })

      const events = api.requests("GET").find((item) => item.path === "/v3/deployments/dpl_demo/events")
      expect(events?.query).toMatchObject({ limit: "5", direction: "backward", teamId: "team_1" })
      expect(report.ok).toBe(true)
      expect(report.deploymentId).toBe("dep_1")
      expect(report.url).toBe("https://demo-abc.vercel.app/")
      expect(report.logs?.source).toBe("provider")
      expect(report.logs?.tail).toBe(
        "Build started\nAPI_KEY=[REDACTED]\n[stderr] TypeError: undefined is not a function\nauth [redacted]",
      )
      expect(JSON.stringify(report)).not.toContain("s3cr3t-value")
      // The connection's own token has no recognisable prefix; it is removed as an exact string.
      expect(JSON.stringify(report)).not.toContain("vercel-token")
    } finally {
      await api.stop()
      delete process.env.VECTOR_VERCEL_API_URL
    }
  })

  test("falls back to the recorded build output when Vercel cannot find the deployment", async () => {
    const api = fakeVercel({ token: "vercel-token" })
    process.env.VECTOR_VERCEL_API_URL = api.url
    try {
      seedVercelConnection()
      linkFakeProject(api)
      seedDeployment({
        checks: [
          {
            id: "check_1",
            type: "health",
            label: "Health",
            status: "failed",
            required: true,
            checkedAt: "2026-09-01T10:01:00.000Z",
            output: "GET / returned 500",
          },
        ],
      })

      const report = await fetchCloudLogs({ projectPath: PROJECT, deploymentId: "dep_1" })

      expect(report.ok).toBe(true)
      expect(report.logs?.source).toBe("build")
      expect(report.logs?.detail).toContain("Falling back")
      expect(report.logs?.tail).toBe("recorded build output\n[Health] failed\nGET / returned 500")
    } finally {
      await api.stop()
      delete process.env.VECTOR_VERCEL_API_URL
    }
  })

  test("shows the recorded output without calling Vercel when no project is linked", async () => {
    seedDeployment()
    seedVercelConnection()
    const report = await fetchCloudLogs({ projectPath: PROJECT }, async () => {
      throw new Error("no network call expected")
    })
    expect(report.ok).toBe(true)
    expect(report.logs?.detail).toContain("No Vercel project is linked")
    expect(report.logs?.tail).toBe("recorded build output")
  })
})
