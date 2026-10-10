import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import {
  applyCloudMigrations,
  discoverMigrations,
  downSection,
  MIGRATION_DIRECTORIES,
  planMigrations,
  quoted,
  readApplied,
  rows,
  supabaseSqlRunner,
  TRACKING_TABLE,
  type MigrationDiscovery,
  type MigrationFile,
} from "./cloud-migrations"
import {
  errorMessage,
  scrub,
  SupabaseSetupError,
  type SupabaseContext,
  type SupabaseOptions,
} from "./cloud-supabase-api"

// The database side of a linked Supabase project beyond applying migrations:
// what is applied, writing a new migration, rolling the latest one back with
// its paired down migration, and running SQL with reads kept read-only.

const MAX_SQL_CHARS = 100_000
const READ_ONLY_VIOLATION = /read-only transaction|read only transaction|permission denied/i

type Caller = "console" | "agent"

// What the Management API's applied history says about the files in the
// repository, plus which applied migration a rollback would undo.
export async function migrationStatus(
  input: { projectPath: string; taskId?: string; directory: string },
  options: SupabaseOptions = {},
) {
  const report = await applyCloudMigrations(
    { projectPath: input.projectPath, taskId: input.taskId, directory: input.directory, dryRun: true },
    options.request ?? fetch,
  )
  if (!report.ok || !report.migrations) return report
  const discovery = await discoverMigrations(input.directory)
  const last = discovery.files.filter((file) => report.migrations?.alreadyApplied.includes(file.name)).at(-1)
  const down = last ? await findDown(discovery, last) : undefined
  return {
    ...report,
    rollback: last ? { name: last.name, available: Boolean(down), source: down?.source } : undefined,
  }
}

async function findDown(discovery: MigrationDiscovery, file: MigrationFile) {
  const base = file.name.replace(/\.sql$/i, "")
  for (const candidate of [
    join(file.path, "..", `${base}.down.sql`),
    join(file.path, "..", "down", `${base}.down.sql`),
  ]) {
    const sql = await readFile(candidate, "utf8").catch(() => undefined)
    if (sql?.trim()) return { sql, source: "file" as const, path: candidate }
  }
  const section = downSection(await readFile(file.path, "utf8"))
  if (section) return { sql: section, source: "section" as const, path: file.path }
}

// Timestamped like the Supabase CLI writes them (YYYYMMDDHHMMSS_name.sql), so
// both tools agree on the order. A down migration goes into down/, where the
// CLI, which reads only the top level, never mistakes it for a forward one.
export async function createMigrationFile(input: { directory: string; name: string; sql: string; downSql?: string }) {
  const slug = input.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
  if (!slug) throw new Error("Give the migration a short name, such as add_profiles.")
  const sql = input.sql.trim()
  if (!sql) throw new Error("A migration needs the SQL it should run.")
  if (sql.length > MAX_SQL_CHARS || (input.downSql?.length ?? 0) > MAX_SQL_CHARS) {
    throw new Error(`Keep a migration under ${MAX_SQL_CHARS} characters; split it into several.`)
  }
  const discovery = await discoverMigrations(input.directory)
  const relative = discovery.directory ?? MIGRATION_DIRECTORIES[0]
  const folder = join(input.directory, relative)
  await mkdir(folder, { recursive: true })
  const taken = new Set((await readdir(folder).catch(() => [])).map((name) => name.split("_")[0]))
  const start = Date.now()
  const version = Array.from({ length: 120 }, (_, offset) =>
    new Date(start + offset * 1000).toISOString().replace(/\D/g, "").slice(0, 14),
  ).find((candidate) => !taken.has(candidate))
  if (!version) throw new Error("Too many migrations were created this minute; try again shortly.")
  const name = `${version}_${slug}.sql`
  await writeFile(join(folder, name), `${sql}\n`, { encoding: "utf8", flag: "wx" })
  const down = input.downSql?.trim()
  if (down) {
    await mkdir(join(folder, "down"), { recursive: true })
    await writeFile(join(folder, "down", `${version}_${slug}.down.sql`), `${down}\n`, { encoding: "utf8", flag: "wx" })
  }
  return {
    file: join(relative, name),
    downFile: down ? join(relative, "down", `${version}_${slug}.down.sql`) : undefined,
    nextStep: down
      ? "Apply it with apply_migrations when it is ready."
      : "Apply it with apply_migrations when it is ready. Without a down migration it cannot be rolled back from Vector.",
  }
}

// Only the most recent applied migration can be undone, and only with a down
// migration the user wrote: Vector never guesses the inverse of a schema
// change. The down SQL and the history rows go in one query, which Postgres
// runs as one transaction, so a failed rollback leaves the history untouched.
export async function rollbackMigration(context: SupabaseContext, input: { directory: string; name?: string }) {
  const discovery = await discoverMigrations(input.directory)
  if (!discovery.directory) {
    throw new SupabaseSetupError(
      `This project has no migrations directory (looked for ${MIGRATION_DIRECTORIES.join(", ")}).`,
      "There is nothing to roll back.",
    )
  }
  const runner = supabaseSqlRunner(context.projectRef, context.token, context.request)
  const files = await Promise.all(
    discovery.files.map(async (file) => ({
      ...file,
      checksum: createHash("sha256")
        .update(await readFile(file.path, "utf8"))
        .digest("hex"),
    })),
  )
  const plan = planMigrations(files, await readApplied(runner, true))
  const last = files.filter((file) => plan.alreadyApplied.includes(file.name)).at(-1)
  if (!last) return { ok: false, error: `No migration in ${discovery.directory} is applied to ${context.projectName}.` }
  if (input.name && input.name !== last.name) {
    return {
      ok: false,
      error: `Only the most recent applied migration can be rolled back, and that is ${last.name}, not ${input.name}.`,
      nextStep: `Roll back ${last.name} first if ${input.name} really has to be undone.`,
    }
  }
  const down = await findDown(discovery, last)
  if (!down) {
    return {
      ok: false,
      error: `${last.name} has no down migration, so Vector will not guess how to undo it.`,
      nextStep: `Write the SQL that undoes it to ${join(discovery.directory, "down", last.name.replace(/\.sql$/i, ".down.sql"))}, then roll back again.`,
    }
  }
  const version = last.name.match(/^(\d+)_/)?.[1]
  const history = [
    `if to_regclass('${TRACKING_TABLE}') is not null then delete from ${TRACKING_TABLE} where name = ${quoted(last.name)}; end if;`,
    version
      ? `if to_regclass('supabase_migrations.schema_migrations') is not null then delete from supabase_migrations.schema_migrations where version = ${quoted(version)}; end if;`
      : "",
  ].join("\n")
  try {
    await runner(`${down.sql}\n;\ndo $$\nbegin\n${history}\nend\n$$;`)
  } catch (error) {
    return {
      ok: false,
      error: `Rolling back ${last.name} failed and nothing changed: ${scrub(context, errorMessage(error))}`,
    }
  }
  return {
    ok: true,
    rolledBack: last.name,
    projectRef: context.projectRef,
    downSource: down.source === "file" ? basename(down.path) : `the -- down section of ${last.name}`,
    nextStep: `${last.name} is still in ${discovery.directory}, so apply_migrations would run it again. Change or delete it before the next apply.`,
  }
}

export type SqlResult = {
  columns: string[]
  rows: (string | number | boolean | null)[][]
  rowCount: number
  truncated: boolean
  readOnly: boolean
}

// Reads run as Supabase's read-only role, so a query that turns out to write
// is refused rather than run. Changing data takes an explicit `write`, which
// the console only sends after the user confirms and the agent only after its
// permission prompt said so.
// https://supabase.com/docs/reference/api/v1-run-a-query
export async function runSql(
  context: SupabaseContext,
  input: { sql: string; write?: boolean; maxRows?: number; caller: Caller },
) {
  const sql = input.sql.trim()
  if (!sql) throw new Error("Enter a SQL query to run.")
  if (sql.length > MAX_SQL_CHARS) throw new Error(`Queries are limited to ${MAX_SQL_CHARS} characters.`)
  const limits =
    input.caller === "agent" ? { rows: 200, rowsDefault: 50, cell: 300 } : { rows: 1000, rowsDefault: 500, cell: 4000 }
  const maxRows = Math.min(limits.rows, Math.max(1, Math.trunc(input.maxRows ?? limits.rowsDefault)))
  const readOnly = input.write !== true
  const runner = supabaseSqlRunner(context.projectRef, context.token, context.request, { readOnly })
  const outcome = await runner(sql).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error: scrub(context, errorMessage(error)) }),
  )
  if (outcome.error !== undefined) {
    if (!readOnly || !READ_ONLY_VIOLATION.test(outcome.error)) throw new Error(outcome.error)
    return {
      ok: false,
      needsConfirmation: true,
      error: `Supabase refused this query in read-only mode, so it did not change ${context.projectName}: it writes data or needs write access. ${outcome.error}`,
      nextStep:
        input.caller === "agent"
          ? "Run it again with allowWrite only if the user wants this change made to the live database."
          : "Confirm to run it as a write against the live database.",
    }
  }
  const all = rows(outcome.value)
  const columns = Array.from(
    new Set(all.flatMap((row) => (row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []))),
  )
  // Every cell is scrubbed: a table can hold tokens and keys, and the agent's
  // copy is model context the user cannot take back.
  const cell = (value: unknown): string | number | boolean | null => {
    if (value === null || value === undefined) return null
    if (typeof value === "number" || typeof value === "boolean") return value
    const text = scrub(context, typeof value === "string" ? value : JSON.stringify(value))
    return text.length > limits.cell ? `${text.slice(0, limits.cell)}…` : text
  }
  return {
    ok: true,
    project: { ref: context.projectRef, name: context.projectName },
    result: {
      columns,
      rows: all
        .slice(0, maxRows)
        .map((row) => columns.map((column) => cell(row && typeof row === "object" ? Reflect.get(row, column) : row))),
      rowCount: all.length,
      truncated: all.length > maxRows,
      readOnly,
    } satisfies SqlResult,
  }
}
