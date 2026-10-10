import { VECTOR_USER_AGENT } from "./user-agent"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { getDatabase, redactCloudLog } from "./cloud-console"
import { getSupabaseManagementToken } from "./cloud-connections"

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

export type AppliedMigrations = {
  /** Rows in Vector's own tracking table; a row moved from an older release has no checksum. */
  tracked: { name: string; checksum?: string }[]
  /** Versions the Supabase CLI recorded in supabase_migrations.schema_migrations. */
  versions: string[]
}

export type MigrationOutcome = {
  dryRun: boolean
  directory?: string
  projectRef?: string
  discovered: string[]
  skipped: string[]
  alreadyApplied: string[]
  appliedByCli: string[]
  changed: string[]
  pending: string[]
  applied: string[]
  failed?: { name: string; error: string }
}

export type CloudMigrationsInput = {
  projectPath: string
  taskId?: string
  /** Where the migration files are read from; defaults to projectPath. */
  directory?: string
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

const TRACKING_TABLE = "vector.schema_migrations"
// Vector's tracking lives in its own schema, outside what Supabase's Data API
// exposes (public by default), with row level security on and no policies, and
// the anon and authenticated roles get no access to it. Older releases kept it
// in public.vector_migrations, where those roles could read and rewrite which
// migrations count as applied; its rows move here and that table is dropped.
// Sent as one query, so it is a single implicit transaction.
const SETUP_TRACKING = `create schema if not exists vector;
create table if not exists ${TRACKING_TABLE} (
  name text primary key,
  checksum text,
  applied_at timestamptz not null default now()
);
alter table ${TRACKING_TABLE} enable row level security;
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on schema vector from %I', role_name);
      execute format('revoke all on all tables in schema vector from %I', role_name);
    end if;
  end loop;
  if to_regclass('public.vector_migrations') is not null then
    insert into ${TRACKING_TABLE} (name, applied_at)
      select name, applied_at from public.vector_migrations
      on conflict (name) do nothing;
    drop table public.vector_migrations;
  end if;
end
$$;`
// Read-only: which history tables exist. A dry run must not create anything.
const DETECT_TRACKING = `select
  to_regclass('${TRACKING_TABLE}') is not null as tracked,
  to_regclass('public.vector_migrations') is not null as legacy,
  to_regclass('supabase_migrations.schema_migrations') is not null as cli;`
const SELECT_TRACKED = `select name, checksum from ${TRACKING_TABLE} order by name;`
const SELECT_LEGACY = "select name from public.vector_migrations order by name;"
// The Supabase CLI records `supabase db push` runs by version, the timestamp
// prefix of the filename: https://supabase.com/docs/reference/cli/supabase-migration-repair
const SELECT_CLI_VERSIONS = "select version from supabase_migrations.schema_migrations;"
const MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/
const MAX_MIGRATION_CHARS = 1_000_000

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

export function planMigrations<File extends MigrationFile & { checksum: string }>(
  files: File[],
  applied: AppliedMigrations,
) {
  const tracked = new Map(applied.tracked.map((row) => [row.name, row.checksum]))
  const versions = new Set(applied.versions)
  const byCli = (file: MigrationFile) => !tracked.has(file.name) && versions.has(file.name.match(/^(\d+)_/)?.[1] ?? "")
  const done = (file: MigrationFile) => tracked.has(file.name) || byCli(file)
  return {
    pending: files.filter((file) => !done(file)),
    alreadyApplied: files.filter(done).map((file) => file.name),
    appliedByCli: files.filter(byCli).map((file) => file.name),
    // A recorded checksum that no longer matches means an applied file was
    // edited; running the rest on top of it would hide that drift.
    changed: files
      .filter((file) => tracked.get(file.name) !== undefined && tracked.get(file.name) !== file.checksum)
      .map((file) => file.name),
    // Rows moved from an older release carry no checksum yet.
    unverified: files.filter((file) => tracked.has(file.name) && tracked.get(file.name) === undefined),
  }
}

function rows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (!result || typeof result !== "object") return []
  const nested = Reflect.get(result, "result")
  return Array.isArray(nested) ? nested : []
}

function quoted(value: string): string {
  return `'${value.split("'").join("''")}'`
}

async function readApplied(runner: SupabaseSqlRunner, dryRun: boolean): Promise<AppliedMigrations> {
  if (!dryRun) await runner(SETUP_TRACKING)
  const exists = rows(await runner(DETECT_TRACKING))[0]
  const has = (key: string) => Boolean(exists && typeof exists === "object" && Reflect.get(exists, key) === true)
  const [tracked, legacy, versions] = await Promise.all([
    has("tracked") ? runner(SELECT_TRACKED).then(rows) : [],
    // Only a dry run can still see the old table: a real run has moved it.
    has("legacy") ? runner(SELECT_LEGACY).then(rows) : [],
    has("cli") ? runner(SELECT_CLI_VERSIONS).then(rows) : [],
  ])
  return {
    tracked: [...tracked, ...legacy]
      .map((row) => ({ name: stringField(row, "name") ?? "", checksum: stringField(row, "checksum") }))
      .filter((row) => row.name),
    versions: versions
      .map((row) => stringField(row, "version"))
      .filter((version): version is string => Boolean(version)),
  }
}

export async function applyMigrationFiles(input: {
  discovery: MigrationDiscovery
  runner: SupabaseSqlRunner
  dryRun: boolean
  redact?: (value: string) => string
}): Promise<MigrationOutcome> {
  const redact = input.redact ?? ((value: string) => value)
  const files = await Promise.all(
    input.discovery.files.map(async (file) => {
      const sql = await readFile(file.path, "utf8")
      return { ...file, sql, checksum: createHash("sha256").update(sql).digest("hex") }
    }),
  )
  const plan = planMigrations(files, await readApplied(input.runner, input.dryRun))
  const outcome: MigrationOutcome = {
    dryRun: input.dryRun,
    directory: input.discovery.directory,
    discovered: files.map((file) => file.name),
    skipped: input.discovery.skipped,
    alreadyApplied: plan.alreadyApplied,
    appliedByCli: plan.appliedByCli,
    changed: plan.changed,
    pending: plan.pending.map((file) => file.name),
    applied: [],
  }
  if (plan.changed.length) {
    outcome.failed = {
      name: plan.changed[0],
      error: `${plan.changed.join(", ")} changed after ${plan.changed.length === 1 ? "it was" : "they were"} applied. Restore the applied ${plan.changed.length === 1 ? "file" : "files"} and write a new migration for the change; nothing was applied.`,
    }
    return outcome
  }
  if (input.dryRun) return outcome

  // Trust on first use for rows moved from an older release, which had none.
  if (plan.unverified.length) {
    await input.runner(
      plan.unverified
        .map(
          (file) =>
            `update ${TRACKING_TABLE} set checksum = ${quoted(file.checksum)} where name = ${quoted(file.name)} and checksum is null;`,
        )
        .join("\n"),
    )
  }

  for (const file of plan.pending) {
    try {
      if (file.sql.length > MAX_MIGRATION_CHARS) {
        throw new Error(`${file.name} is larger than ${MAX_MIGRATION_CHARS} characters; split it into smaller files.`)
      }
      // The file and its tracking row go in one query, which Postgres runs as a
      // single implicit transaction: a failure rolls both back, so a migration
      // is never recorded without its schema or applied without its record.
      // https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-MULTI-STATEMENT
      await input.runner(
        `${file.sql}\n;\ninsert into ${TRACKING_TABLE} (name, checksum) values (${quoted(file.name)}, ${quoted(file.checksum)}) on conflict (name) do update set checksum = excluded.checksum;`,
      )
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

// Request and response shapes follow the Management API's run-a-query
// endpoint: https://supabase.com/docs/reference/api/v1-run-a-query
export function supabaseSqlRunner(projectRef: string, token: string, request: CloudFetch = fetch): SupabaseSqlRunner {
  const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`
  return async (sql: string) => {
    const response = await request(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": VECTOR_USER_AGENT,
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

export async function applyCloudMigrations(
  input: CloudMigrationsInput,
  request: CloudFetch = fetch,
): Promise<CloudMigrationReport> {
  const dryRun = input.dryRun === true
  const discovery = await discoverMigrations(input.directory ?? input.projectPath)
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
  const token = await getSupabaseManagementToken(request).catch(() => undefined)
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
        appliedByCli: [],
        changed: [],
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
