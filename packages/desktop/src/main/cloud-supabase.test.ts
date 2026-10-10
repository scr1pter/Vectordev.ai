import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The Supabase commands read connections and project records through ./store,
// and cloud-console reaches electron for the user data path, so both are
// stand-ins; every provider request goes to the local fake Supabase server.
const userDataPath = join(tmpdir(), "vector-cloud-supabase-test")
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

const { describeSupabaseCommand, runSupabaseCommand } = await import("./cloud-supabase")
const { cloudProjectScopeKey, getDatabase, listEnv, recordDeployment, setEnv } = await import("./cloud-console")
const { encryptCloudCredential } = await import("./cloud-credential-vault")
const { startCloudBridge, stopCloudBridge } = await import("./cloud-bridge")
const { supabaseReleaseCheck } = await import("./cloud-supabase-security")
const { ANON_KEY, MANAGEMENT_TOKEN, SERVICE_KEY, startSupabaseFake } = await import("../../test/supabase-fake")

type Fake = Awaited<ReturnType<typeof startSupabaseFake>>

let project = ""
let fake: Fake

function seed(name: string, key: string, value: unknown) {
  if (!stores.has(name)) stores.set(name, new Map())
  stores.get(name)!.set(key, value)
}

function connect(providers: ("supabase" | "vercel")[] = ["supabase"]) {
  seed(
    "cloud-provider-connections",
    "records",
    providers.map((provider) => ({
      provider,
      accessToken: encryptCloudCredential(provider === "supabase" ? MANAGEMENT_TOKEN : "fixture-vercel-token"),
      connectedAt: "2026-10-01T00:00:00.000Z",
    })),
  )
}

function linkDatabase(record: Record<string, unknown> = {}) {
  seed("cloud-projects", cloudProjectScopeKey(project), {
    env: [],
    database: {
      provider: "supabase",
      url: "https://fixtureref.supabase.co",
      anonKey: ANON_KEY,
      projectRef: "fixtureref",
      projectName: "shop-db",
      connectedAt: "2026-10-01T00:00:00.000Z",
      ...record,
    },
    domains: [],
    build: null,
  })
}

function linkVercel() {
  seed("cloud-provider-links", cloudProjectScopeKey(project), [
    {
      provider: "vercel",
      projectId: "prj_shop",
      projectName: "shop",
      url: "https://shop.vercel.app",
      linkedAt: "2026-10-01T00:00:00.000Z",
    },
  ])
}

type Report = { ok: boolean; error?: string; needsSetup?: boolean; nextStep?: string } & Record<string, any>

function run(command: string, input: Record<string, unknown> = {}, caller: "console" | "agent" = "console") {
  return runSupabaseCommand(
    command,
    { projectPath: project, ...input },
    { caller, request: fake.request },
  ) as Promise<Report>
}

// Nothing secret may appear in a result the console or the model receives.
function expectNoSecrets(value: unknown, ...more: string[]) {
  const text = JSON.stringify(value)
  for (const secret of [MANAGEMENT_TOKEN, SERVICE_KEY, ...more]) expect(text).not.toContain(secret)
}

beforeEach(async () => {
  stores.clear()
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64")
  project = await mkdtemp(join(tmpdir(), "vector-supabase-"))
  fake = await startSupabaseFake()
})

afterEach(async () => {
  await stopCloudBridge()
  fake.stop()
  await rm(project, { recursive: true, force: true })
  await rm(userDataPath, { recursive: true, force: true })
  delete process.env.VECTOR_CREDENTIAL_KEY
})

describe("projects", () => {
  test("lists organizations, projects and regions without a linked project", async () => {
    connect()
    const report = await run("supabase_projects")
    expect(report).toMatchObject({
      ok: true,
      organizations: [{ id: "org-solo", name: "Solo", plan: "free" }],
      projects: [{ ref: "fixtureref", name: "shop-db", region: "us-east-1", status: "ACTIVE_HEALTHY" }],
      linked: null,
      pending: null,
    })
    expect(report.regions.map((region: { id: string }) => region.id)).toContain("eu-west-2")
    expectNoSecrets(report)
  })

  test("says how to connect Supabase when the account is not connected", async () => {
    expect(await run("supabase_projects")).toMatchObject({
      ok: false,
      needsSetup: true,
      nextStep: expect.stringContaining("Cloud Services > Integrations"),
    })
  })

  test("says to reconnect when Supabase rejects the token or does not allow the action", async () => {
    connect()
    linkDatabase()
    fake.state.fail = (call) =>
      call.path === "/v1/organizations"
        ? Response.json({ message: "Unauthorized" }, { status: 401 })
        : call.path.endsWith("/config/auth")
          ? Response.json({ message: "Forbidden resource" }, { status: 403 })
          : undefined
    const rejected = await run("supabase_projects")
    expect(rejected.ok).toBe(false)
    expect(rejected.nextStep).toContain("rejected Vector's saved credentials")
    const forbidden = await run("auth_config")
    expect(forbidden.error).toBe("Forbidden resource")
    expect(forbidden.nextStep).toContain("grant the access it asks for")
  })

  test("links a project with the framework's public names, a TypeScript client and an ignored .env", async () => {
    connect()
    await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }))
    await writeFile(join(project, "tsconfig.json"), "{}")
    const report = await run("link_database", { projectRef: "fixtureref" })
    expect(report).toMatchObject({
      ok: true,
      database: { ref: "fixtureref", name: "shop-db" },
      client: { path: join("lib", "supabase.ts"), created: false, dependencyMissing: true },
      nextStep: expect.stringContaining("@supabase/supabase-js"),
    })
    expect(listEnv(project).map((item) => [item.key, item.visibility])).toEqual([
      ["NEXT_PUBLIC_SUPABASE_URL", "public"],
      ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "public"],
    ])
    expect(await readFile(join(project, "lib", "supabase.ts"), "utf8")).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    expect(await readFile(join(project, ".gitignore"), "utf8")).toContain(".env")
    expect(await readFile(join(project, ".env"), "utf8")).toContain(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}`)
    expectNoSecrets(report)
  })

  test("an unrecognised framework gets a guarded client and is told the names may need renaming", async () => {
    connect()
    await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { "@supabase/supabase-js": "2" } }))
    const report = await run("link_database", { projectRef: "fixtureref" })
    expect(report).toMatchObject({ ok: true, nextStep: expect.stringContaining("rename them to the prefix") })
    expect(await readFile(join(project, "src", "lib", "supabase.js"), "utf8")).toContain(
      'typeof process === "undefined" ? undefined : process.env.SUPABASE_URL',
    )
  })

  test("an older record without a reference finds its project from the URL", async () => {
    connect()
    linkDatabase({ projectRef: undefined })
    expect(getDatabase(project)?.projectRef).toBe("fixtureref")
    expect(await run("auth_config")).toMatchObject({ ok: true, auth: { siteUrl: "http://localhost:3000" } })
  })

  test("unlinks without touching the Supabase project or .env", async () => {
    connect()
    linkDatabase()
    expect(await run("unlink_database")).toMatchObject({ ok: true, unlinked: { ref: "fixtureref" } })
    expect(getDatabase(project)).toBeNull()
    expect(fake.calls).toEqual([])
  })

  test("creates a project from the console with progress, asking for the organization when there are several", async () => {
    connect()
    fake.state.organizations.push({ id: "org-team", name: "Team", plan: "pro" })
    const events: string[] = []
    const progress = (event: { stage: string }) => events.push(event.stage)
    const choose = (await runSupabaseCommand(
      "create_project",
      { projectPath: project },
      { caller: "console", request: fake.request, progress },
    )) as Report
    expect(choose).toMatchObject({
      ok: false,
      needsChoice: true,
      organizations: [{ id: "org-solo" }, { id: "org-team" }],
    })
    expect(fake.calls.filter((call) => call.method === "POST")).toEqual([])

    const created = (await runSupabaseCommand(
      "create_project",
      { projectPath: project, organizationId: "org-team", region: "eu-west-2" },
      { caller: "console", request: fake.request, progress },
    )) as Report
    expect(created).toMatchObject({ ok: true, createdNow: true, database: { projectRef: "newprojectref01" } })
    expect(fake.calls.find((call) => call.method === "POST" && call.path === "/v1/projects")?.body).toMatchObject({
      organization_id: "org-team",
      region: "eu-west-2",
    })
    expect(events).toEqual(["checking", "checking", "creating", "waiting", "linking"])
    expect(getDatabase(project)?.projectRef).toBe("newprojectref01")
    expectNoSecrets(created, fake.state.password ?? "")
  })

  test("pauses and restores the linked project", async () => {
    connect()
    linkDatabase()
    expect(await run("pause_database")).toMatchObject({ ok: true, project: { status: "PAUSING" } })
    expect(await run("restore_database")).toMatchObject({ ok: true, project: { status: "RESTORING" } })
    expect(fake.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/v1/projects/fixtureref/pause",
      "/v1/projects/fixtureref/restore",
    ])
  })
})

describe("database credentials", () => {
  test("DATABASE_URL needs consent and a password Vector knows", async () => {
    connect()
    linkDatabase()
    expect(await run("write_database_url")).toMatchObject({
      ok: false,
      needsSetup: true,
      error: expect.stringContaining("consent"),
    })
    expect(await run("write_database_url", { consent: true })).toMatchObject({
      ok: false,
      needsSetup: true,
      nextStep: expect.stringContaining("enter the current database password in Cloud Services > Database"),
    })
    expect(listEnv(project)).toEqual([])
  })

  test("a linked project's existing password, typed in the console, writes DATABASE_URL without a reset", async () => {
    connect()
    linkDatabase()
    const existing = "fixture-existing-db-password"
    // The agent never carries a password.
    expect(await run("write_database_url", { password: existing }, "agent")).toMatchObject({
      ok: false,
      error: expect.stringContaining("never through chat"),
    })
    const report = await run("write_database_url", { consent: true, password: existing })
    expect(report).toMatchObject({ ok: true, variable: { key: "DATABASE_URL", visibility: "server" } })
    expect(report.detail).toContain("Vector cannot check the password")
    expect(listEnv(project).find((item) => item.key === "DATABASE_URL")?.value).toContain(existing)
    expect(fake.calls.some((call) => call.path.endsWith("/database/password"))).toBe(false)
    // Kept encrypted, so a later write needs no password again.
    expect(JSON.stringify([...(stores.get("cloud-supabase-database")?.values() ?? [])])).not.toContain(existing)
    expect(await run("write_database_url", { consent: true })).toMatchObject({ ok: true })
    expectNoSecrets(report, existing)
  })

  test("DATABASE_URL is never written into a .env that git tracks", async () => {
    connect()
    linkDatabase()
    execFileSync("git", ["init", "-q"], { cwd: project })
    await writeFile(join(project, ".env"), "PUBLIC_FLAG=1\n")
    await writeFile(join(project, ".gitignore"), ".env\n")
    execFileSync("git", ["add", "-f", ".env", ".gitignore"], { cwd: project })
    const report = await run("write_database_url", { consent: true, password: "fixture-existing-db-password" })
    expect(report).toMatchObject({
      ok: false,
      needsSetup: true,
      error: expect.stringContaining(".env is committed to git"),
      nextStep: expect.stringContaining("git rm --cached .env"),
    })
    expect(await readFile(join(project, ".env"), "utf8")).toBe("PUBLIC_FLAG=1\n")
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe(".env\n")
    expect(listEnv(project).some((item) => item.key === "DATABASE_URL")).toBe(false)
  })

  test("rotation resets the password, writes a server-only DATABASE_URL and pushes it to Vercel", async () => {
    connect(["supabase", "vercel"])
    linkDatabase()
    linkVercel()
    const report = await run("rotate_database_password", { writeDatabaseUrl: true, syncVercel: true })
    const password = fake.state.password ?? ""
    expect(password.length).toBeGreaterThanOrEqual(32)
    expect(report).toMatchObject({
      ok: true,
      rotated: true,
      databaseUrl: "written",
      vercel: { synced: true, projectName: "shop" },
    })
    const variable = listEnv(project).find((item) => item.key === "DATABASE_URL")
    expect(variable).toEqual({
      key: "DATABASE_URL",
      visibility: "server",
      value: `postgresql://postgres.fixtureref:${password}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    })
    expect(await readFile(join(project, ".env"), "utf8")).toContain("DATABASE_URL=")
    // Only DATABASE_URL goes to Vercel, for every environment.
    expect(fake.state.vercelEnv).toEqual([
      expect.objectContaining({
        key: "DATABASE_URL",
        value: variable?.value,
        target: ["production", "preview", "development"],
      }),
    ])
    expectNoSecrets(report, password)

    // A second rotation follows the DATABASE_URL that points at this project.
    const again = await run("rotate_database_password")
    expect(again).toMatchObject({ ok: true, databaseUrl: "updated", vercel: { synced: false } })
    expect(listEnv(project).find((item) => item.key === "DATABASE_URL")?.value).toContain(
      fake.state.password ?? "missing",
    )

    // Pushed again, the new value replaces Vercel's entry where it stands, for
    // the environments the user left it in.
    fake.state.vercelEnv[0].target = ["production"]
    const third = await run("rotate_database_password", { syncVercel: true })
    expect(third).toMatchObject({ ok: true, databaseUrl: "updated", vercel: { synced: true, changed: 1 } })
    expect(fake.state.vercelEnv).toEqual([
      expect.objectContaining({
        key: "DATABASE_URL",
        value: listEnv(project).find((item) => item.key === "DATABASE_URL")?.value,
        target: ["production"],
      }),
    ])
    expect(fake.state.vercelEnv[0].value).toContain(fake.state.password ?? "missing")
  })

  test("a rotation whose later steps fail still says the password changed", async () => {
    connect()
    linkDatabase()
    fake.state.fail = (call) =>
      call.path.endsWith("/config/database/pooler")
        ? Response.json({ message: "pooler unavailable" }, { status: 503 })
        : undefined
    const report = await run("rotate_database_password", { writeDatabaseUrl: true })
    expect(report).toMatchObject({
      ok: true,
      rotated: true,
      databaseUrl: "failed",
      problems: ["DATABASE_URL was not updated: pooler unavailable"],
    })
    expect(report.detail).toContain("was reset and saved encrypted")
    expect(listEnv(project).some((item) => item.key === "DATABASE_URL")).toBe(false)
    expectNoSecrets(report, fake.state.password ?? "")
  })

  test("a project Vector created can write DATABASE_URL with the password it generated", async () => {
    connect()
    const created = await run("create_project", { organizationId: "org-solo" })
    expect(created.ok).toBe(true)
    const report = await run("write_database_url", { consent: true })
    expect(report).toMatchObject({ ok: true, variable: { key: "DATABASE_URL", visibility: "server", port: 6543 } })
    expect(listEnv(project).find((item) => item.key === "DATABASE_URL")?.value).toContain(
      fake.state.password ?? "missing",
    )
    expectNoSecrets(report, fake.state.password ?? "")
  })
})

// The fake database behind the query endpoint keeps Vector's history table and
// the Supabase CLI's, and records every statement.
function trackingDatabase(initial: { tracked?: { name: string; checksum: string }[]; versions?: string[] } = {}) {
  const state = {
    tracked: initial.tracked,
    versions: initial.versions,
    statements: [] as { sql: string; readOnly: boolean }[],
  }
  fake.state.sql = (sql, readOnly) => {
    state.statements.push({ sql, readOnly })
    if (sql.startsWith("create schema if not exists vector;")) {
      state.tracked ??= []
      return []
    }
    if (sql.includes("to_regclass('vector.schema_migrations') is not null as tracked")) {
      return [{ tracked: Boolean(state.tracked), legacy: false, cli: Boolean(state.versions) }]
    }
    if (sql.startsWith("select name, checksum from vector.schema_migrations")) return state.tracked ?? []
    if (sql.startsWith("select version from supabase_migrations")) {
      return (state.versions ?? []).map((version) => ({ version }))
    }
    const insert = sql.match(/insert into vector\.schema_migrations \(name, checksum\) values \('([^']+)', '([^']+)'\)/)
    if (insert) state.tracked = [...(state.tracked ?? []), { name: insert[1], checksum: insert[2] }]
    const removed = sql.match(/delete from vector\.schema_migrations where name = '([^']+)'/)
    if (removed) state.tracked = (state.tracked ?? []).filter((row) => row.name !== removed[1])
    const cli = sql.match(/delete from supabase_migrations\.schema_migrations where version = '([^']+)'/)
    if (cli) state.versions = (state.versions ?? []).filter((version) => version !== cli[1])
    return []
  }
  return state
}

const sha = (sql: string) => createHash("sha256").update(sql).digest("hex")

describe("migrations", () => {
  test("creates a timestamped migration with its down file, applies it and rolls it back", async () => {
    connect()
    linkDatabase()
    const database = trackingDatabase()
    // The agent's edit prompt names the files and shows both SQL texts before
    // anything is written, and the approved version comes back with the command.
    const planned = await describeSupabaseCommand(
      "create_migration",
      {
        projectPath: project,
        name: "Add profiles!",
        sql: "create table profiles (id uuid primary key);",
        downSql: "drop table profiles;",
      },
      [],
    )
    expect(planned).toEqual({
      ok: true,
      files: [
        expect.stringMatching(/^supabase\/migrations\/\d{14}_add_profiles\.sql$/),
        expect.stringMatching(/^supabase\/migrations\/down\/\d{14}_add_profiles\.down\.sql$/),
      ],
      statements: [
        expect.objectContaining({ label: expect.stringContaining("Migration supabase/migrations/") }),
        {
          label: expect.stringContaining("which rollback_migration runs"),
          sql: "drop table profiles;",
          length: 20,
          truncated: false,
        },
      ],
      approved: { version: expect.stringMatching(/^\d{14}$/) },
    })
    // An approval that waited past the next second still writes the named file.
    const version = "20260101000000"
    const created = await run("create_migration", {
      name: "Add profiles!",
      sql: "create table profiles (id uuid primary key);",
      downSql: "drop table profiles;",
      version,
    })
    expect(created.file).toBe(`supabase/migrations/${version}_add_profiles.sql`)
    expect(created.downFile).toBe(`supabase/migrations/down/${version}_add_profiles.down.sql`)
    expect(await run("create_migration", { name: "again", sql: "select 1;", version })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already exists"),
    })
    const name = created.file.split("/").at(-1)

    expect(await run("migration_status")).toMatchObject({
      ok: true,
      migrations: { dryRun: true, pending: [name], projectRef: "fixtureref" },
      rollback: undefined,
    })
    expect(await run("apply_migrations")).toMatchObject({ ok: true, migrations: { applied: [name] } })
    expect(await run("migration_status")).toMatchObject({
      migrations: { alreadyApplied: [name], pending: [] },
      rollback: { name, available: true, source: "file" },
    })

    // The agent's prompt shows the down SQL; the run refuses SQL that changed
    // after that, and the agent cannot skip the prompt's checksum.
    const described = (await describeSupabaseCommand("rollback_migration", { projectPath: project }, [], {
      request: fake.request,
    })) as Report
    expect(described).toMatchObject({
      ok: true,
      repeatable: false,
      scope: { summary: expect.stringContaining(`Roll back ${name}`) },
      statements: [{ label: expect.stringContaining(".down.sql"), sql: "drop table profiles;" }],
      approved: { name, downChecksum: sha("drop table profiles;\n") },
    })
    expect(await run("rollback_migration", {}, "agent")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Describe rollback_migration first"),
    })
    await writeFile(join(project, created.downFile), "drop table profiles cascade;\n")
    expect(await run("rollback_migration", described.approved, "agent")).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed after it was approved"),
    })
    await writeFile(join(project, created.downFile), "drop table profiles;\n")

    const rolled = await run("rollback_migration", described.approved, "agent")
    expect(rolled).toMatchObject({ ok: true, rolledBack: name, nextStep: expect.stringContaining("apply_migrations") })
    expect(database.statements.at(-1)?.sql).toStartWith("drop table profiles;")
    expect(database.tracked).toEqual([])
  })

  test("refuses to roll back without a down migration, or anything but the latest", async () => {
    connect()
    linkDatabase()
    await mkdir(join(project, "supabase", "migrations"), { recursive: true })
    await writeFile(join(project, "supabase", "migrations", "20260101000000_init.sql"), "create table a ();")
    await writeFile(
      join(project, "supabase", "migrations", "20260102000000_more.sql"),
      "create table b ();\n-- down\ndrop table b;\n",
    )
    const database = trackingDatabase({
      tracked: [{ name: "20260101000000_init.sql", checksum: sha("create table a ();") }],
      versions: ["20260102000000"],
    })
    expect(await run("rollback_migration", { name: "20260101000000_init.sql" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("that is 20260102000000_more.sql"),
    })
    // A down migration Postgres rejects leaves the history alone.
    const tracking = fake.state.sql
    fake.state.sql = (sql, readOnly) =>
      sql.startsWith("drop table b;") ? { error: 'table "b" is referenced', status: 400 } : tracking(sql, readOnly)
    expect(await run("rollback_migration")).toEqual({
      ok: false,
      error: 'Rolling back 20260102000000_more.sql failed and nothing changed: table "b" is referenced',
    })
    expect(database.versions).toEqual(["20260102000000"])
    fake.state.sql = tracking
    // The -- down section is the rollback, and the CLI's history row goes too.
    expect(await run("rollback_migration")).toMatchObject({ ok: true, rolledBack: "20260102000000_more.sql" })
    expect(database.statements.at(-1)?.sql).toStartWith("drop table b;")
    expect(database.versions).toEqual([])
    expect(await run("rollback_migration")).toMatchObject({
      ok: false,
      error: "20260101000000_init.sql has no down migration, so Vector will not guess how to undo it.",
    })
  })

  test("warns about down SQL the Supabase command-line tool would run forward, and never rolls back with it", async () => {
    connect()
    linkDatabase()
    await mkdir(join(project, "supabase", "migrations"), { recursive: true })
    await writeFile(join(project, "supabase", "migrations", "20260101000000_a.sql"), "create table a ();")
    await writeFile(join(project, "supabase", "migrations", "20260101000000_a.down.sql"), "drop table a;")
    await writeFile(
      join(project, "supabase", "migrations", "20260102000000_b.sql"),
      "create table b ();\n-- down\ndrop table b;\n",
    )
    trackingDatabase({ tracked: [{ name: "20260101000000_a.sql", checksum: sha("create table a ();") }] })
    const status = await run("migration_status")
    expect(status.warnings).toEqual([
      expect.stringContaining("runs 20260101000000_a.down.sql as a forward migration"),
      expect.stringContaining("20260102000000_b.sql has a -- down section"),
    ])
    // A top-level .down.sql is not where Vector looks for a rollback.
    expect(status.rollback).toEqual({ name: "20260101000000_a.sql", available: false, source: undefined })
  })

  test("a forward run executes only what is above a -- down section, and skips .down.sql files", async () => {
    connect()
    linkDatabase()
    await mkdir(join(project, "supabase", "migrations"), { recursive: true })
    await writeFile(
      join(project, "supabase", "migrations", "1_a.sql"),
      "create table a ();\n-- migrate:down\ndrop table a;",
    )
    await writeFile(join(project, "supabase", "migrations", "1_a.down.sql"), "drop table a;")
    const database = trackingDatabase()
    expect(await run("apply_migrations")).toMatchObject({
      ok: true,
      migrations: { discovered: ["1_a.sql"], applied: ["1_a.sql"] },
    })
    const applied = database.statements.find((item) => item.sql.includes("values ('1_a.sql'"))
    expect(applied?.sql).toStartWith("create table a ();")
    expect(applied?.sql).not.toContain("drop table a")
  })
})

describe("SQL console", () => {
  test("reads run read-only and come back as a table", async () => {
    connect()
    linkDatabase()
    const sent: { sql: string; readOnly: boolean }[] = []
    fake.state.sql = (sql, readOnly) => {
      sent.push({ sql, readOnly })
      return [
        { id: 1, email: "a@example.com", meta: { plan: "pro" } },
        { id: 2, email: null, meta: null },
      ]
    }
    const report = await run("run_sql", { sql: "select * from profiles" })
    expect(report).toMatchObject({
      ok: true,
      result: {
        columns: ["id", "email", "meta"],
        rows: [
          [1, "a@example.com", '{"plan":"pro"}'],
          [2, null, null],
        ],
        rowCount: 2,
        truncated: false,
        readOnly: true,
      },
    })
    expect(sent).toEqual([{ sql: "select * from profiles", readOnly: true }])
  })

  test("a write is refused until it is confirmed, then runs as a write", async () => {
    connect()
    linkDatabase()
    fake.state.sql = (sql, readOnly) =>
      readOnly ? { error: "cannot execute DELETE in a read-only transaction" } : [{ deleted: 3 }]
    expect(await run("run_sql", { sql: "delete from sessions" })).toMatchObject({
      ok: false,
      needsConfirmation: true,
      error: expect.stringContaining("read-only mode"),
    })
    expect(await run("run_sql", { sql: "delete from sessions", write: true })).toMatchObject({
      ok: true,
      result: { rows: [[3]], readOnly: false },
    })
  })

  test("a read the role may not do is reported as it is, not as a write to confirm", async () => {
    connect()
    linkDatabase()
    fake.state.sql = () => ({ error: "permission denied for table secrets_audit" })
    const report = await run("run_sql", { sql: "select * from secrets_audit" }, "agent")
    expect(report).toEqual({ ok: false, error: "permission denied for table secrets_audit", nextStep: undefined })
  })

  test("the agent never gets cells from credential columns; the console does", async () => {
    connect()
    linkDatabase()
    fake.state.sql = () => [
      { id: 1, email: "a@example.com", encrypted_password: "$2a$10$fixturehash", token: "fixture-refresh-token" },
    ]
    const agent = await run("run_sql", { sql: "select * from auth.users" }, "agent")
    expect(agent.result).toMatchObject({
      columns: ["id", "email", "encrypted_password", "token"],
      rows: [[1, "a@example.com", "[hidden]", "[hidden]"]],
      hiddenColumns: ["encrypted_password", "token"],
    })
    expectNoSecrets(agent, "$2a$10$fixturehash", "fixture-refresh-token")
    const console = await run("run_sql", { sql: "select * from auth.users" })
    expect(console.result.rows).toEqual([[1, "a@example.com", "$2a$10$fixturehash", "fixture-refresh-token"]])
    expect(console.result.hiddenColumns).toBeUndefined()
  })

  test("the agent's results are bounded and scrubbed of credentials and stored values", async () => {
    connect()
    linkDatabase()
    setEnv(project, undefined, "STRIPE_SECRET_KEY", "fixture-stripe-value-123")
    fake.state.sql = () =>
      Array.from({ length: 250 }, (_, index) => ({
        index,
        note: `${SERVICE_KEY} fixture-stripe-value-123 ${"x".repeat(400)}`,
      }))
    const report = await run("run_sql", { sql: "select * from notes", maxRows: 500 }, "agent")
    expect(report.result.rows).toHaveLength(200)
    expect(report.result).toMatchObject({ rowCount: 250, truncated: true })
    expect(report.result.rows[0][1].length).toBeLessThanOrEqual(301)
    expectNoSecrets(report, "fixture-stripe-value-123")
  })
})

describe("authentication", () => {
  test("edits the site URL and redirects, and enables a provider only with its secret", async () => {
    connect()
    linkDatabase()
    expect(await run("auth_config")).toMatchObject({
      auth: {
        siteUrl: "http://localhost:3000",
        redirectUrls: ["http://localhost:3000/**"],
        email: { enabled: true },
        providers: { google: { enabled: false, secretSet: false } },
      },
    })
    expect(
      await run("update_auth", {
        siteUrl: "https://shop.example.com",
        addRedirectUrls: ["https://shop.example.com/**", "myapp://callback"],
        emailEnabled: false,
      }),
    ).toMatchObject({
      ok: true,
      auth: {
        siteUrl: "https://shop.example.com",
        redirectUrls: ["http://localhost:3000/**", "https://shop.example.com/**", "myapp://callback"],
        email: { enabled: false },
      },
    })
    expect(
      await run("update_auth", { providers: { google: { enabled: true, clientId: "google-client" } } }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("client secret"),
    })
    const enabled = await run("update_auth", {
      providers: { google: { enabled: true, clientId: "google-client", secret: "google-fixture-secret" } },
    })
    expect(enabled).toMatchObject({
      ok: true,
      auth: { providers: { google: { enabled: true, clientId: "google-client", secretSet: true } } },
      changed: expect.arrayContaining(["external_google_secret (set)"]),
    })
    expectNoSecrets(enabled, "google-fixture-secret")
    expect(fake.state.auth.external_google_secret).toBe("google-fixture-secret")
    expect(await run("update_auth", { redirectUrls: ["not a url"] })).toMatchObject({ ok: false })
  })

  test("the agent can never pass a client secret, and its redirect URLs are additions", async () => {
    connect()
    linkDatabase()
    expect(
      await run("update_auth", { providers: { github: { enabled: true, clientId: "gh", secret: "x" } } }, "agent"),
    ).toMatchObject({ ok: false, error: expect.stringContaining("never through chat") })
    expect(await run("update_auth", { redirectUrls: ["https://new.example.com/**"] }, "agent")).toMatchObject({
      ok: true,
      auth: { redirectUrls: ["http://localhost:3000/**", "https://new.example.com/**"] },
    })
  })

  test("adds the linked Vercel production and preview addresses", async () => {
    connect(["supabase", "vercel"])
    linkDatabase()
    linkVercel()
    recordDeployment({
      slug: "preview",
      url: "https://shop-a1b2c3d4e-krishnas-projects.vercel.app",
      name: "shop",
      projectPath: project,
      target: "vercel",
      environment: "preview",
    })
    expect(await run("vercel_redirect_urls")).toMatchObject({
      ok: true,
      siteUrl: "https://shop.vercel.app",
      redirectUrls: ["https://shop.vercel.app/**", "https://*-krishnas-projects.vercel.app/**"],
    })
    // The agent's prompt names each address it would allow.
    const described = await describeSupabaseCommand("update_auth", { projectPath: project, addVercelUrls: true }, [], {
      request: fake.request,
    })
    expect(described).toMatchObject({
      repeatable: true,
      scope: {
        summary:
          "Change Supabase Auth on shop-db: allow redirects to https://shop.vercel.app/**, https://*-krishnas-projects.vercel.app/**.",
      },
    })
    // Turning a method off or removing an address can lock users out.
    for (const narrowing of [
      { emailEnabled: false },
      { removeRedirectUrls: ["http://localhost:3000/**"] },
      { providers: { github: { enabled: false } } },
    ]) {
      expect(await describeSupabaseCommand("update_auth", { projectPath: project, ...narrowing }, [])).toMatchObject({
        repeatable: false,
      })
    }
    // A new site URL, or an address that is not one of the linked Vercel ones,
    // is somewhere sign-in can hand over a session, so an earlier "always"
    // for the Vercel addresses never covers it.
    for (const widening of [
      { siteUrl: "https://shop.example.com" },
      { redirectUrls: ["https://attacker.example/**"] },
      { redirectUrls: ["https://shop.vercel.app/**", "https://attacker.example/**"] },
    ]) {
      expect(
        await describeSupabaseCommand("update_auth", { projectPath: project, ...widening }, [], {
          request: fake.request,
        }),
      ).toMatchObject({ repeatable: false })
    }
    expect(
      await describeSupabaseCommand(
        "update_auth",
        { projectPath: project, redirectUrls: ["https://shop.vercel.app/**"] },
        [],
        { request: fake.request },
      ),
    ).toMatchObject({ repeatable: true })
    expect(
      await describeSupabaseCommand(
        "update_auth",
        { projectPath: project, providers: { google: { clientId: "fixture-client.apps.example" } } },
        [],
      ),
    ).toMatchObject({
      scope: {
        summary:
          "Change Supabase Auth on shop-db: update google sign-in with the client id fixture-client.apps.example.",
      },
    })
    expect(await run("update_auth", { addVercelUrls: true })).toMatchObject({
      ok: true,
      auth: {
        redirectUrls: [
          "http://localhost:3000/**",
          "https://shop.vercel.app/**",
          "https://*-krishnas-projects.vercel.app/**",
        ],
      },
    })
  })

  test("suggests the custom domains Vercel verified for the linked project", async () => {
    connect(["supabase", "vercel"])
    linkDatabase()
    linkVercel()
    fake.state.vercelDomains = [
      { name: "shop.example.com", verified: true },
      { name: "www.shop.example.com", verified: true, redirect: "shop.example.com" },
      { name: "pending.example.com", verified: false },
    ]
    expect(await run("vercel_redirect_urls")).toMatchObject({
      ok: true,
      siteUrl: "https://shop.example.com",
      redirectUrls: ["https://shop.example.com/**", "https://shop.vercel.app/**"],
    })
    expect(fake.calls.find((call) => call.path === "/v9/projects/prj_shop/domains")?.authorization).toBe(
      "Bearer fixture-vercel-token",
    )
  })

  test("finds the preview team from Vercel when Vector has not published a preview", async () => {
    connect(["supabase", "vercel"])
    linkDatabase()
    linkVercel()
    fake.state.vercelDeployments = [{ url: "shop-9z8y7x6w5-team-slug.vercel.app" }]
    expect((await run("vercel_redirect_urls")).redirectUrls).toContain("https://*-team-slug.vercel.app/**")
  })

  test("lists, invites and deletes users with the service key held in the main process", async () => {
    connect()
    linkDatabase()
    const invited = await run("invite_user", { email: "New@Example.com" })
    expect(invited).toMatchObject({ ok: true, invited: { email: "new@example.com" } })
    const listed = await run("auth_users")
    expect(listed).toMatchObject({ ok: true, users: [{ email: "new@example.com", confirmed: false }], hasMore: false })
    expect(await run("delete_user", { userId: listed.users[0].id })).toMatchObject({ ok: true })
    expect((await run("auth_users")).users).toEqual([])
    expect(await run("delete_user", { userId: "nope" })).toMatchObject({ ok: false })
    // The secret key goes only as apikey, never as a bearer token.
    const serviceCalls = fake.calls.filter((call) => call.host === "fixtureref.supabase.co")
    expect(serviceCalls.every((call) => call.apikey === SERVICE_KEY && !call.authorization)).toBe(true)
    expectNoSecrets([invited, listed])
  })
})

describe("storage", () => {
  test("creates, updates and deletes buckets, emptying only when asked", async () => {
    connect()
    linkDatabase()
    expect(
      await run("create_bucket", { bucket: "avatars", public: false, allowedMimeTypes: ["image/*"] }),
    ).toMatchObject({
      ok: true,
      bucket: "avatars",
    })
    expect(await run("update_bucket", { bucket: "avatars", public: true })).toMatchObject({ ok: true, public: true })
    expect(await run("buckets")).toMatchObject({
      ok: true,
      buckets: [{ id: "avatars", public: true, allowedMimeTypes: ["image/*"] }],
    })
    // The console's limits editor: a size is set, and an empty type list clears it.
    expect(
      await run("update_bucket", { bucket: "avatars", fileSizeLimit: 2_097_152, allowedMimeTypes: null }),
    ).toMatchObject({ ok: true, public: true })
    expect((await run("buckets")).buckets[0]).toMatchObject({ public: true, fileSizeLimit: 2_097_152 })
    expect((await run("buckets")).buckets[0].allowedMimeTypes).toBeUndefined()
    expect(await run("update_bucket", { bucket: "avatars", fileSizeLimit: null })).toMatchObject({ ok: true })
    expect((await run("buckets")).buckets[0].fileSizeLimit).toBeUndefined()
    fake.state.bucketFiles.avatars = 3
    expect(await run("delete_bucket", { bucket: "avatars" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("still has files"),
    })
    expect(await run("delete_bucket", { bucket: "avatars", empty: true })).toMatchObject({ ok: true, emptied: true })
    expect(fake.state.buckets).toEqual([])
    expect(await run("create_bucket", { bucket: "Bad Name" })).toMatchObject({ ok: false })
  })
})

describe("edge functions", () => {
  test("deploys a function folder with its shared code and config, lists and deletes it", async () => {
    connect()
    linkDatabase()
    await mkdir(join(project, "supabase", "functions", "hello"), { recursive: true })
    await mkdir(join(project, "supabase", "functions", "_shared"), { recursive: true })
    await writeFile(join(project, "supabase", "functions", "hello", "index.ts"), 'import "../_shared/cors.ts"')
    await writeFile(join(project, "supabase", "functions", "hello", "deno.json"), "{}")
    await writeFile(join(project, "supabase", "functions", "_shared", "cors.ts"), "export {}")
    await writeFile(join(project, "supabase", "config.toml"), "[functions.hello]\nverify_jwt = false\n")
    const deployed = await run("deploy_function", { functionName: "hello" })
    expect(deployed).toMatchObject({
      ok: true,
      function: { slug: "hello", version: 1, status: "ACTIVE" },
      files: 3,
      verifyJwt: false,
      url: "https://fixtureref.supabase.co/functions/v1/hello",
    })
    const upload = fake.calls.find((call) => call.path === "/v1/projects/fixtureref/functions/deploy")
    expect(upload?.query).toEqual({ slug: "hello" })
    expect(upload?.body).toEqual({
      name: "hello",
      entrypoint_path: "supabase/functions/hello/index.ts",
      import_map_path: "supabase/functions/hello/deno.json",
      verify_jwt: false,
    })
    expect(upload?.files?.map((file) => file.name).toSorted()).toEqual([
      "supabase/functions/_shared/cors.ts",
      "supabase/functions/hello/deno.json",
      "supabase/functions/hello/index.ts",
    ])
    expect(await run("functions")).toMatchObject({ ok: true, deployed: [{ slug: "hello" }], local: ["hello"] })
    expect(await run("delete_function", { functionName: "hello" })).toMatchObject({ ok: true, deleted: "hello" })
    expect(await run("deploy_function", { functionName: "missing" })).toMatchObject({ ok: false })
  })

  test("manages function secrets by name; the agent's values come only from the stored environment", async () => {
    connect()
    linkDatabase()
    fake.state.secrets.push({ name: "EXISTING", value: "fixture-existing-value" })
    const listed = await run("function_secrets")
    expect(listed).toMatchObject({
      ok: true,
      secrets: [
        { name: "SUPABASE_URL", reserved: true },
        { name: "EXISTING", reserved: false },
      ],
    })
    expectNoSecrets(listed, "fixture-existing-value", "digest")

    expect(
      await run("set_function_secrets", { secrets: [{ name: "RESEND_KEY", value: "fixture-resend" }] }),
    ).toMatchObject({
      ok: true,
      set: ["RESEND_KEY"],
    })
    expect(await run("set_function_secrets", { secrets: [{ name: "SUPABASE_X", value: "x" }] })).toMatchObject({
      ok: false,
    })
    expect(
      await run("set_function_secrets", { secrets: [{ name: "FROM_CHAT", value: "fixture-chat-value" }] }, "agent"),
    ).toMatchObject({ ok: false, error: expect.stringContaining("never through chat") })

    setEnv(project, undefined, "STRIPE_SECRET_KEY", "fixture-stripe-value")
    const fromEnv = await run("set_function_secrets", { secretNames: ["STRIPE_SECRET_KEY"] }, "agent")
    expect(fromEnv).toMatchObject({ ok: true, set: ["STRIPE_SECRET_KEY"] })
    expectNoSecrets(fromEnv, "fixture-stripe-value")
    expect(fake.state.secrets).toContainEqual({ name: "STRIPE_SECRET_KEY", value: "fixture-stripe-value" })

    expect(await run("delete_function_secrets", { secretNames: ["RESEND_KEY", "STRIPE_SECRET_KEY"] })).toMatchObject({
      ok: true,
    })
    expect(fake.state.secrets.map((item) => item.name)).toEqual(["SUPABASE_URL", "EXISTING"])
  })
})

describe("logs", () => {
  test("reads one service's logs from the logs endpoint, oldest first and redacted", async () => {
    connect()
    linkDatabase()
    fake.state.logs = [
      { timestamp: 1_760_000_060_000_000, event_message: "POST /rest/v1/orders 500", source: "edge_logs" },
      { timestamp: 1_760_000_000_000_000, event_message: `GET /auth Bearer ${SERVICE_KEY}`, source: "edge_logs" },
      { timestamp: 1_760_000_030_000_000, event_message: "statement timeout", source: "postgres_logs" },
    ]
    const report = await run("supabase_logs", { service: "api", minutes: 5000, search: "it's" })
    expect(report).toMatchObject({
      ok: true,
      service: "api",
      entries: [
        { at: "2025-10-09T08:53:20.000Z", message: expect.stringContaining("GET /auth") },
        { at: "2025-10-09T08:54:20.000Z", message: "POST /rest/v1/orders 500" },
      ],
    })
    const call = fake.calls.find((item) => item.path === "/v1/projects/fixtureref/analytics/endpoints/logs")
    expect(call?.query.sql).toBe(
      "select timestamp, event_message from logs where source in ('edge_logs') and event_message ilike '%it\\'s%' order by timestamp desc limit 100",
    )
    // The window is capped at the endpoint's 24 hours.
    expect(Date.parse(call?.query.iso_timestamp_end ?? "") - Date.parse(call?.query.iso_timestamp_start ?? "")).toBe(
      24 * 60 * 60_000,
    )
    expectNoSecrets(report)
    expect(await run("supabase_logs", { service: "functions" })).toMatchObject({ ok: true })
    expect(fake.calls.at(-1)?.query.sql).toContain("where source in ('function_edge_logs', 'function_logs')")
    expect(await run("supabase_logs", { service: "realtime" })).toMatchObject({ ok: false })
  })

  // Bun honours only the first TZ a process sets, so this cannot move the zone
  // without breaking later files; outside UTC, reading the text as local time
  // shifts the first entry.
  test("a timestamp that arrives as text without a zone is UTC, wherever Vector runs", async () => {
    connect()
    linkDatabase()
    fake.state.logs = [
      { timestamp: "2026-10-10 09:30:00.000000", event_message: "login failed", source: "auth_logs" },
      { timestamp: "2026-10-10T09:31:00+02:00", event_message: "login ok", source: "auth_logs" },
    ]
    expect((await run("supabase_logs", { service: "auth" })).entries).toEqual([
      { at: "2026-10-10T07:31:00.000Z", message: "login ok" },
      { at: "2026-10-10T09:30:00.000Z", message: "login failed" },
    ])
  })
})

describe("security check", () => {
  test("fails on advisor errors and on server credentials in public env or the built bundle", async () => {
    connect()
    linkDatabase()
    fake.state.lints = [
      {
        name: "rls_disabled_in_public",
        title: "RLS Disabled in Public",
        level: "ERROR",
        detail: "Table public.orders is public, but RLS has not been enabled.",
        metadata: { schema: "public", name: "orders", type: "table" },
      },
      { name: "function_search_path_mutable", title: "Function Search Path Mutable", level: "WARN", metadata: {} },
    ]
    setEnv(project, undefined, "VITE_SUPABASE_SERVICE", SERVICE_KEY, "public")
    await mkdir(join(project, "dist", "assets"), { recursive: true })
    await writeFile(join(project, "dist", "assets", "index.js"), `const k = "${SERVICE_KEY}"`)
    const report = await run("security_check")
    expect(report.security).toMatchObject({
      status: "failed",
      errors: 3,
      warnings: 1,
      advisors: [
        { name: "rls_disabled_in_public", level: "ERROR", entity: "public.orders" },
        { name: "function_search_path_mutable", level: "WARN" },
      ],
      environment: [
        { where: "VITE_SUPABASE_SERVICE", reason: "is public but holds this project's service key", level: "ERROR" },
      ],
      bundle: [{ where: "assets/index.js", reason: "ships this project's service key", level: "ERROR" }],
    })
    expectNoSecrets(report)
  })

  test("passes a clean project and skips one with no Supabase project", async () => {
    connect()
    expect((await run("security_check")).security).toMatchObject({ status: "skipped" })
    linkDatabase()
    expect((await run("security_check")).security).toMatchObject({ status: "passed", errors: 0 })
  })

  test("advisors that could not run say what to do, and a connection without access to them does not block", async () => {
    connect()
    linkDatabase()
    // An OAuth connection made before Vector asked for advisor access.
    fake.state.fail = (call) =>
      call.path.endsWith("/advisors/security")
        ? Response.json({ message: "Forbidden resource" }, { status: 403 })
        : undefined
    const forbidden = (await run("security_check")).security
    expect(forbidden).toMatchObject({ status: "skipped", nextStep: expect.stringContaining("Reconnect Supabase") })
    expect(forbidden.detail).toContain("not allowed to read them")

    fake.state.fail = (call) =>
      call.path.endsWith("/advisors/security") ? Response.json({ message: "Unauthorized" }, { status: 401 }) : undefined
    expect((await run("security_check")).security).toMatchObject({
      status: "failed",
      nextStep: expect.stringContaining("make Secret scan optional under Cloud Services > Build & runtime"),
    })

    // The release check carries the next step, which is what a refused
    // production publish shows.
    fake.state.fail = (call) =>
      call.path.endsWith("/advisors/security")
        ? Response.json({ message: "upstream timeout" }, { status: 504 })
        : undefined
    expect(
      await supabaseReleaseCheck({ projectPath: project, required: true }, { request: fake.request }),
    ).toMatchObject({
      status: "failed",
      details:
        "Supabase's security advisors could not run: upstream timeout Run the check again in a moment. To release without it meanwhile, make Secret scan optional under Cloud Services > Build & runtime > Required release checks.",
    })
  })
})

describe("agent bridge", () => {
  async function bridgeCommand(input: Record<string, unknown>) {
    const bridge = await startCloudBridge({ request: fake.request })
    const response = await fetch(`${bridge.url}/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectPath: project, ...input }),
    })
    return (await response.json()) as Report
  }

  test("describes changes for the permission prompt, with destructive ones never always-allowed", async () => {
    connect()
    linkDatabase()
    // Every query asks, and the prompt shows it.
    expect(
      await bridgeCommand({ command: "describe", action: "run_sql", sql: "select token from auth.refresh_tokens" }),
    ).toEqual({
      ok: true,
      repeatable: false,
      scope: {
        provider: "Supabase",
        project: "shop-db",
        environment: "production",
        summary:
          "Run a read-only SQL query against shop-db; the rows come back to the agent. It uses the auth schema, where Supabase keeps users' sign-in data and secrets.",
      },
      statements: [
        { label: "Read-only SQL", sql: "select token from auth.refresh_tokens", length: 37, truncated: false },
      ],
    })
    const long = `update profiles set bio = '${"x".repeat(5_000)}'`
    expect(
      (await bridgeCommand({ command: "describe", action: "run_sql", sql: long, write: true })).statements,
    ).toEqual([{ label: "SQL that can change data", sql: long.slice(0, 4_000), length: long.length, truncated: true }])

    setEnv(project, undefined, "STRIPE_SECRET_KEY", "fixture-stripe-value")
    await mkdir(join(project, "supabase", "functions", "open"), { recursive: true })
    await writeFile(join(project, "supabase", "config.toml"), "[functions.open]\nverify_jwt = false\n")
    for (const [action, extra] of [
      ["delete_bucket", { bucket: "avatars" }],
      ["pause_database", {}],
      ["rotate_database_password", {}],
      ["write_database_url", {}],
      ["set_function_secrets", { secretNames: ["STRIPE_SECRET_KEY"] }],
      ["deploy_function", { functionName: "open" }],
    ] as const) {
      expect(await bridgeCommand({ command: "describe", action, ...extra })).toMatchObject({
        ok: true,
        repeatable: false,
      })
    }
    expect(
      (await bridgeCommand({ command: "describe", action: "deploy_function", functionName: "open" })).scope.summary,
    ).toContain("verify_jwt = false for it, so anyone on the internet can call it")
    expect(
      await bridgeCommand({ command: "describe", action: "deploy_function", functionName: "hello" }),
    ).toMatchObject({
      repeatable: true,
    })
    expect(
      (
        await bridgeCommand({
          command: "describe",
          action: "update_bucket",
          bucket: "avatars",
          fileSizeLimit: 5 * 1024 * 1024,
          allowedMimeTypes: ["image/*"],
        })
      ).scope.summary,
    ).toBe("Change the storage bucket avatars in shop-db: file size limit 5 MB; only image/* files.")
    expect(
      (await bridgeCommand({ command: "describe", action: "link_database", projectRef: "otherref" })).scope.summary,
    ).toContain("This replaces the link to shop-db.")
    expect(
      await bridgeCommand({ command: "describe", action: "set_function_secrets", secretNames: ["NOPE"] }),
    ).toMatchObject({
      ok: false,
      needsSetup: true,
      error: "NOPE is not in this project's environment.",
    })
    expect(fake.calls).toEqual([])

    // A user is named by the address the user would recognise.
    fake.state.users = [{ id: "00000000-0000-0000-0000-000000000001", email: "ada@example.com" }]
    expect(
      await bridgeCommand({
        command: "describe",
        action: "delete_user",
        userId: "00000000-0000-0000-0000-000000000001",
      }),
    ).toMatchObject({
      repeatable: false,
      scope: {
        summary:
          "Delete the user ada@example.com (00000000-0000-0000-0000-000000000001) from shop-db. This cannot be undone.",
      },
    })
  })

  test("runs Supabase commands as the agent, with the agent's limits", async () => {
    connect()
    linkDatabase()
    fake.state.logs = [{ timestamp: 1_760_000_000_000_000, event_message: "auth ok", source: "auth_logs" }]
    expect(await bridgeCommand({ command: "supabase_logs", service: "auth" })).toMatchObject({
      ok: true,
      entries: [{ message: "auth ok" }],
    })
    expect(
      await bridgeCommand({ command: "update_auth", providers: { google: { enabled: true, secret: "chat-secret" } } }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("never through chat") })
    // DATABASE_URL from the agent: its approved permission prompt is the consent.
    expect(await bridgeCommand({ command: "write_database_url" })).toMatchObject({
      ok: false,
      needsSetup: true,
      nextStep: expect.stringContaining("enter the current database password"),
    })
  })

  test("lists storage and Edge Functions for the agent through the shared commands", async () => {
    connect()
    linkDatabase()
    fake.state.buckets = [{ id: "avatars", name: "avatars", public: false, file_size_limit: 1024 }]
    fake.state.functions = [{ id: "fn-1", slug: "hello", name: "hello", status: "ACTIVE", version: 3 }]
    await mkdir(join(project, "supabase", "functions", "digest"), { recursive: true })
    await writeFile(join(project, "supabase", "functions", "digest", "index.ts"), "Deno.serve(() => new Response())")
    const report = await bridgeCommand({ command: "supabase_services" })
    expect(report).toMatchObject({
      ok: true,
      services: {
        project: { ref: "fixtureref", name: "shop-db" },
        storage: { available: true, buckets: [{ id: "avatars", public: false, fileSizeLimit: 1024 }] },
        functions: { available: true, deployed: [{ slug: "hello", version: 3 }], local: ["digest"] },
      },
    })
    expectNoSecrets(report)

    // One half failing leaves the other.
    fake.state.fail = (call) =>
      call.path === "/storage/v1/bucket"
        ? Response.json({ message: "storage unavailable" }, { status: 503 })
        : undefined
    expect(await bridgeCommand({ command: "supabase_services" })).toMatchObject({
      ok: true,
      services: {
        storage: { available: false, error: "storage unavailable" },
        functions: { available: true, deployed: [{ slug: "hello" }] },
      },
    })
  })
})
