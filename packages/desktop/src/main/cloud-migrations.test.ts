import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// cloud-migrations reads the connection record through ./store and cloud-console
// reaches electron for the user data path, so both are mocked before importing.
const userDataPath = "/tmp/vector-cloud-migrations-test"
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

const { applyCloudMigrations, applyMigrationFiles, discoverMigrations, planMigrations, supabaseSqlRunner } =
  await import("./cloud-migrations")
const { cloudProjectScopeKey } = await import("./cloud-console")
const { encryptCloudCredential } = await import("./cloud-credential-vault")

let project = ""

async function writeMigrations(directory: string, files: Record<string, string>) {
  await mkdir(join(project, directory), { recursive: true })
  for (const [name, sql] of Object.entries(files)) await writeFile(join(project, directory, name), sql, "utf8")
}

function seed(name: string, key: string, value: unknown) {
  if (!store.has(name)) store.set(name, new Map())
  store.get(name)!.set(key, value)
}

function seedSupabase() {
  seed("cloud-projects", cloudProjectScopeKey(project), {
    env: [],
    database: {
      provider: "supabase",
      url: "https://abcdefghijkl.supabase.co",
      anonKey: "anon-key",
      projectRef: "abcdefghijkl",
      connectedAt: "2026-09-01T09:00:00.000Z",
    },
    domains: [],
    build: null,
  })
  seed("cloud-provider-connections", "records", [
    {
      provider: "supabase",
      accessToken: encryptCloudCredential("sbp_management_token"),
      connectedAt: "2026-09-01T09:00:00.000Z",
    },
  ])
}

// A fake Management API: remembers every statement and answers the tracking
// query from the names it has been told are already applied.
function fakeRunner(applied: string[] = [], failOn?: string) {
  const statements: string[] = []
  const runner = async (sql: string) => {
    statements.push(sql)
    if (failOn && sql.includes(failOn)) throw new Error(`syntax error at or near "${failOn}"`)
    if (sql.startsWith("select name from public.vector_migrations")) return applied.map((name) => ({ name }))
    return []
  }
  return { runner, statements }
}

beforeEach(async () => {
  store.clear()
  process.env.VECTOR_CREDENTIAL_KEY = Buffer.alloc(32, 5).toString("base64")
  project = await mkdtemp(join(tmpdir(), "vector-migrations-"))
})

afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})

describe("migration discovery", () => {
  test("prefers supabase/migrations and orders files by filename", async () => {
    await writeMigrations("db/migrations", { "0001_other.sql": "select 1;" })
    await writeMigrations("supabase/migrations", {
      "0002_add_likes.sql": "alter table posts add column likes int;",
      "0001_init.sql": "create table posts (id uuid primary key);",
      "readme.md": "not a migration",
    })

    const discovery = await discoverMigrations(project)
    expect(discovery.directory).toBe("supabase/migrations")
    expect(discovery.files.map((file) => file.name)).toEqual(["0001_init.sql", "0002_add_likes.sql"])
    expect(discovery.files[0].path).toBe(join(project, "supabase/migrations", "0001_init.sql"))
  })

  test("reports .sql files whose names cannot be tracked safely", async () => {
    await writeMigrations("db/migrations", { "0001 with space.sql": "select 1;", "0002_ok.sql": "select 2;" })
    const discovery = await discoverMigrations(project)
    expect(discovery.directory).toBe("db/migrations")
    expect(discovery.files.map((file) => file.name)).toEqual(["0002_ok.sql"])
    expect(discovery.skipped).toEqual(["0001 with space.sql"])
  })

  test("returns no directory when the project has none of the conventional locations", async () => {
    expect(await discoverMigrations(project)).toEqual({ files: [], skipped: [] })
  })
})

describe("migration planning", () => {
  test("splits discovered files into applied and pending, keeping file order", () => {
    const files = ["a.sql", "b.sql", "c.sql"].map((name) => ({ name, path: `/tmp/${name}` }))
    const plan = planMigrations(files, ["b.sql", "a.sql"])
    expect(plan.alreadyApplied).toEqual(["a.sql", "b.sql"])
    expect(plan.pending.map((file) => file.name)).toEqual(["c.sql"])
  })
})

describe("applyMigrationFiles", () => {
  test("a dry run reads the tracking table and writes nothing", async () => {
    await writeMigrations("supabase/migrations", { "0001_init.sql": "create table posts ();", "0002_likes.sql": "x" })
    const discovery = await discoverMigrations(project)
    const { runner, statements } = fakeRunner(["0001_init.sql"])

    const outcome = await applyMigrationFiles({ discovery, runner, dryRun: true })
    expect(outcome).toMatchObject({
      dryRun: true,
      directory: "supabase/migrations",
      alreadyApplied: ["0001_init.sql"],
      pending: ["0002_likes.sql"],
      applied: [],
    })
    expect(statements).toEqual(["select name from public.vector_migrations order by name;"])
  })

  test("a dry run survives a database that has never run a migration", async () => {
    await writeMigrations("supabase/migrations", { "0001_init.sql": "create table posts ();" })
    const discovery = await discoverMigrations(project)
    const outcome = await applyMigrationFiles({
      discovery,
      dryRun: true,
      runner: async () => {
        throw new Error('relation "public.vector_migrations" does not exist')
      },
    })
    expect(outcome.pending).toEqual(["0001_init.sql"])
    expect(outcome.alreadyApplied).toEqual([])
  })

  test("applies only the pending files, in order, and records each one", async () => {
    await writeMigrations("supabase/migrations", {
      "0001_init.sql": "create table posts (id uuid primary key);",
      "0002_likes.sql": "alter table posts add column likes int;",
    })
    const discovery = await discoverMigrations(project)
    const { runner, statements } = fakeRunner(["0001_init.sql"])

    const outcome = await applyMigrationFiles({ discovery, runner, dryRun: false })
    expect(outcome.applied).toEqual(["0002_likes.sql"])
    expect(outcome.alreadyApplied).toEqual(["0001_init.sql"])
    expect(outcome.pending).toEqual([])
    expect(outcome.failed).toBeUndefined()
    expect(statements[0]).toContain("create table if not exists public.vector_migrations")
    expect(statements).toContain("alter table posts add column likes int;")
    expect(statements).toContain(
      "insert into public.vector_migrations (name) values ('0002_likes.sql') on conflict do nothing;",
    )
    expect(statements).not.toContain("create table posts (id uuid primary key);")
  })

  test("stops at the first failure and says what did and did not run", async () => {
    await writeMigrations("supabase/migrations", {
      "0001_init.sql": "create table posts (id uuid primary key);",
      "0002_broken.sql": "alter tabel posts add column likes int;",
      "0003_later.sql": "create index on posts (likes);",
    })
    const discovery = await discoverMigrations(project)
    const { runner, statements } = fakeRunner([], "tabel")

    const outcome = await applyMigrationFiles({
      discovery,
      runner,
      dryRun: false,
      redact: (value) => value.replace("tabel", "[redacted]"),
    })
    expect(outcome.applied).toEqual(["0001_init.sql"])
    expect(outcome.failed?.name).toBe("0002_broken.sql")
    expect(outcome.failed?.error).toContain("[redacted]")
    expect(outcome.pending).toEqual(["0003_later.sql"])
    expect(statements).not.toContain("create index on posts (likes);")
  })
})

describe("applyCloudMigrations", () => {
  test("asks for a migrations directory instead of throwing", async () => {
    const report = await applyCloudMigrations({ projectPath: project }, async () => {
      throw new Error("no network call expected")
    })
    expect(report).toMatchObject({ ok: false, needsSetup: true })
    expect(report.nextStep).toContain("supabase/migrations")
  })

  test("asks for a Supabase project when the directory exists but nothing is connected", async () => {
    await writeMigrations("supabase/migrations", { "0001_init.sql": "select 1;" })
    const report = await applyCloudMigrations({ projectPath: project }, async () => {
      throw new Error("no network call expected")
    })
    expect(report).toMatchObject({ ok: false, needsSetup: true })
    expect(report.nextStep).toContain("Vector Cloud > Database")
  })

  test("applies pending files through the Supabase management SQL endpoint", async () => {
    await writeMigrations("supabase/migrations", { "0001_init.sql": "create table posts (id uuid primary key);" })
    seedSupabase()

    const queries: string[] = []
    const urls: string[] = []
    const report = await applyCloudMigrations({ projectPath: project }, async (input, init) => {
      urls.push(String(input))
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sbp_management_token")
      queries.push(String(JSON.parse(String(init?.body)).query))
      return Response.json([])
    })

    expect(new Set(urls)).toEqual(new Set(["https://api.supabase.com/v1/projects/abcdefghijkl/database/query"]))
    expect(report.ok).toBe(true)
    expect(report.migrations?.applied).toEqual(["0001_init.sql"])
    expect(report.migrations?.projectRef).toBe("abcdefghijkl")
    expect(queries).toContain("create table posts (id uuid primary key);")
    expect(JSON.stringify(report)).not.toContain("sbp_management_token")
  })

  test("keeps the partial result when Postgres rejects a migration", async () => {
    await writeMigrations("supabase/migrations", { "0001_broken.sql": "alter tabel posts;" })
    seedSupabase()

    const report = await applyCloudMigrations({ projectPath: project }, async (_input, init) => {
      const query = String(JSON.parse(String(init?.body)).query)
      if (query.includes("tabel")) return Response.json({ message: 'syntax error at or near "tabel"' }, { status: 400 })
      return Response.json([])
    })

    expect(report.ok).toBe(true)
    expect(report.migrations?.applied).toEqual([])
    expect(report.migrations?.failed?.name).toBe("0001_broken.sql")
    expect(report.error).toContain("0001_broken.sql failed")
  })
})

describe("supabaseSqlRunner", () => {
  test("posts the statement and surfaces the database error message", async () => {
    const runner = supabaseSqlRunner("abcdefghijkl", "token", async () =>
      Response.json({ message: "permission denied for schema public" }, { status: 403 }),
    )
    await expect(runner("select 1;")).rejects.toThrow("permission denied for schema public")
  })
})
