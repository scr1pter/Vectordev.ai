import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// cloud-provision reads the Supabase connection through ./store and hands off to
// cloud-console, which reaches electron for the user data path and chmods the
// store file it writes — so the fake store hands out real (empty) files.
const userDataPath = join(tmpdir(), "vector-cloud-provision-test")
const store = new Map<string, Map<string, unknown>>()
const electronMock = { app: { getPath: () => userDataPath }, shell: { openExternal: async () => {} } }
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    const path = join(userDataPath, name)
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(path, "", { flag: "a" })
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => bucket.set(key, value),
      delete: (key: string) => bucket.delete(key),
      path,
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const { createCloudDatabase, supabaseProjectName, uniqueProjectName } = await import("./cloud-provision")
const { cloudProjectScopeKey, getDatabase } = await import("./cloud-console")
const { decryptCloudCredential, encryptCloudCredential } = await import("./cloud-credential-vault")

let root = ""
let project = ""

function seed(name: string, key: string, value: unknown) {
  if (!store.has(name)) store.set(name, new Map())
  store.get(name)!.set(key, value)
}

function seedConnection() {
  seed("cloud-provider-connections", "records", [
    {
      provider: "supabase",
      accessToken: encryptCloudCredential("sbp_management_token"),
      account: "founder@example.com",
      connectedAt: "2026-09-01T09:00:00.000Z",
    },
  ])
}

function seedLinkedDatabase() {
  seed("cloud-projects", cloudProjectScopeKey(project), {
    env: [],
    database: {
      provider: "supabase",
      url: "https://alreadylinked1.supabase.co",
      anonKey: "anon-key",
      projectRef: "alreadylinked1",
      projectName: "already-linked",
      connectedAt: "2026-09-01T09:00:00.000Z",
    },
    domains: [],
    build: null,
  })
}

type FakeCall = { method: string; path: string; body?: Record<string, unknown> }

// A fake Management API: answers the four endpoints provisioning touches and
// remembers every call, so a test can prove what was and was not created.
function supabaseApi(
  options: {
    organizations?: { id: string; name: string; plan?: string }[]
    projects?: { id: string; name: string; organization_id?: string }[]
    statuses?: string[]
    onCreate?: (body: Record<string, unknown>) => Response | undefined
    onProject?: (attempt: number) => Response | undefined
    onKeys?: () => Response | undefined
  } = {},
) {
  const calls: FakeCall[] = []
  const created: Record<string, unknown>[] = []
  let polls = 0
  const statuses = options.statuses ?? ["ACTIVE_HEALTHY"]
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method, path: url.pathname, body })
    if (url.pathname === "/v1/organizations") {
      return Response.json(options.organizations ?? [{ id: "org_solo", name: "Solo" }])
    }
    if (url.pathname === "/v1/projects" && method === "GET") return Response.json(options.projects ?? [])
    if (url.pathname === "/v1/projects" && method === "POST") {
      const override = options.onCreate?.(body ?? {})
      if (override) return override
      created.push(body ?? {})
      return Response.json({ ref: "newprojectref01", name: body?.name, region: body?.region, status: "COMING_UP" })
    }
    const single = url.pathname.match(/^\/v1\/projects\/([^/]+)$/)
    if (single) {
      polls += 1
      const override = options.onProject?.(polls)
      if (override) return override
      return Response.json({
        ref: single[1],
        name: created[0]?.name ?? "resumed",
        region: "us-east-1",
        status: statuses[Math.min(polls - 1, statuses.length - 1)],
      })
    }
    if (url.pathname.endsWith("/api-keys")) {
      return options.onKeys?.() ?? Response.json([{ type: "publishable", api_key: "sb_publishable_realkey" }])
    }
    return Response.json({ message: `unexpected ${method} ${url.pathname}` }, { status: 500 })
  }
  return {
    request,
    calls,
    created,
    creates: () => calls.filter((call) => call.method === "POST" && call.path === "/v1/projects").length,
  }
}

const noWait = { wait: async () => {}, pollIntervalMs: 0 }

beforeEach(async () => {
  store.clear()
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 5).toString("base64")
  root = await mkdtemp(join(tmpdir(), "vector-provision-"))
  // A real directory name with spaces and punctuation, because the project name
  // Supabase is asked for is derived from it.
  project = join(root, "My Cool App!")
  await mkdir(project, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
})

describe("project name derivation", () => {
  test("sanitises the repository directory name", () => {
    expect(supabaseProjectName("/Users/dev/My Cool App!")).toBe("my-cool-app")
    expect(supabaseProjectName("/Users/dev/vector.dev_ai")).toBe("vector-dev-ai")
    expect(supabaseProjectName("/Users/dev/---")).toBe("vector-app")
    expect(supabaseProjectName("/Users/dev/" + "x".repeat(80))).toBe("x".repeat(48))
  })

  test("keeps the name unique against the names the organization already uses", () => {
    expect(uniqueProjectName("shop", [])).toBe("shop")
    expect(uniqueProjectName("shop", ["Shop"])).toBe("shop-2")
    expect(uniqueProjectName("shop", ["shop", "shop-2"])).toBe("shop-3")
  })
})

describe("createCloudDatabase", () => {
  test("creates the project, waits for it, and leaves a hand-linked project's state behind", async () => {
    seedConnection()
    const api = supabaseApi({
      projects: [{ id: "old", name: "my-cool-app", organization_id: "org_solo" }],
      statuses: ["COMING_UP", "ACTIVE_HEALTHY"],
    })

    const report = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })

    expect(report.ok).toBe(true)
    expect(report.createdNow).toBe(true)
    expect(report.database).toMatchObject({
      connected: true,
      provider: "supabase",
      host: "newprojectref01.supabase.co",
      projectRef: "newprojectref01",
    })
    expect(report.applied).toEqual({ written: ".env" })
    // The name the directory implies, made unique against the organization.
    expect(api.created[0]).toMatchObject({
      name: "my-cool-app-2",
      organization_id: "org_solo",
      region: "us-east-1",
    })

    // Indistinguishable from a project linked by hand: the same record shape
    // prepare_database reads, the same .env, the same client scaffold.
    expect(getDatabase(project)).toMatchObject({
      provider: "supabase",
      url: "https://newprojectref01.supabase.co",
      anonKey: "sb_publishable_realkey",
      projectRef: "newprojectref01",
      projectName: "my-cool-app-2",
      managedByOAuth: true,
    })
    const env = await readFile(join(project, ".env"), "utf8")
    expect(env).toContain("SUPABASE_URL=https://newprojectref01.supabase.co")
    expect(env).toContain("SUPABASE_ANON_KEY=sb_publishable_realkey")
    expect(await readFile(join(project, "src/lib/supabase.js"), "utf8")).toContain("createClient")
  })

  test("stores the generated password encrypted and never returns it", async () => {
    seedConnection()
    const api = supabaseApi()

    const report = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })

    const password = String(api.created[0].db_pass)
    expect(password.length).toBeGreaterThan(24)
    const record = store.get("cloud-database-credentials")?.get(cloudProjectScopeKey(project)) as {
      password: string
      projectRef: string
    }
    expect(record.projectRef).toBe("newprojectref01")
    expect(record.password).not.toContain(password)
    expect(decryptCloudCredential(record.password)).toBe(password)

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(password)
    expect(serialized).not.toContain("sbp_management_token")
    expect(await readFile(join(project, ".env"), "utf8")).not.toContain(password)
  })

  test("scrubs a generated secret Supabase quotes back in an error", async () => {
    seedConnection()
    let password = ""
    const api = supabaseApi({
      onCreate: (body) => {
        password = String(body.db_pass)
        return undefined
      },
      onProject: () => Response.json({ message: `db_pass ${password} was rejected` }, { status: 400 }),
    })

    const report = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })

    expect(report.ok).toBe(false)
    expect(report.error).toContain("[redacted]")
    expect(JSON.stringify(report)).not.toContain(password)
    expect(JSON.stringify(report)).not.toContain("sbp_management_token")
  })

  test("asks which organization to use instead of guessing", async () => {
    seedConnection()
    const api = supabaseApi({
      organizations: [
        { id: "org_a", name: "Personal" },
        { id: "org_b", name: "Acme", plan: "free" },
      ],
    })

    const report = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })

    expect(report).toMatchObject({ ok: false, needsChoice: true })
    expect(report.organizations).toEqual([
      { id: "org_a", name: "Personal", plan: undefined },
      { id: "org_b", name: "Acme", plan: "free" },
    ])
    expect(report.nextStep).toContain("organizationId")
    expect(api.creates()).toBe(0)
  })

  test("uses the only organization without being told, and the named one when there are several", async () => {
    seedConnection()
    const solo = supabaseApi()
    const soloReport = await createCloudDatabase({ projectPath: project }, { request: solo.request, ...noWait })
    expect(soloReport.ok).toBe(true)
    expect(solo.created[0].organization_id).toBe("org_solo")

    store.clear()
    seedConnection()
    const several = supabaseApi({
      organizations: [
        { id: "org_a", name: "Personal" },
        { id: "org_b", name: "Acme" },
      ],
    })
    const report = await createCloudDatabase(
      { projectPath: project, organizationId: "org_b", region: "eu-west-2" },
      { request: several.request, ...noWait },
    )
    expect(report.ok).toBe(true)
    expect(several.created[0]).toMatchObject({ organization_id: "org_b", region: "eu-west-2" })
  })

  test("reports the organizations again when the chosen id is not on the account", async () => {
    seedConnection()
    const api = supabaseApi({
      organizations: [
        { id: "org_a", name: "Personal" },
        { id: "org_b", name: "Acme" },
      ],
    })

    const report = await createCloudDatabase(
      { projectPath: project, organizationId: "org_gone" },
      { request: api.request, ...noWait },
    )

    expect(report).toMatchObject({ ok: false, needsChoice: true })
    expect(report.error).toContain("org_gone")
    expect(report.organizations).toHaveLength(2)
    expect(api.creates()).toBe(0)
  })

  test("returns the database this project already has instead of creating a second one", async () => {
    seedConnection()
    seedLinkedDatabase()
    const api = supabaseApi()

    const report = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })

    expect(report).toMatchObject({ ok: true, createdNow: false })
    expect(report.database).toMatchObject({ host: "alreadylinked1.supabase.co", projectRef: "alreadylinked1" })
    expect(report.nextStep).toContain("prepare_database")
    expect(api.calls).toHaveLength(0)
  })

  test("force creates a second project even though one is linked", async () => {
    seedConnection()
    seedLinkedDatabase()
    const api = supabaseApi()

    const report = await createCloudDatabase({ projectPath: project, force: true }, { request: api.request, ...noWait })

    expect(report).toMatchObject({ ok: true, createdNow: true })
    expect(api.creates()).toBe(1)
  })

  test("asks for a Supabase account when none is connected, without calling the API", async () => {
    const api = supabaseApi()

    const report = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })

    expect(report).toMatchObject({ ok: false, needsSetup: true })
    expect(report.error).toContain("Supabase is not connected")
    expect(report.nextStep).toContain("Vector Cloud > Connections")
    expect(api.calls).toHaveLength(0)
  })

  test("gives up waiting after a bounded number of polls and resumes the same project next time", async () => {
    seedConnection()
    const api = supabaseApi({ statuses: ["COMING_UP", "COMING_UP", "COMING_UP", "ACTIVE_HEALTHY"] })

    const timedOut = await createCloudDatabase(
      { projectPath: project },
      { request: api.request, pollAttempts: 3, ...noWait },
    )
    expect(timedOut.ok).toBe(false)
    expect(timedOut.error).toContain("COMING_UP")
    expect(timedOut.nextStep).toContain("Do not create another one")
    expect(timedOut.nextStep).toContain("newprojectref01")
    expect(getDatabase(project)).toBeNull()

    // A project that costs money is created once, never once per attempt.
    const resumed = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })
    expect(resumed).toMatchObject({ ok: true, createdNow: true })
    expect(api.creates()).toBe(1)
    expect(getDatabase(project)).toMatchObject({ projectRef: "newprojectref01" })
  })

  test("creates a fresh project when the linked one was disconnected on purpose", async () => {
    seedConnection()
    const first = supabaseApi()
    await createCloudDatabase({ projectPath: project }, { request: first.request, ...noWait })

    // What Vector Cloud > Database does when the user disconnects a database.
    const { disconnectDatabase } = await import("./cloud-console")
    disconnectDatabase(project)

    const second = supabaseApi({ projects: [{ id: "p", name: "my-cool-app", organization_id: "org_solo" }] })
    const report = await createCloudDatabase({ projectPath: project }, { request: second.request, ...noWait })

    expect(report).toMatchObject({ ok: true, createdNow: true })
    expect(second.created[0].name).toBe("my-cool-app-2")
  })

  test("surfaces a plan limit as Supabase worded it", async () => {
    seedConnection()
    const api = supabaseApi({
      onCreate: () =>
        Response.json(
          { message: "You have reached the maximum number of active free projects for this organization." },
          { status: 403 },
        ),
    })

    const report = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })

    expect(report.ok).toBe(false)
    expect(report.error).toContain("maximum number of active free projects")
    expect(report.nextStep).toContain("upgrade its plan")
    expect(getDatabase(project)).toBeNull()
  })

  test("never reports a project it created as nothing at all", async () => {
    seedConnection()
    const api = supabaseApi({ onKeys: () => Response.json({ message: "Service unavailable" }, { status: 503 }) })

    const report = await createCloudDatabase({ projectPath: project }, { request: api.request, ...noWait })

    expect(report.ok).toBe(false)
    expect(report.error).toContain("was created, but Vector could not finish connecting it")
    expect(report.nextStep).toContain("newprojectref01")
    expect(report.nextStep).toContain("Do not create another project")
  })

  test("treats a rejected saved token as a reconnect, not a crash", async () => {
    seedConnection()
    const api = supabaseApi({
      organizations: undefined,
      onCreate: undefined,
    })
    const unauthorized = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/organizations")) {
        return Response.json({ message: "Unauthorized" }, { status: 401 })
      }
      return api.request(input, init)
    }

    const report = await createCloudDatabase({ projectPath: project }, { request: unauthorized, ...noWait })

    expect(report).toMatchObject({ ok: false, needsSetup: true })
    expect(report.nextStep).toContain("reconnect Supabase")
  })

  test("tells the user to start over when the project it created was deleted", async () => {
    seedConnection()
    const timeout = supabaseApi({ statuses: ["COMING_UP"] })
    await createCloudDatabase({ projectPath: project }, { request: timeout.request, pollAttempts: 1, ...noWait })

    const gone = supabaseApi({ onProject: () => Response.json({ message: "Not found" }, { status: 404 }) })
    const report = await createCloudDatabase({ projectPath: project }, { request: gone.request, ...noWait })

    expect(report.ok).toBe(false)
    expect(report.error).toContain("no longer on this account")
    expect(gone.creates()).toBe(0)
    // The stale record is dropped, so the next run creates a fresh project.
    expect(store.get("cloud-database-credentials")?.get(cloudProjectScopeKey(project))).toBeUndefined()
  })
})
