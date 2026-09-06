import { beforeEach, describe, expect, mock, test } from "bun:test"
import { join } from "node:path"

// cloud-logs reaches electron-store through ./store and cloud-connections
// imports electron's shell, so both are mocked before the module is imported.
const userDataPath = "/tmp/vector-cloud-logs-test"
const store = new Map<string, Map<string, unknown>>()
const electronMock = { app: { getPath: () => userDataPath }, shell: { openExternal: async () => {} } }
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => bucket.set(key, value),
      delete: (key: string) => bucket.delete(key),
      path: join(userDataPath, name),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const { boundLogLines, fetchCloudLogs, netlifyLogEntries, truncateLogTail, vercelLogEntries } = await import(
  "./cloud-logs"
)
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

  test("composes a Netlify tail from the deploy state, summary and build error", () => {
    expect(
      netlifyLogEntries(
        {
          state: "error",
          error_message: "Build script returned non-zero exit code: 2",
          summary: { messages: [{ type: "error", title: "Build failed", description: "tsc found 3 errors" }] },
        },
        { error: "Command failed with exit code 2: bun run build" },
      ),
    ).toEqual([
      { text: "state: error" },
      { text: "[error] Build failed — tsc found 3 errors" },
      { text: "[error] Build script returned non-zero exit code: 2" },
      { text: "[error] Command failed with exit code 2: bun run build" },
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

  test("reads the Vercel deployment events and redacts the project's own secrets", async () => {
    seedDeployment()
    seedVercelConnection()
    seed("cloud-projects", cloudProjectScopeKey(PROJECT), {
      env: [{ key: "API_KEY", value: "s3cr3t-value" }],
      database: null,
      domains: [],
      build: null,
    })

    const requests: string[] = []
    const report = await fetchCloudLogs({ projectPath: PROJECT, limit: 5 }, async (input, init) => {
      requests.push(String(input))
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer vercel-token")
      return Response.json([
        { type: "stdout", created: 2, payload: { text: "API_KEY=s3cr3t-value" } },
        { type: "stderr", created: 3, payload: { text: "TypeError: undefined is not a function" } },
        { type: "stdout", created: 1, payload: { text: "Build started" } },
      ])
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("https://api.vercel.com/v3/deployments/demo-abc.vercel.app/events")
    expect(requests[0]).toContain("limit=5")
    expect(requests[0]).toContain("teamId=team_9")
    expect(report.ok).toBe(true)
    expect(report.deploymentId).toBe("dep_1")
    expect(report.url).toBe("https://demo-abc.vercel.app/")
    expect(report.logs?.source).toBe("provider")
    expect(report.logs?.tail).toBe("Build started\nAPI_KEY=[REDACTED]\n[stderr] TypeError: undefined is not a function")
    expect(JSON.stringify(report)).not.toContain("s3cr3t-value")
  })

  test("falls back to the recorded build output when the provider call fails", async () => {
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
    seedVercelConnection()

    const report = await fetchCloudLogs({ projectPath: PROJECT }, async () =>
      Response.json({ error: { message: "Deployment not found" } }, { status: 404 }),
    )

    expect(report.ok).toBe(true)
    expect(report.logs?.source).toBe("build")
    expect(report.logs?.detail).toContain("Falling back")
    expect(report.logs?.tail).toBe("recorded build output\n[Health] failed\nGET / returned 500")
  })

  test("explains the missing connection when no provider token is stored", async () => {
    seedDeployment({ log: undefined })
    const report = await fetchCloudLogs({ projectPath: PROJECT }, async () => {
      throw new Error("no network call expected")
    })
    expect(report.ok).toBe(true)
    expect(report.logs?.detail).toContain("Connect Vercel")
    expect(report.logs?.tail).toBe("")
  })
})
