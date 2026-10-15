import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fakeVercel } from "../../test/fake-vercel"

const userDataPath = join(tmpdir(), "vector-cloud-vercel-test")
const stores = new Map<string, Map<string, unknown>>()
// Bun keeps a module mock for the rest of the run, so it carries every export a later test file's imports bind.
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
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!stores.has(name)) stores.set(name, new Map())
    const bucket = stores.get(name)!
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

const { encryptCloudCredential } = await import("./cloud-credential-vault")
const { cloudProjectScopeKey, getBuildSettings, listDeployments, listEnv, recordDeployment, setEnv, updateDeployment } =
  await import("./cloud-console")
const { disconnectCloudProvider, getCloudProviderProjectLink, getCloudProviderRuntimeAuth } = await import(
  "./cloud-connections"
)
const { VercelError, VERCEL_TOKEN_REJECTED } = await import("./cloud-vercel-api")
const projects = await import("./cloud-vercel-projects")
const deployments = await import("./cloud-vercel-deployments")
const env = await import("./cloud-vercel-env")
const domains = await import("./cloud-vercel-domains")
const { bypassHeadersFor, probeVercelUrl } = await import("./cloud-vercel-checks")
const { startCloudBridge, stopCloudBridge } = await import("./cloud-bridge")

let project = ""
let api: ReturnType<typeof fakeVercel>

function connect(teamId?: string) {
  stores.set(
    "cloud-provider-connections",
    new Map([
      [
        "records",
        [
          {
            provider: "vercel",
            accessToken: encryptCloudCredential(api.token),
            account: "ada",
            teamId,
            connectedAt: "2026-10-01",
          },
        ],
      ],
    ]),
  )
}

function link(projectId: string, projectName: string, teamId?: string) {
  if (!stores.has("cloud-provider-links")) stores.set("cloud-provider-links", new Map())
  stores
    .get("cloud-provider-links")!
    .set(cloudProjectScopeKey(project), [
      { provider: "vercel", projectId, projectName, teamId, accountId: teamId ?? "user_1", linkedAt: "2026-10-01" },
    ])
}

beforeEach(async () => {
  stores.clear()
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64")
  api = fakeVercel()
  process.env.VECTOR_VERCEL_API_URL = api.url
  project = await mkdtemp(join(tmpdir(), "vector-vercel-project-"))
})

afterEach(async () => {
  await stopCloudBridge()
  await api.stop()
  delete process.env.VECTOR_VERCEL_API_URL
  await rm(project, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
})

describe("Vercel connection and scope", () => {
  test("lists the personal account and every team across pages, and remembers the chosen scope", async () => {
    connect()
    api.state.pageSize = 2
    const listed = await projects.listVercelScopes()
    expect(listed.scopes).toEqual([
      { kind: "personal", slug: "ada", name: "Ada Lovelace" },
      { kind: "team", teamId: "team_1", slug: "acme", name: "Acme" },
      { kind: "team", teamId: "team_2", slug: "globex", name: "Globex" },
      { kind: "team", teamId: "team_3", slug: "initech", name: "Initech" },
    ])
    const teamPages = api.requests("GET").filter((item) => item.path === "/v2/teams")
    expect(teamPages.map((item) => item.query.until)).toEqual([undefined, "2000"])
    // /v2/teams and /v2/user describe the token, so they never carry a team.
    expect(teamPages.every((item) => item.query.teamId === undefined)).toBe(true)

    expect((await projects.selectVercelScope("team_2")).selected).toBe("team_2")
    expect((await getCloudProviderRuntimeAuth("vercel")).teamId).toBe("team_2")
    await expect(projects.selectVercelScope("team_other")).rejects.toThrow("not available")
    expect((await projects.selectVercelScope(null)).selected).toBeUndefined()
  })

  test("a sign-in lists and keeps only the scope its integration was installed on", async () => {
    connect("team_2")
    const records = stores.get("cloud-provider-connections")!.get("records") as Record<string, unknown>[]
    records[0].configurationId = "icfg_2"
    expect((await projects.listVercelScopes()).scopes).toEqual([
      { kind: "team", teamId: "team_2", slug: "globex", name: "Globex" },
    ])
    await expect(projects.selectVercelScope("team_1")).rejects.toThrow("not available to the connected token")
    await expect(projects.selectVercelScope(null)).rejects.toThrow("installed on one team only")
    expect((await projects.selectVercelScope("team_2")).selected).toBe("team_2")
  })

  test("a rejected token reads as a reconnect step and never repeats the token", async () => {
    connect()
    api.state.rejectToken = true
    const error = await projects.listVercelProjects().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(VercelError)
    expect((error as InstanceType<typeof VercelError>).code).toBe("token_rejected")
    expect((error as Error).message).toBe(VERCEL_TOKEN_REJECTED)
    expect((error as Error).message).not.toContain(api.token)
  })

  test("without a connection every action asks for one", async () => {
    await expect(projects.listVercelProjects()).rejects.toMatchObject({ code: "not_connected" })
    await expect(deployments.listVercelDeployments(project)).rejects.toMatchObject({ code: "not_linked" })
  })

  test("disconnecting a sign-in removes Vector's Vercel integration, which revokes its token", async () => {
    connect("team_1")
    const records = stores.get("cloud-provider-connections")!.get("records") as Record<string, unknown>[]
    records[0].configurationId = "icfg_1"
    api.state.configurations.set("icfg_1", "team_1")
    expect(await disconnectCloudProvider("vercel")).toEqual({
      revoked: true,
      detail: "Vercel disconnected, and Vector's access on Vercel is revoked.",
    })
    expect(api.state.requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/v1/integrations/configuration/icfg_1",
      query: { teamId: "team_1" },
    })
    expect(api.state.configurations.has("icfg_1")).toBe(false)
    expect(stores.get("cloud-provider-connections")!.get("records")).toEqual([])
    await expect(projects.listVercelProjects()).rejects.toMatchObject({ code: "not_connected" })
  })

  test("a failed uninstall still removes the credential and says Vercel kept access", async () => {
    connect("team_1")
    const records = stores.get("cloud-provider-connections")!.get("records") as Record<string, unknown>[]
    records[0].configurationId = "icfg_missing_scope"
    // Not installed on that team as far as the fake knows, but answer as a scope error would.
    api.state.configurations.set("icfg_missing_scope", "team_2")
    const result = await disconnectCloudProvider("vercel", async (input, init) => {
      const response = await fetch(input, init)
      return response.status === 404 ? Response.json({ error: { code: "forbidden" } }, { status: 403 }) : response
    })
    expect(result.revoked).toBe(false)
    expect(result.detail).toContain("still has access until you remove Vector")
    expect(stores.get("cloud-provider-connections")!.get("records")).toEqual([])
  })

  test("disconnecting a pasted token deletes only Vector's copy and says the token still works", async () => {
    connect()
    const result = await disconnectCloudProvider("vercel")
    expect(result).toEqual({
      revoked: false,
      detail:
        "Vercel disconnected. Vector deleted its copy of your access token; the token itself stays valid until you delete it in Vercel's token settings.",
    })
    expect(api.state.requests).toEqual([])
    expect(JSON.stringify(result)).not.toContain(api.token)
  })
})

describe("Vercel projects", () => {
  test("lists every project in the chosen team, following the continuation token", async () => {
    connect("team_1")
    for (const name of ["one", "two", "three"]) api.addProject({ name, teamId: "team_1" })
    api.addProject({ name: "personal-only" })
    api.state.pageSize = 2
    expect((await projects.listVercelProjects()).map((item) => item.name)).toEqual(["one", "two", "three"])
    expect(
      api
        .requests("GET")
        .filter((item) => item.path === "/v10/projects")
        .map((item) => item.query.from),
    ).toEqual([undefined, "cursor-2"])
    expect((await projects.listVercelProjects(null)).map((item) => item.name)).toEqual(["personal-only"])
  })

  test("creates a project with its framework and root directory and links it with its team", async () => {
    connect()
    const created = await projects.createVercelProject(project, {
      name: "Shop-Front",
      framework: "nextjs",
      rootDirectory: "./apps/web/",
      teamId: "team_1",
    })
    expect(api.requests("POST").find((item) => item.path === "/v11/projects")).toMatchObject({
      query: { teamId: "team_1" },
      body: { name: "shop-front", framework: "nextjs", rootDirectory: "apps/web" },
    })
    expect(created).toMatchObject({ projectName: "shop-front", teamId: "team_1", accountId: "team_1" })
    expect(getCloudProviderProjectLink(project, undefined, "vercel")?.projectId).toBe(created.projectId)
    await expect(projects.createVercelProject(project, { name: "bad name!" })).rejects.toThrow("project name")
    await expect(projects.createVercelProject(project, { name: "ok", rootDirectory: "../outside" })).rejects.toThrow(
      "relative path",
    )
  })

  test("links, reads and unlinks a team project", async () => {
    connect()
    const remote = api.addProject({
      name: "team-site",
      teamId: "team_2",
      link: { type: "github", org: "acme", repo: "site" },
    })
    await projects.linkVercelProject(project, remote.id, "team_2")
    const status = await projects.vercelProjectStatus(project)
    expect(status.link).toMatchObject({ projectName: "team-site", teamId: "team_2" })
    expect(status.project).toMatchObject({
      name: "team-site",
      gitRepository: "acme/site",
      settings: { nodeVersion: "22.x", framework: null },
      protection: { vercelAuthentication: null, passwordProtection: false, bypassReady: false },
    })
    await projects.unlinkVercelProject(project)
    expect(getCloudProviderProjectLink(project, undefined, "vercel")).toBeUndefined()
  })

  test("links the project named in .vercel/project.json without asking", async () => {
    connect()
    const remote = api.addProject({ name: "from-cli", teamId: "team_1" })
    await mkdir(join(project, ".vercel"))
    await writeFile(join(project, ".vercel", "project.json"), JSON.stringify({ projectId: remote.id, orgId: "team_1" }))
    const linked = await projects.autoLinkVercelProject(project)
    expect(linked).toMatchObject({ projectName: "from-cli", teamId: "team_1", linkedFrom: ".vercel/project.json" })
  })

  test("edits build settings, clearing a setting back to automatic", async () => {
    connect()
    const remote = api.addProject({ name: "app", buildCommand: "make" })
    link(remote.id, "app")
    const updated = await projects.updateVercelProjectSettings(project, {
      framework: "Vite",
      buildCommand: "",
      outputDirectory: "dist",
      nodeVersion: "24.x",
    })
    expect(api.requests("PATCH").at(-1)?.body).toEqual({
      framework: "vite",
      buildCommand: null,
      outputDirectory: "dist",
      nodeVersion: "24.x",
    })
    expect(updated.settings).toMatchObject({
      framework: "vite",
      buildCommand: null,
      outputDirectory: "dist",
      nodeVersion: "24.x",
    })
    // Vercel no longer builds new deployments with Node.js 18 or 20.
    for (const retired of ["16.x", "18.x", "20.x"]) {
      await expect(projects.updateVercelProjectSettings(project, { nodeVersion: retired })).rejects.toThrow(
        "Node.js version",
      )
    }
    await expect(projects.updateVercelProjectSettings(project, {})).rejects.toThrow("at least one")
  })

  test("enables Protection Bypass for Automation and keeps the secret only in the vault", async () => {
    connect()
    const remote = api.addProject({ name: "app", ssoProtection: { deploymentType: "preview" } })
    link(remote.id, "app")
    expect(await projects.enableVercelProtectionBypass(project)).toEqual({ enabled: true, project: "app" })
    const secret = Object.keys(remote.protectionBypass)[0]
    const stored = stores.get("cloud-vercel-bypass")?.get(remote.id)
    expect(typeof stored).toBe("string")
    expect(String(stored)).not.toContain(secret)
    const context = { link: getCloudProviderProjectLink(project, undefined, "vercel")!, auth: { token: api.token } }
    expect(await projects.vercelBypassSecret(context)).toBe(secret)
    expect((await projects.vercelProjectStatus(project)).project?.protection).toMatchObject({
      vercelAuthentication: "preview",
      bypassReady: true,
    })
  })
})

describe("Vercel deployments", () => {
  function seedHistory() {
    connect()
    const remote = api.addProject({ name: "shop" })
    link(remote.id, "shop")
    const old = api.addDeployment({ projectId: remote.id, target: "production", created: 1_000, source: "git" })
    const live = api.addDeployment({
      projectId: remote.id,
      target: "production",
      created: 2_000,
      source: "git",
      meta: { githubCommitRef: "main", githubCommitSha: "abcdef1234567", githubCommitMessage: "Ship it" },
    })
    const preview = api.addDeployment({ projectId: remote.id, created: 3_000 })
    const building = api.addDeployment({ projectId: remote.id, created: 4_000, readyState: "BUILDING" })
    remote.productionId = live.uid
    api.addProject({ name: "other" })
    return { remote, old, live, preview, building }
  }

  test("lists the provider's history, git pushes included, page by page", async () => {
    const seeded = seedHistory()
    api.state.pageSize = 2
    const listed = await deployments.listVercelDeployments(project, { limit: 10 })
    expect(listed.map((item) => item.id)).toEqual([
      seeded.building.uid,
      seeded.preview.uid,
      seeded.live.uid,
      seeded.old.uid,
    ])
    expect(listed.find((item) => item.current)?.id).toBe(seeded.live.uid)
    expect(listed.find((item) => item.id === seeded.live.uid)).toMatchObject({
      target: "production",
      source: "git",
      branch: "main",
      commitSha: "abcdef1234567",
      commitMessage: "Ship it",
    })
    expect(
      api
        .requests("GET")
        .filter((item) => item.path === "/v6/deployments")
        .map((item) => item.query.until),
    ).toEqual([undefined, "3000"])
  })

  test("only acts on deployments of the linked project", async () => {
    const seeded = seedHistory()
    const stranger = api.addDeployment({ projectId: "prj_elsewhere" })
    await expect(deployments.inspectVercelDeployment(project, stranger.uid)).rejects.toThrow("not part of")
    expect((await deployments.inspectVercelDeployment(project, `https://${seeded.preview.url}/`)).id).toBe(
      seeded.preview.uid,
    )
  })

  test("reads build events and streamed runtime logs, then stops listening", async () => {
    const seeded = seedHistory()
    seeded.live.events = [
      { type: "stdout", created: 1, payload: { text: "Installing" } },
      { type: "stderr", created: 2, payload: { text: "Type error" } },
    ]
    seeded.live.runtime = [
      {
        level: "error",
        message: "boom",
        requestMethod: "GET",
        requestPath: "/api",
        responseStatusCode: 500,
        timestampInMs: 5,
        rowId: "1",
        source: "serverless",
        domain: "shop.vercel.app",
        messageTruncated: false,
      },
      {
        level: "info",
        message: "ok",
        requestMethod: "GET",
        requestPath: "/",
        responseStatusCode: 200,
        timestampInMs: 6,
        rowId: "2",
        source: "serverless",
        domain: "shop.vercel.app",
        messageTruncated: false,
      },
    ]
    const build = await deployments.vercelBuildLogs(project, seeded.live.uid, 50)
    expect(build.entries.map((entry) => entry.text).sort()).toEqual(["Installing", "[stderr] Type error"])
    const startedAt = Date.now()
    const runtime = await deployments.vercelRuntimeLogs(project, seeded.live.uid, 10, { waitMs: 300 })
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(runtime.entries.map((entry) => entry.text)).toEqual(["[error] GET /api 500 · boom", "GET / 200 · ok"])
  })

  test("cancels only a running deployment and redeploys keeping its target", async () => {
    const seeded = seedHistory()
    await expect(deployments.cancelVercelDeployment(project, seeded.preview.uid)).rejects.toThrow(
      "only a queued or building",
    )
    expect((await deployments.cancelVercelDeployment(project, seeded.building.uid)).state).toBe("CANCELED")
    const redeployed = await deployments.redeployVercelDeployment(project, seeded.live.uid)
    // A production rebuild does not take production's domains, as --skip-domain does not.
    expect(api.requests("POST").at(-1)).toMatchObject({
      path: "/v13/deployments",
      query: { forceNew: "1" },
      body: {
        name: "shop",
        project: seeded.remote.id,
        deploymentId: seeded.live.uid,
        target: "production",
        autoAssignCustomDomains: false,
      },
    })
    expect(redeployed.deployment.target).toBe("production")
    expect(seeded.remote.productionId).toBe(seeded.live.uid)
    await deployments.redeployVercelDeployment(project, seeded.preview.uid)
    expect(api.requests("POST").at(-1)?.body).not.toHaveProperty("target")
  })

  test("promotes a production build, refuses a preview, and reports the production address", async () => {
    const seeded = seedHistory()
    const staged = api.addDeployment({ projectId: seeded.remote.id, target: "production", created: 5_000 })
    await expect(deployments.promoteVercelDeployment(project, seeded.preview.uid)).rejects.toThrow("preview build")
    const promoted = await deployments.promoteVercelDeployment(project, staged.uid, { sleep: async () => {} })
    expect(promoted.productionUrl).toBe("https://shop.vercel.app")
    expect(seeded.remote.productionId).toBe(staged.uid)
  })

  test("never moves production to a build Vector's checks failed, and keeps Vector's history in step", async () => {
    const seeded = seedHistory()
    const staged = api.addDeployment({ projectId: seeded.remote.id, target: "production", created: 5_000 })
    const release = (uid: string, environment: "preview" | "production") =>
      recordDeployment({
        projectPath: project,
        slug: "shop",
        url: `https://${uid}.vercel.app`,
        name: "shop",
        target: "vercel",
        environment,
        providerDeploymentId: uid,
        checks: [
          {
            id: "health",
            type: "health",
            label: "Health check /",
            status: "failed",
            required: true,
            checkedAt: "2026-10-01",
          },
        ],
      })
    const live = release(seeded.live.uid, "production")
    const candidate = release(staged.uid, "preview")
    await expect(deployments.promoteVercelDeployment(project, staged.uid)).rejects.toThrow(
      "required release checks failed",
    )
    expect(seeded.remote.productionId).toBe(seeded.live.uid)
    updateDeployment(project, undefined, candidate.id, {
      checks: candidate.checks.map((check) => ({ ...check, status: "passed" as const })),
    })
    await deployments.promoteVercelDeployment(project, staged.uid, { sleep: async () => {} })
    const after = listDeployments(project)
    expect(after.find((item) => item.id === candidate.id)).toMatchObject({
      releaseStatus: "current",
      productionUrl: "https://shop.vercel.app/",
    })
    expect(after.find((item) => item.id === live.id)?.releaseStatus).toBe("superseded")
    // The old release's checks failed too: rolling back to it is refused as well.
    await expect(deployments.rollbackVercelDeployment(project, seeded.live.uid)).rejects.toThrow(
      "required release checks failed",
    )
    // A deployment Vector never made carries no checks; rolling back to it
    // marks Vector's current release rolled back.
    await deployments.rollbackVercelDeployment(project, seeded.old.uid, { sleep: async () => {} })
    expect(listDeployments(project).find((item) => item.id === candidate.id)?.releaseStatus).toBe("rolled-back")
  })

  test("holds production while the linked Supabase project fails its security check, and records why", async () => {
    const seeded = seedHistory()
    const staged = api.addDeployment({ projectId: seeded.remote.id, target: "production", created: 5_000 })
    const candidate = recordDeployment({
      projectPath: project,
      slug: "shop",
      url: `https://${staged.url}`,
      name: "shop",
      target: "vercel",
      environment: "preview",
      providerDeploymentId: staged.uid,
    })
    // Supabase is linked but not connected here, so only the local scan runs;
    // a service_role key in a public variable is enough to stop the move.
    stores.set(
      "cloud-projects",
      new Map([
        [
          cloudProjectScopeKey(project),
          {
            env: [],
            domains: [],
            build: null,
            database: {
              provider: "supabase",
              url: "https://fixtureref.supabase.co",
              anonKey: "sb_publishable_fixture_key",
              projectRef: "fixtureref",
              projectName: "shop-db",
              connectedAt: "2026-10-01",
            },
          },
        ],
      ]),
    )
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signaturesignature`
    setEnv(project, undefined, "VITE_SUPABASE_KEY", jwt, "public")
    const reported: string[] = []
    await expect(
      deployments.promoteVercelDeployment(project, staged.uid, { report: (level) => reported.push(level) }),
    ).rejects.toThrow("The Supabase security check failed, so production was not moved")
    expect(seeded.remote.productionId).toBe(seeded.live.uid)
    expect(api.requests("POST").some((item) => item.path.includes("/promote/"))).toBe(false)
    expect(reported).toEqual(["error"])
    expect(listDeployments(project).find((item) => item.id === candidate.id)).toMatchObject({
      releaseStatus: "preview",
      checks: [expect.objectContaining({ id: "supabase-security", status: "failed", required: true })],
    })
    // A rollback returns to a release that already served production, so the
    // check does not hold it.
    await deployments.rollbackVercelDeployment(project, seeded.old.uid, { sleep: async () => {} })
    expect(seeded.remote.productionId).toBe(seeded.old.uid)
  })

  test("rolls back by default to the last deployment that served production and passed Vector's checks", async () => {
    const seeded = seedHistory()
    seeded.old.readySubstate = "PROMOTED"
    // Newer than the good one but older than live: staged by a production
    // publish whose checks failed, so it never served anyone.
    const staged = api.addDeployment({
      projectId: seeded.remote.id,
      target: "production",
      created: 1_500,
      readySubstate: "STAGED",
    })
    const failed = api.addDeployment({
      projectId: seeded.remote.id,
      target: "production",
      created: 1_800,
      readySubstate: "PROMOTED",
    })
    recordDeployment({
      projectPath: project,
      slug: "shop",
      url: `https://${failed.url}`,
      name: "shop",
      target: "vercel",
      environment: "preview",
      providerDeploymentId: failed.uid,
      checks: [
        {
          id: "browser",
          type: "browser",
          label: "Browser smoke test",
          status: "failed",
          required: true,
          checkedAt: "2026-10-01",
        },
      ],
    })
    const rolled = await deployments.rollbackVercelDeployment(project, undefined, { sleep: async () => {} })
    expect(rolled.deployment.id).toBe(seeded.old.uid)
    expect(api.requests("POST").some((item) => item.path.endsWith(`/rollback/${staged.uid}`))).toBe(false)
    seeded.old.readySubstate = "STAGED"
    seeded.remote.productionId = seeded.live.uid
    await expect(deployments.rollbackVercelDeployment(project)).rejects.toThrow("nothing to roll back to")
  })

  test("without Vercel's substate, a release Vector staged and never promoted is not a rollback target", async () => {
    const seeded = seedHistory()
    const staged = api.addDeployment({ projectId: seeded.remote.id, target: "production", created: 1_500 })
    recordDeployment({
      projectPath: project,
      slug: "shop",
      url: `https://${staged.url}`,
      name: "shop",
      target: "vercel",
      environment: "preview",
      providerDeploymentId: staged.uid,
    })
    const rolled = await deployments.rollbackVercelDeployment(project, undefined, { sleep: async () => {} })
    expect(rolled.deployment.id).toBe(seeded.old.uid)
  })

  test("rolls back to the previous production deployment by default", async () => {
    const seeded = seedHistory()
    const rolled = await deployments.rollbackVercelDeployment(project, undefined, { sleep: async () => {} })
    expect(rolled.deployment.id).toBe(seeded.old.uid)
    expect(rolled.replaced).toBe(seeded.live.uid)
    expect(api.requests("POST").at(-1)?.path).toBe(`/v1/projects/${seeded.remote.id}/rollback/${seeded.old.uid}`)
    await expect(deployments.rollbackVercelDeployment(project, seeded.old.uid)).rejects.toThrow("already serving")
    await expect(deployments.rollbackVercelDeployment(project, seeded.preview.uid)).rejects.toThrow(
      "earlier production",
    )
  })

  test("gives each branch the address Vercel would, within one DNS label", () => {
    expect(deployments.vercelBranchAlias("shop", "agent/fix-cart", "acme")).toBe(
      "shop-git-agent-fix-cart-acme.vercel.app",
    )
    const long = deployments.vercelBranchAlias("shop", `feature/${"x".repeat(80)}`, "acme")
    expect(long.replace(".vercel.app", "").length).toBeLessThanOrEqual(63)
    expect(long).toStartWith("shop-git-feature-")
    expect(long).toEndWith("-acme.vercel.app")
    expect(long).not.toBe(deployments.vercelBranchAlias("shop", `feature/${"x".repeat(79)}y`, "acme"))
  })
})

describe("Vercel environment variables", () => {
  function seedProject() {
    connect()
    const remote = api.addProject({ name: "shop" })
    link(remote.id, "shop")
    return remote
  }

  test("lists names, targets and types but never a value", async () => {
    const remote = seedProject()
    api.addEnv(remote.id, {
      key: "DATABASE_URL",
      value: "postgres://private-fixture",
      type: "encrypted",
      target: ["production"],
    })
    api.addEnv(remote.id, {
      key: "PREVIEW_ONLY",
      value: "branch-secret-fixture",
      type: "encrypted",
      target: ["preview"],
      gitBranch: "dev",
    })
    const listed = await env.listVercelEnv(project)
    expect(listed.variables).toEqual([
      expect.objectContaining({
        key: "DATABASE_URL",
        targets: ["production"],
        type: "encrypted",
        syncedByVector: false,
      }),
      expect.objectContaining({ key: "PREVIEW_ONLY", targets: ["preview"], gitBranch: "dev" }),
    ])
    expect(JSON.stringify(listed)).not.toContain("private-fixture")
    expect(api.requests("GET").every((item) => item.query.decrypt !== "true")).toBe(true)
  })

  test("creates, updates, narrows and removes a variable per environment", async () => {
    const remote = seedProject()
    expect(
      (await env.setVercelEnv(project, { key: "API_URL", value: "https://one", targets: ["preview", "development"] }))
        .action,
    ).toBe("created")
    expect(
      (await env.setVercelEnv(project, { key: "API_URL", value: "https://two", targets: ["development", "preview"] }))
        .action,
    ).toBe("updated")
    expect(api.state.env.find((item) => item.key === "API_URL")?.value).toBe("https://two")
    await expect(env.setVercelEnv(project, { key: "API_URL", value: "x", targets: ["preview"] })).rejects.toThrow(
      "separate Vercel entry",
    )
    await expect(
      env.setVercelEnv(project, { key: "TOKEN", value: "x", targets: ["development"], type: "sensitive" }),
    ).rejects.toThrow("sensitive")
    await expect(
      env.setVercelEnv(project, { key: "BRANCHED", value: "x", targets: ["production"], gitBranch: "dev" }),
    ).rejects.toThrow("only target preview")
    await env.setVercelEnv(project, { key: "BRANCHED", value: "x", targets: ["preview"], gitBranch: "dev" })

    await env.removeVercelEnv(project, { key: "API_URL", targets: ["preview"] })
    expect(api.state.env.filter((item) => item.key === "API_URL").map((item) => item.target)).toEqual([["development"]])
    await env.removeVercelEnv(project, { key: "API_URL" })
    expect(api.state.env.some((item) => item.key === "API_URL")).toBe(false)
    await expect(env.removeVercelEnv(project, { key: "API_URL" })).rejects.toThrow("has no value")
    expect(api.state.env.filter((item) => item.projectId === remote.id).map((item) => item.key)).toEqual(["BRANCHED"])
  })

  test("diffs local values against each environment by hash", async () => {
    const remote = seedProject()
    setEnv(project, undefined, "SAME", "value-one")
    setEnv(project, undefined, "CHANGED", "local-value")
    setEnv(project, undefined, "LOCAL_ONLY", "x")
    api.addEnv(remote.id, { key: "SAME", value: "value-one", type: "encrypted", target: ["production", "preview"] })
    api.addEnv(remote.id, { key: "CHANGED", value: "remote-value", type: "encrypted", target: ["production"] })
    api.addEnv(remote.id, { key: "HIDDEN", value: "x", type: "sensitive", target: ["production"] })
    const diff = await env.diffVercelEnv(project)
    expect(diff.rows).toEqual([
      {
        key: "CHANGED",
        local: true,
        targets: { production: "different", preview: "missing_remote", development: "missing_remote" },
        branchOverrides: [],
      },
      {
        key: "HIDDEN",
        local: false,
        targets: { production: "remote_only", preview: "absent", development: "absent" },
        branchOverrides: [],
      },
      {
        key: "LOCAL_ONLY",
        local: true,
        targets: { production: "missing_remote", preview: "missing_remote", development: "missing_remote" },
        branchOverrides: [],
      },
      {
        key: "SAME",
        local: true,
        targets: { production: "same", preview: "same", development: "missing_remote" },
        branchOverrides: [],
      },
    ])
    expect(JSON.stringify(diff)).not.toContain("value")
  })

  test("plans a sync that only touches what Vector synced, and applies exactly the approved plan", async () => {
    const remote = seedProject()
    setEnv(project, undefined, "NEW_KEY", "new-value")
    setEnv(project, undefined, "SYNCED", "fresh-value")
    setEnv(project, undefined, "USER_OWNED", "local-value")
    api.addEnv(remote.id, {
      key: "SYNCED",
      value: "stale-value",
      type: "encrypted",
      target: ["production", "preview", "development"],
      comment: "Synced by Vector",
    })
    api.addEnv(remote.id, { key: "USER_OWNED", value: "theirs", type: "encrypted", target: ["preview"] })
    api.addEnv(remote.id, {
      key: "REMOVED_LOCALLY",
      value: "x",
      type: "encrypted",
      target: ["preview"],
      comment: "Synced by Vector",
    })
    const plan = await env.planVercelEnvSync(project, ["preview", "development"])
    expect(plan.changes).toEqual([
      { action: "create", key: "NEW_KEY", targets: ["preview", "development"] },
      { action: "update", key: "SYNCED", targets: ["preview", "development"] },
      { action: "create", key: "USER_OWNED", targets: ["development"] },
      { action: "delete", key: "REMOVED_LOCALLY", targets: ["preview"] },
    ])
    expect(plan.skipped).toEqual([{ key: "USER_OWNED", targets: ["preview"], reason: "set outside a Vector sync" }])
    expect(JSON.stringify(plan)).not.toContain("value")

    setEnv(project, undefined, "NEW_KEY", "changed-after-review")
    await expect(env.applyVercelEnvSync(project, ["preview", "development"], plan.id)).rejects.toThrow(
      "changed since this plan",
    )
    expect(api.state.env.some((item) => item.key === "NEW_KEY")).toBe(false)

    const approved = await env.planVercelEnvSync(project, ["preview", "development"])
    const applied = await env.applyVercelEnvSync(project, ["preview", "development"], approved.id)
    expect(applied.applied).toBe(4)
    const remoteState = api.state.env
      .filter((item) => item.projectId === remote.id)
      .map((item) => `${item.key}:${item.target.join("+")}:${item.value}`)
      .sort()
    // Production keeps the old SYNCED value: the plan covered preview and development only.
    expect(remoteState).toEqual([
      "NEW_KEY:preview+development:changed-after-review",
      "SYNCED:preview+development:fresh-value",
      "SYNCED:production:stale-value",
      "USER_OWNED:development:local-value",
      "USER_OWNED:preview:theirs",
    ])
    expect((await env.planVercelEnvSync(project, ["preview", "development"])).changes).toEqual([])
  })

  test("pulls development values into .env only as approved", async () => {
    const remote = seedProject()
    setEnv(project, undefined, "KEEP", "same")
    setEnv(project, undefined, "OVERWRITE", "old")
    api.addEnv(remote.id, { key: "KEEP", value: "same", type: "encrypted", target: ["development"] })
    api.addEnv(remote.id, { key: "OVERWRITE", value: "new", type: "encrypted", target: ["development", "preview"] })
    api.addEnv(remote.id, { key: "ADDED", value: "fresh", type: "plain", target: ["development"] })
    api.addEnv(remote.id, { key: "PROD_ONLY", value: "prod", type: "encrypted", target: ["production"] })
    api.addEnv(remote.id, { key: "MULTI", value: "a\nb", type: "encrypted", target: ["development"] })
    const plan = await env.planVercelEnvPull(project)
    expect(plan.variables).toEqual([
      { key: "ADDED", action: "add" },
      { key: "KEEP", action: "unchanged" },
      { key: "OVERWRITE", action: "overwrite" },
    ])
    expect(plan.skipped).toEqual([{ key: "MULTI", reason: "contains a line break, which .env cannot hold" }])
    await expect(env.applyVercelEnvPull(project, "stale-plan")).rejects.toThrow("changed since the preview")
    const pulled = await env.applyVercelEnvPull(project, plan.id)
    expect(pulled.keys).toEqual(["ADDED", "OVERWRITE"])
    expect(
      listEnv(project)
        .map((item) => `${item.key}=${item.value}`)
        .sort(),
    ).toEqual(["ADDED=fresh", "KEEP=same", "OVERWRITE=new"])
    expect(await readFile(join(project, ".env"), "utf8")).toContain("OVERWRITE=new")
    expect(JSON.stringify(pulled)).not.toContain("fresh")
  })
})

describe("Vercel domains", () => {
  test("shows the exact records: A for an apex, CNAME for a subdomain, TXT to verify", async () => {
    connect()
    const remote = api.addProject({ name: "shop" })
    link(remote.id, "shop")
    api.state.verifiable.add("example.com")
    api.state.domainConfig.set("example.com", {
      configuredBy: "A",
      acceptedChallenges: ["http-01"],
      misconfigured: false,
      recommendedIPv4: [
        { rank: 2, value: ["76.76.21.98"] },
        { rank: 1, value: ["216.198.79.1", "64.29.17.1"] },
      ],
      recommendedCNAME: [],
    })
    const certificate = async () => ({
      status: "issued" as const,
      expiresAt: "2027-01-01T00:00:00.000Z",
      issuer: "Let's Encrypt",
    })
    const apex = await domains.addVercelDomain(project, "https://Example.com/", { certificate })
    expect(apex.domain).toMatchObject({
      name: "example.com",
      apex: true,
      status: "ready",
      records: [{ type: "A", name: "@", value: "216.198.79.1", purpose: "routing" }],
      certificate: { status: "issued", expiresAt: "2027-01-01T00:00:00.000Z" },
    })
    const sub = await domains.addVercelDomain(project, "app.example.com", { certificate })
    expect(sub.domain).toMatchObject({
      apex: false,
      status: "needs_verification",
      records: [
        { type: "CNAME", name: "app", value: "cname.vercel-dns-fixture.com", purpose: "routing" },
        { type: "TXT", name: "_vercel.example.com", purpose: "verification" },
      ],
    })
    expect(sub.domain.certificate).toBeUndefined()
    expect((await domains.verifyVercelDomain(project, "app.example.com", { certificate })).domain.status).toBe(
      "needs_verification",
    )
    api.state.verifiable.add("app.example.com")
    expect((await domains.verifyVercelDomain(project, "app.example.com", { certificate })).domain.status).toBe(
      "needs_dns",
    )
    expect((await domains.listVercelDomains(project, { certificate })).domains.map((item) => item.name)).toEqual([
      "app.example.com",
      "example.com",
    ])
    await domains.removeVercelDomain(project, "app.example.com")
    expect((await domains.listVercelDomains(project, { certificate })).domains.map((item) => item.name)).toEqual([
      "example.com",
    ])
  })
})

describe("release checks against Deployment Protection", () => {
  test("tells protection apart from a broken app, and gets through with the bypass secret", async () => {
    const seen: (string | null)[] = []
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        seen.push(request.headers.get("x-vercel-protection-bypass"))
        if (request.headers.get("x-vercel-protection-bypass") === "bypass-fixture") return new Response("ok")
        if (url.pathname === "/sso") return Response.redirect("https://vercel.com/sso-api?url=fixture", 302)
        if (url.pathname === "/cookie") {
          return new Response("Authentication Required", {
            status: 401,
            headers: { "set-cookie": "_vercel_sso_nonce=abc; Path=/" },
          })
        }
        if (url.pathname === "/password") return new Response("Password", { status: 401 })
        return new Response("broken", { status: 500 })
      },
    })
    try {
      const base = site.url.toString()
      expect((await probeVercelUrl(new URL("/sso", base).toString())).kind).toBe("protected")
      expect((await probeVercelUrl(new URL("/cookie", base).toString())).kind).toBe("protected")
      expect((await probeVercelUrl(new URL("/password", base).toString())).kind).toBe("failed")
      expect((await probeVercelUrl(new URL("/password", base).toString(), { projectProtected: true })).kind).toBe(
        "protected",
      )
      expect((await probeVercelUrl(new URL("/broken", base).toString(), { projectProtected: true })).kind).toBe(
        "failed",
      )
      expect((await probeVercelUrl(new URL("/sso", base).toString(), { bypass: "bypass-fixture" })).kind).toBe("ok")
      expect(seen.at(-1)).toBe("bypass-fixture")
    } finally {
      await site.stop(true)
    }
  })

  test("never sends the bypass secret to another host a redirect points at", async () => {
    const received: (string | null)[] = []
    const elsewhere = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        received.push(request.headers.get("x-vercel-protection-bypass"))
        return new Response("sign in")
      },
    })
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.headers.get("x-vercel-protection-bypass") !== "bypass-secret-fixture") {
          return new Response("", { status: 401, headers: { "set-cookie": "_vercel_sso_nonce=n" } })
        }
        if (url.pathname === "/") return Response.redirect(new URL("/home", url).toString(), 302)
        // localhost is another origin than 127.0.0.1, as an auth provider would be.
        return Response.redirect(`http://localhost:${elsewhere.port}/login`, 302)
      },
    })
    try {
      const probe = await probeVercelUrl(app.url.toString(), { bypass: "bypass-secret-fixture" })
      expect(probe.kind).toBe("ok")
      expect(received).toEqual([null])
      expect(bypassHeadersFor(`http://localhost:${elsewhere.port}/login`, app.url.toString(), { a: "b" })).toEqual({})
      expect(bypassHeadersFor(new URL("/assets/app.js", app.url).toString(), app.url.toString(), { a: "b" })).toEqual({
        a: "b",
      })
    } finally {
      await app.stop(true)
      await elsewhere.stop(true)
    }
  })
})

describe("vector_cloud Vercel actions over the bridge", () => {
  async function bridge() {
    const started = await startCloudBridge({
      vercel: { certificate: async () => ({ status: "pending", detail: "fixture" }) },
    })
    return async (input: Record<string, unknown>) => {
      const response = await fetch(`${started.url}/command`, {
        method: "POST",
        headers: { authorization: `Bearer ${started.token}` },
        body: JSON.stringify({ projectPath: project, ...input }),
      })
      return response.json()
    }
  }

  function seed() {
    connect()
    const remote = api.addProject({ name: "shop", teamId: "team_1" })
    link(remote.id, "shop", "team_1")
    const old = api.addDeployment({ projectId: remote.id, uid: "dpl_old", target: "production", created: 1_000 })
    const live = api.addDeployment({
      projectId: remote.id,
      uid: "dpl_live",
      target: "production",
      created: 2_000,
      source: "git",
      meta: { githubCommitRef: "main", githubCommitSha: "1234567abcdef", githubCommitMessage: "Fix cart" },
      runtime: [
        {
          level: "error",
          message: "TypeError: cart is undefined",
          requestMethod: "GET",
          requestPath: "/cart",
          responseStatusCode: 500,
          timestampInMs: 9,
          rowId: "r",
          source: "serverless",
          domain: "shop.vercel.app",
          messageTruncated: false,
        },
      ],
    })
    remote.productionId = live.uid
    return { remote, old, live }
  }

  test("describes production moves with provider, project and environment before asking", async () => {
    seed()
    const command = await bridge()
    // Moving production, or what it serves, names the deployment it moves to.
    expect(await command({ command: "describe", action: "promote", deploymentId: "dpl_old" })).toMatchObject({
      ok: true,
      scope: {
        provider: "Vercel",
        project: "shop",
        environment: "production",
        summary: expect.stringContaining("dpl_old"),
      },
    })
    // The rollback target is resolved before asking, and the approved run uses it.
    expect(await command({ command: "describe", action: "rollback" })).toMatchObject({
      scope: { environment: "production", summary: expect.stringContaining("(dpl_old)") },
      carry: { deploymentId: "dpl_old" },
    })
    // A production rebuild says that production does not move.
    const redeploy = await command({ command: "describe", action: "redeploy", deploymentId: "dpl_live" })
    expect(redeploy).toMatchObject({
      scope: { environment: "production", summary: expect.stringContaining("production does not move") },
    })
    expect(await command({ command: "describe", action: "add_domain", domain: "shop.example" })).toMatchObject({
      scope: { environment: "production" },
    })
    // Every account action asks each time (PermissionPolicy), so no describe carries an approval tier.
    for (const action of ["promote", "rollback", "redeploy", "add_domain", "enable_protection_bypass"]) {
      expect(
        await command({ command: "describe", action, deploymentId: "dpl_old", domain: "shop.example" }),
      ).not.toHaveProperty("repeatable")
    }
    expect(
      await command({
        command: "describe",
        action: "set_env",
        key: "API_URL",
        value: "https://api.example",
        targets: ["preview"],
      }),
    ).toMatchObject({ ok: true, scope: { environment: "preview" } })
    expect(await command({ command: "describe", action: "promote" })).toMatchObject({ ok: false })
  })

  test("asks nothing for a promotion Vector's failed checks would refuse", async () => {
    seed()
    recordDeployment({
      projectPath: project,
      slug: "shop",
      url: "https://shop-old.vercel.app",
      name: "shop",
      target: "vercel",
      environment: "production",
      providerDeploymentId: "dpl_old",
      checks: [
        {
          id: "browser",
          type: "browser",
          label: "Browser smoke test",
          status: "failed",
          required: true,
          checkedAt: "",
        },
      ],
    })
    const command = await bridge()
    expect(await command({ command: "describe", action: "promote", deploymentId: "dpl_old" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Browser smoke test"),
    })
    expect(await command({ command: "promote", deploymentId: "dpl_old" })).toMatchObject({ ok: false })
  })

  test("asks nothing for a production publish whose checks Deployment Protection would keep out", async () => {
    const seeded = seed()
    seeded.remote.ssoProtection = { deploymentType: "prod_deployment_urls_and_all_previews" }
    const command = await bridge()
    expect(await command({ command: "describe", action: "publish", production: true })).toMatchObject({
      ok: false,
      errorCode: "checks_blocked",
      nextStep: expect.stringContaining("enable_protection_bypass"),
    })
    // A preview never moves production, so it is still described.
    expect(await command({ command: "describe", action: "publish" })).toMatchObject({
      ok: true,
      scope: { environment: "preview" },
    })
    await command({ command: "enable_protection_bypass" })
    expect(await command({ command: "describe", action: "publish", production: true })).toMatchObject({
      ok: true,
      scope: { environment: "production", summary: expect.stringContaining("only if they pass") },
    })
  })

  test("status and vercel_project only report the project .vercel/project.json names", async () => {
    connect()
    const remote = api.addProject({ name: "from-cli", teamId: "team_1" })
    await mkdir(join(project, ".vercel"))
    await writeFile(join(project, ".vercel", "project.json"), JSON.stringify({ projectId: remote.id, orgId: "team_1" }))
    const command = await bridge()
    const status = await command({ command: "status" })
    expect(status.nextStep).toContain(`names the Vercel project ${remote.id} (teamId team_1)`)
    expect(status).toMatchObject({ ok: true, configured: false, nextStep: expect.stringContaining("link_project") })
    const described = await command({ command: "vercel_project" })
    expect(described.text).toContain(`names projectId ${remote.id} (teamId team_1)`)
    expect(getCloudProviderProjectLink(project, undefined, "vercel")).toBeUndefined()
    // Linking goes through link_project, which the tool asks about first.
    expect(await command({ command: "describe", action: "link_project", projectId: remote.id })).toMatchObject({
      ok: true,
      scope: { environment: "project link" },
    })
  })

  test("a publish to a never-deployed project is described as production", async () => {
    connect()
    const remote = api.addProject({ name: "fresh" })
    link(remote.id, "fresh")
    const command = await bridge()
    expect(await command({ command: "describe", action: "publish" })).toMatchObject({
      ok: true,
      scope: {
        provider: "Vercel",
        project: "fresh",
        environment: "production",
        summary: expect.stringContaining("Vercel makes a project's first deployment production"),
      },
    })
    const live = api.addDeployment({ projectId: remote.id, target: "production" })
    remote.productionId = live.uid
    expect(await command({ command: "describe", action: "publish" })).toMatchObject({
      scope: { environment: "preview", summary: expect.stringContaining("Production does not change") },
    })
  })

  test("lists the provider's deployments, reads runtime logs and rolls back", async () => {
    seed()
    const command = await bridge()
    const listed = await command({ command: "list_deployments" })
    expect(listed.text).toContain("dpl_live · READY · production (serving production)")
    expect(listed.text).toContain('main@1234567 "Fix cart"')
    expect(listed.text).toContain("via git")
    const logs = await command({ command: "logs", source: "runtime", deploymentId: "dpl_live" })
    expect(logs).toMatchObject({ ok: true, logs: { source: "runtime", environment: "production" } })
    expect(logs.logs.tail).toContain("[error] GET /cart 500 · TypeError: cart is undefined")
    const rolled = await command({ command: "rollback" })
    expect(rolled).toMatchObject({ ok: true, text: expect.stringContaining("dpl_old") })
  })

  test("syncs exactly the plan the user approved and never returns a value", async () => {
    seed()
    setEnv(project, undefined, "STRIPE_SECRET", "sk_live_fixture_value")
    const command = await bridge()
    const described = await command({ command: "describe", action: "sync_environment", targets: ["preview"] })
    // toMatchObject rewrites matched fields to its matchers, so the plan is copied first.
    const carry = structuredClone(described.carry)
    expect(described).toMatchObject({
      ok: true,
      scope: {
        project: "shop",
        environment: "preview",
        summary: expect.stringContaining("create STRIPE_SECRET (preview)"),
      },
      carry: { planId: expect.any(String), targets: ["preview"] },
    })
    expect(await command({ command: "sync_environment", targets: ["preview"], planId: "not-the-plan" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed since this plan"),
    })
    const applied = await command({ command: "sync_environment", ...carry })
    expect(applied).toMatchObject({ ok: true, text: expect.stringContaining("create STRIPE_SECRET (preview)") })
    expect(api.state.env.map((item) => item.key)).toEqual(["STRIPE_SECRET"])
    const listed = await command({ command: "list_env" })
    expect(listed.text).toContain("STRIPE_SECRET · preview · encrypted · synced by Vector")
    for (const report of [described, applied, listed, await command({ command: "env_diff" })]) {
      expect(JSON.stringify(report)).not.toContain("sk_live_fixture_value")
    }
    expect(await command({ command: "describe", action: "sync_environment", targets: ["preview"] })).toMatchObject({
      ok: true,
      noop: true,
    })
  })

  test("copies a value the user stored in Vector to Vercel without the model seeing it", async () => {
    seed()
    const command = await bridge()
    expect(
      await command({ command: "describe", action: "set_env", key: "STRIPE_SECRET", targets: ["production"] }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Vector Cloud > Environment variables") })
    expect(await command({ command: "set_env", key: "STRIPE_SECRET", targets: ["production"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("never in chat"),
    })
    setEnv(project, undefined, "STRIPE_SECRET", "sk_live_stored_fixture")
    const described = await command({
      command: "describe",
      action: "set_env",
      key: "STRIPE_SECRET",
      targets: ["production"],
    })
    expect(described).toMatchObject({
      ok: true,
      scope: { environment: "production", summary: expect.stringContaining("value stored for it in this project") },
    })
    const set = await command({ command: "set_env", key: "STRIPE_SECRET", targets: ["production"] })
    expect(set).toMatchObject({ ok: true, text: "Created STRIPE_SECRET on shop for production." })
    expect(api.state.env.find((item) => item.key === "STRIPE_SECRET")?.value).toBe("sk_live_stored_fixture")
    expect(JSON.stringify([described, set])).not.toContain("sk_live_stored_fixture")
  })

  test("checks health, re-runs release checks and changes the required checks from the agent", async () => {
    seed()
    const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
    try {
      recordDeployment({
        projectPath: project,
        slug: "shop",
        url: site.url.origin,
        name: "shop",
        target: "vercel",
        environment: "preview",
        providerDeploymentId: "dpl_site",
        checks: [],
      })
      const command = await bridge()
      // The prompt names exactly which gate stops blocking production.
      const described = await command({
        command: "describe",
        action: "set_release_settings",
        requiredChecks: { browser: false },
        testCommand: "bun test",
      })
      expect(described.scope.summary).toBe(
        "Change the release settings Vector uses before it publishes: test command bun test; Browser render no longer blocks a production release.",
      )
      expect(described).toMatchObject({
        ok: true,
        noop: false,
        scope: { provider: "Vector Cloud", project: "shop", environment: "release checks" },
      })
      const saved = await command({
        command: "set_release_settings",
        requiredChecks: { browser: false },
        testCommand: "bun test",
      })
      expect(saved.text).toContain("Required before production: Secret scan, Health probe.")
      expect(getBuildSettings(project)).toMatchObject({
        testCommand: "bun test",
        requiredChecks: { test: false, secrets: true, health: true, browser: false },
      })
      expect(
        await command({ command: "describe", action: "set_release_settings", testCommand: "bun test" }),
      ).toMatchObject({ ok: true, noop: true })

      const health = await command({ command: "check_health" })
      expect(health).toMatchObject({ ok: true, text: expect.stringContaining("(dpl_site) · ready · HTTP 200") })
      expect(await command({ command: "check_health", deploymentId: "dpl_site" })).toMatchObject({
        ok: true,
        url: `${site.url.origin}/`,
        text: expect.stringContaining("ready · HTTP 200"),
      })
      const rerun = await command({ command: "rerun_checks", deploymentId: "dpl_site" })
      expect(rerun.text).toContain("passed · Health check / (required): HTTP 200")
      expect(rerun.text).toContain("skipped · Browser smoke test")
      expect(rerun.text).toContain("No required check failed.")
      expect(await command({ command: "rerun_checks", deploymentId: "dpl_live" })).toMatchObject({
        ok: false,
        error: expect.stringContaining("Vector did not publish dpl_live"),
      })
      expect(await command({ command: "rerun_checks" })).toMatchObject({ ok: false })
    } finally {
      await site.stop(true)
    }
  })

  test("sets a variable, manages domains and creates a project from the agent", async () => {
    seed()
    const command = await bridge()
    expect(
      await command({
        command: "describe",
        action: "set_env",
        key: "API_URL",
        value: "https://api.shop",
        targets: ["production"],
      }),
    ).toMatchObject({
      scope: { environment: "production", summary: expect.stringContaining("Set API_URL") },
    })
    const set = await command({
      command: "set_env",
      key: "API_URL",
      value: "https://api.shop",
      targets: ["production"],
    })
    expect(set).toMatchObject({ ok: true, text: "Created API_URL on shop for production." })
    const added = await command({ command: "add_domain", domain: "www.shop.example" })
    expect(added.text).toContain("CNAME www → cname.vercel-dns-fixture.com (routing)")
    expect(added.text).toContain("TXT _vercel.shop.example")
    expect((await command({ command: "list_domains" })).text).toContain("www.shop.example: needs verification")
    expect(await command({ command: "remove_domain", domain: "www.shop.example" })).toMatchObject({ ok: true })

    await command({ command: "unlink_project" })
    expect(await command({ command: "list_env" })).toMatchObject({
      ok: false,
      needsSetup: true,
      errorCode: "not_linked",
    })
    const created = await command({ command: "create_project", name: "shop-two", framework: "vite", teamId: "team_1" })
    expect(created).toMatchObject({ ok: true, text: expect.stringContaining("shop-two") })
    expect((await command({ command: "vercel_project" })).text).toContain("Linked Vercel project: shop-two")
    expect((await command({ command: "vercel_scopes" })).text).toContain("Acme (teamId team_1, slug acme)")
    expect((await command({ command: "vercel_projects", teamId: "team_1" })).text).toContain("shop-two (projectId")
  })
})
