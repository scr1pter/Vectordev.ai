import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { getDatabase, redactCloudLog } from "./cloud-console"
import { getSupabaseServiceSnapshot } from "./cloud-connections"
import { decryptCloudCredential } from "./cloud-credential-vault"
import { getStore } from "./store"

// Schema belongs in the repository, not in a dashboard the agent cannot reach:
// "add likes to posts" should be a migration file plus this action, not a trip
// to the Supabase SQL editor. Applied migrations are tracked inside the target
// database itself, so a second run is a no-op no matter which machine, branch
// or agent session it comes from.

type CloudFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type SupabaseSqlRunner = (sql: string) => Promise<unknown>

export type MigrationFile = { name: string; path: string }

export type MigrationDiscovery = {
  directory?: string
  files: MigrationFile[]
  skipped: string[]
}

export type MigrationOutcome = {
  dryRun: boolean
  directory?: string
  projectRef?: string
  discovered: string[]
  skipped: string[]
  alreadyApplied: string[]
  pending: string[]
  applied: string[]
  failed?: { name: string; error: string }
}

export type CloudMigrationsInput = {
  projectPath: string
  taskId?: string
  dryRun?: boolean
}

export type CloudMigrationReport = {
  ok: boolean
  needsSetup?: boolean
  error?: string
  nextStep?: string
  migrations?: MigrationOutcome
}

// Ordered by how strong a signal each location is: a Supabase project says what
// it is, a bare `migrations/` at the repo root could belong to any tool.
export const MIGRATION_DIRECTORIES = ["supabase/migrations", "db/migrations", "database/migrations", "migrations"]

const TRACKING_TABLE = "public.vector_migrations"
const CREATE_TRACKING_TABLE = `create table if not exists ${TRACKING_TABLE} (
  name text primary key,
  applied_at timestamptz not null default now()
);`
const SELECT_APPLIED = `select name from ${TRACKING_TABLE} order by name;`
const MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/
const MAX_MIGRATION_CHARS = 1_000_000
const CONNECTION_STORE = "cloud-provider-connections"
const CONNECTION_KEY = "records"

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function discoverMigrations(projectPath: string): Promise<MigrationDiscovery> {
  for (const relative of MIGRATION_DIRECTORIES) {
    const directory = join(projectPath, relative)
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
    if (!entries) continue
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
      .map((entry) => entry.name)
      // Plain code-unit order, the same order the Supabase CLI applies them in:
      // timestamp-prefixed filenames sort into the order they were written.
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    return {
      directory: relative,
      // A filename ends up inside the tracking INSERT, so anything outside the
      // conventional character set is reported rather than quoted and hoped for.
      files: names.filter((name) => MIGRATION_NAME.test(name)).map((name) => ({ name, path: join(directory, name) })),
      skipped: names.filter((name) => !MIGRATION_NAME.test(name)),
    }
  }
  return { files: [], skipped: [] }
}

export function planMigrations(
  files: MigrationFile[],
  applied: readonly string[],
): { pending: MigrationFile[]; alreadyApplied: string[] } {
  const done = new Set(applied)
  return {
    pending: files.filter((file) => !done.has(file.name)),
    alreadyApplied: files.filter((file) => done.has(file.name)).map((file) => file.name),
  }
}

function appliedNames(result: unknown): string[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray(Reflect.get(result, "result"))
      ? (Reflect.get(result, "result") as unknown[])
      : []
  return rows
    .map((row) => (typeof row === "string" ? row : stringField(row, "name")))
    .filter((name): name is string => Boolean(name))
}

function quoted(value: string): string {
  return `'${value.split("'").join("''")}'`
}

export async function applyMigrationFiles(input: {
  discovery: MigrationDiscovery
  runner: SupabaseSqlRunner
  dryRun: boolean
  redact?: (value: string) => string
}): Promise<MigrationOutcome> {
  const redact = input.redact ?? ((value: string) => value)
  const outcome: MigrationOutcome = {
    dryRun: input.dryRun,
    directory: input.discovery.directory,
    discovered: input.discovery.files.map((file) => file.name),
    skipped: input.discovery.skipped,
    alreadyApplied: [],
    pending: [],
    applied: [],
  }

  // A plan must not write, so the tracking table is only read here. A database
  // that has never run a migration has no table yet, and that is not an error.
  const applied = input.dryRun
    ? await input.runner(SELECT_APPLIED).then(appliedNames, () => [])
    : await input.runner(CREATE_TRACKING_TABLE).then(() => input.runner(SELECT_APPLIED).then(appliedNames))

  const plan = planMigrations(input.discovery.files, applied)
  outcome.alreadyApplied = plan.alreadyApplied
  outcome.pending = plan.pending.map((file) => file.name)
  if (input.dryRun) return outcome

  for (const file of plan.pending) {
    try {
      const sql = await readFile(file.path, "utf8")
      if (sql.length > MAX_MIGRATION_CHARS) {
        throw new Error(`${file.name} is larger than ${MAX_MIGRATION_CHARS} characters; split it into smaller files.`)
      }
      if (sql.trim()) await input.runner(sql)
      await input.runner(`insert into ${TRACKING_TABLE} (name) values (${quoted(file.name)}) on conflict do nothing;`)
      outcome.applied.push(file.name)
    } catch (error) {
      // Stop on the first failure: later migrations were written against the
      // schema this one was supposed to produce, so running them would compound
      // the damage instead of surfacing one fixable error.
      outcome.failed = { name: file.name, error: redact(errorMessage(error)) }
      break
    }
  }
  outcome.pending = plan.pending
    .map((file) => file.name)
    .filter((name) => !outcome.applied.includes(name) && name !== outcome.failed?.name)
  return outcome
}

export function supabaseSqlRunner(projectRef: string, token: string, request: CloudFetch = fetch): SupabaseSqlRunner {
  const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`
  return async (sql: string) => {
    const response = await request(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "Vector-Desktop/1",
      },
      body: JSON.stringify({ query: sql }),
      // Schema changes take locks and rebuild indexes; the 20s used for reads
      // elsewhere would abandon a migration that is still succeeding.
      signal: AbortSignal.timeout(60_000),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (response.ok) return body
    throw new Error(
      stringField(body, "message") ??
        stringField(body, "error") ??
        stringField(body, "error_description") ??
        `Supabase returned HTTP ${response.status}.`,
    )
  }
}

// cloud-connections keeps its token accessor module-private, so the management
// token is read back from the record it writes, through the same vault. It is
// used for one request and never logged, stored or returned.
async function supabaseManagementToken(projectPath: string, taskId: string | undefined): Promise<string | undefined> {
  const record = () => {
    const raw = getStore(CONNECTION_STORE).get(CONNECTION_KEY)
    if (!Array.isArray(raw)) return undefined
    return raw.find((item) => item && typeof item === "object" && Reflect.get(item, "provider") === "supabase")
  }
  const current = record()
  if (!current) return undefined
  const expiresAt = stringField(current, "expiresAt")
  // An OAuth token that is about to expire is refreshed by cloud-connections
  // itself; asking it for the service snapshot is the exported way to make that
  // happen before a long migration run starts.
  const stale = expiresAt ? Date.parse(expiresAt) <= Date.now() + 60_000 : false
  const refreshed = stale ? await getSupabaseServiceSnapshot(projectPath, taskId).then(record, () => current) : current
  const accessToken = stringField(refreshed, "accessToken")
  return accessToken ? decryptCloudCredential(accessToken) : undefined
}

export async function applyCloudMigrations(
  input: CloudMigrationsInput,
  request: CloudFetch = fetch,
): Promise<CloudMigrationReport> {
  const dryRun = input.dryRun === true
  const discovery = await discoverMigrations(input.projectPath)
  if (!discovery.directory) {
    return {
      ok: false,
      needsSetup: true,
      error: `This project has no migrations directory (looked for ${MIGRATION_DIRECTORIES.join(", ")}).`,
      nextStep: "Write the schema to supabase/migrations/<timestamp>_<name>.sql first, then apply it.",
    }
  }
  const database = getDatabase(input.projectPath, input.taskId)
  if (!database?.projectRef) {
    return {
      ok: false,
      needsSetup: true,
      error: "No Supabase project is connected to this project.",
      nextStep: "Ask the user to open Vector Cloud > Database and connect a Supabase project.",
    }
  }
  const token = await supabaseManagementToken(input.projectPath, input.taskId).catch(() => undefined)
  if (!token) {
    return {
      ok: false,
      needsSetup: true,
      error: "Supabase is not connected on this machine.",
      nextStep: "Ask the user to connect Supabase in Vector Cloud > Connections, then run this action again.",
    }
  }
  if (!discovery.files.length) {
    return {
      ok: true,
      nextStep: `No .sql files in ${discovery.directory}. Write one there before applying migrations.`,
      migrations: {
        dryRun,
        directory: discovery.directory,
        projectRef: database.projectRef,
        discovered: [],
        skipped: discovery.skipped,
        alreadyApplied: [],
        pending: [],
        applied: [],
      },
    }
  }

  const outcome = await applyMigrationFiles({
    discovery,
    dryRun,
    runner: supabaseSqlRunner(database.projectRef, token, request),
    redact: (value) => redactCloudLog(input.projectPath, input.taskId, value),
  })
  return {
    // A migration that Postgres rejected is a result, not a transport failure:
    // the agent has to see which files did apply before it rewrites the one that
    // did not, and the bridge turns a non-ok report into a thrown error.
    ok: true,
    error: outcome.failed ? `${outcome.failed.name} failed: ${outcome.failed.error}` : undefined,
    migrations: { ...outcome, projectRef: database.projectRef },
  }
}
