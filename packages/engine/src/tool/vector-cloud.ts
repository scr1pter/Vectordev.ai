import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"
import path from "path"

import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { Tool } from "./tool"

const Action = Schema.Literals([
  "status",
  "detect_build",
  "database_status",
  "create_database",
  "prepare_database",
  "prepare_auth",
  "cloud_connections",
  "supabase_services",
  "sync_environment",
  "publish",
  "list_deployments",
  "logs",
  "apply_migrations",
  "supabase_projects",
  "link_database",
  "unlink_database",
  "pause_database",
  "restore_database",
  "write_database_url",
  "rotate_database_password",
  "migration_status",
  "create_migration",
  "rollback_migration",
  "run_sql",
  "auth_config",
  "update_auth",
  "auth_users",
  "invite_user",
  "delete_user",
  "create_bucket",
  "update_bucket",
  "delete_bucket",
  "deploy_function",
  "delete_function",
  "function_secrets",
  "set_function_secrets",
  "delete_function_secrets",
  "supabase_logs",
  "security_check",
])

type Action = Schema.Schema.Type<typeof Action>

// Supabase actions that change the linked project or the user's account. Each
// asks under vector_cloud_database after the desktop describes it; the desktop
// marks destructive, billed or credential-bearing ones as never "always".
const SUPABASE_CHANGES = new Set<Action>([
  "link_database",
  "unlink_database",
  "pause_database",
  "restore_database",
  "write_database_url",
  "rotate_database_password",
  "rollback_migration",
  "run_sql",
  "update_auth",
  "invite_user",
  "delete_user",
  "create_bucket",
  "update_bucket",
  "delete_bucket",
  "deploy_function",
  "delete_function",
  "set_function_secrets",
  "delete_function_secrets",
])

// Supabase actions answered by the desktop's shared Supabase commands.
const SUPABASE_ACTIONS = new Set<Action>([
  ...SUPABASE_CHANGES,
  "supabase_projects",
  "migration_status",
  "create_migration",
  "auth_config",
  "auth_users",
  "function_secrets",
  "supabase_logs",
  "security_check",
])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "The Vector Cloud action to perform" }),
  production: Schema.optional(Schema.Boolean).annotate({
    description: "For publish, promote the verified deployment to production. Defaults to true.",
  }),
  provider: Schema.optional(Schema.Literals(["vercel"])).annotate({
    description: "For sync_environment, the linked hosting provider to update. Vercel is the only hosting provider.",
  }),
  deploymentId: Schema.optional(Schema.String).annotate({
    description: "For logs, a deployment id from list_deployments. Defaults to the most recent deployment.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "For logs, how many trailing log lines to return. Defaults to 100, capped at 500.",
  }),
  dryRun: Schema.optional(Schema.Boolean).annotate({
    description: "For apply_migrations, list the migrations that would run without applying anything.",
  }),
  organizationId: Schema.optional(Schema.String).annotate({
    description:
      "For create_database, the Supabase organization to create the project in. Required only when the account has more than one; create_database reports the choices when it needs this.",
  }),
  region: Schema.optional(Schema.String).annotate({
    description:
      "For create_database, the Supabase region for the new project, for example us-east-1 or eu-west-2. Defaults to us-east-1; ask the user before choosing something else.",
  }),
  force: Schema.optional(Schema.Boolean).annotate({
    description:
      "For create_database, create a new Supabase project even though this project already has a database connected. Defaults to false.",
  }),
  projectRef: Schema.optional(Schema.String).annotate({
    description: "For link_database, the reference of a Supabase project from supabase_projects.",
  }),
  migrationName: Schema.optional(Schema.String).annotate({
    description:
      "For create_migration, a short name such as add_profiles. For rollback_migration, the applied migration file to roll back (only the most recent applied one can be).",
  }),
  sql: Schema.optional(Schema.String).annotate({
    description: "For create_migration, the SQL of the new migration. For run_sql, the query to run.",
  }),
  downSql: Schema.optional(Schema.String).annotate({
    description:
      "For create_migration, SQL that undoes the migration. Without it the migration cannot be rolled back from Vector.",
  }),
  allowWrite: Schema.optional(Schema.Boolean).annotate({
    description:
      "For run_sql, allow the query to change data. Defaults to false, which runs it read-only. Set it only when the user wants that change made to the live database.",
  }),
  maxRows: Schema.optional(Schema.Number).annotate({
    description: "For run_sql, the most rows to return. Defaults to 50, capped at 200.",
  }),
  siteUrl: Schema.optional(Schema.String).annotate({
    description: "For update_auth, the site URL Supabase Auth sends users back to by default.",
  }),
  redirectUrls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "For update_auth, redirect URLs to add to the allow list (Supabase globs such as https://app.example.com/** work).",
  }),
  removeRedirectUrls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "For update_auth, redirect URLs to remove from the allow list.",
  }),
  addVercelUrls: Schema.optional(Schema.Boolean).annotate({
    description: "For update_auth, also allow the linked Vercel project's production and preview addresses.",
  }),
  emailEnabled: Schema.optional(Schema.Boolean).annotate({
    description: "For update_auth, turn email sign-in on or off.",
  }),
  authProvider: Schema.optional(Schema.Literals(["google", "github", "apple"])).annotate({
    description:
      "For update_auth, the OAuth provider to change. Its client secret is entered by the user in Cloud Services > Authentication, never in chat.",
  }),
  providerEnabled: Schema.optional(Schema.Boolean).annotate({
    description: "For update_auth with authProvider, turn that provider's sign-in on or off.",
  }),
  clientId: Schema.optional(Schema.String).annotate({
    description: "For update_auth with authProvider, the provider's OAuth client id.",
  }),
  email: Schema.optional(Schema.String).annotate({ description: "For invite_user, the address to invite." }),
  userId: Schema.optional(Schema.String).annotate({ description: "For delete_user, the user's id from auth_users." }),
  page: Schema.optional(Schema.Number).annotate({ description: "For auth_users, the page of 50 users to read." }),
  bucket: Schema.optional(Schema.String).annotate({
    description: "For create_bucket, update_bucket and delete_bucket, the bucket name.",
  }),
  publicBucket: Schema.optional(Schema.Boolean).annotate({
    description:
      "For create_bucket and update_bucket, whether anyone with a file's URL can read it. Buckets are private by default.",
  }),
  fileSizeLimit: Schema.optional(Schema.Number).annotate({
    description: "For create_bucket and update_bucket, the largest file in bytes.",
  }),
  allowedMimeTypes: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "For create_bucket and update_bucket, allowed MIME types such as image/*.",
  }),
  emptyBucket: Schema.optional(Schema.Boolean).annotate({
    description: "For delete_bucket, delete every file in it first. Without it a bucket with files is not deleted.",
  }),
  functionName: Schema.optional(Schema.String).annotate({
    description: "For deploy_function and delete_function, the function's folder name under supabase/functions.",
  }),
  secretNames: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "For set_function_secrets, names of this project's stored environment variables whose values become function secrets. For delete_function_secrets, the secrets to delete.",
  }),
  service: Schema.optional(Schema.Literals(["api", "postgres", "auth", "storage", "functions"])).annotate({
    description: "For supabase_logs, which service's logs to read.",
  }),
  minutes: Schema.optional(Schema.Number).annotate({
    description: "For supabase_logs, how far back to read. Defaults to 60, at most 1440.",
  }),
  search: Schema.optional(Schema.String).annotate({
    description: "For supabase_logs, only lines containing this text.",
  }),
  writeDatabaseUrl: Schema.optional(Schema.Boolean).annotate({
    description: "For rotate_database_password, also write the new server-only DATABASE_URL.",
  }),
  syncVercel: Schema.optional(Schema.Boolean).annotate({
    description: "For rotate_database_password, also push this project's environment to the linked Vercel project.",
  }),
})

type CloudReport = {
  [key: string]: unknown
  ok: boolean
  repeatable?: boolean
  scope?: { provider: string; project: string; environment: string; summary: string }
  error?: string
  needsSetup?: boolean
  needsChoice?: boolean
  createdNow?: boolean
  configured?: boolean
  nextStep?: string
  build?: unknown
  database?: unknown
  organizations?: { id?: string; name?: string; plan?: string }[]
  waitedMs?: number
  applied?: unknown
  deployments?: unknown[]
  connections?: unknown[]
  links?: unknown[]
  services?: unknown
  sync?: unknown
  url?: string
  target?: string
  targets?: { id: string; label: string; projectName?: string }[]
  deploymentId?: string
  checks?: unknown[]
  log?: string
  logs?: {
    provider?: string
    source?: string
    environment?: string
    status?: string
    createdAt?: string
    fetchedAt?: string
    detail?: string
    lines?: number
    droppedLines?: number
    truncated?: boolean
    tail?: string
  }
  migrations?: {
    dryRun?: boolean
    directory?: string
    projectRef?: string
    discovered?: string[]
    skipped?: string[]
    alreadyApplied?: string[]
    appliedByCli?: string[]
    changed?: string[]
    pending?: string[]
    applied?: string[]
    failed?: { name?: string; error?: string }
  }
}

type Metadata = {
  action: Action
  projectPath: string
  url?: string
}

function bridgeRequest(input: Record<string, unknown>, signal: AbortSignal) {
  const url = process.env.VECTOR_CLOUD_BRIDGE_URL
  const token = process.env.VECTOR_CLOUD_BRIDGE_TOKEN
  if (!url || !token) throw new Error("Vector Cloud tools are available in the Vector desktop app only.")
  return fetch(`${url}/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }).then(async (response) => {
    const report = (await response.json().catch(() => undefined)) as CloudReport | undefined
    // A structured report is an answer, not a crash. "No account is connected
    // yet" is the most common one, and the model can only relay it to the user
    // if it arrives as tool output rather than as a thrown tool error. Only a
    // bridge that answered with nothing usable is a real failure.
    if (!report || typeof report !== "object" || typeof report.ok !== "boolean" || (!response.ok && report.ok)) {
      throw new Error(`Vector Cloud command failed (${response.status})`)
    }
    return report
  })
}

function toolTitle(action: Action) {
  if (SUPABASE_ACTIONS.has(action)) return "Supabase"
  if (action === "publish") return "Publish with Vector Cloud"
  if (action === "logs") return "Read deployment logs"
  if (action === "apply_migrations") return "Apply database migrations"
  if (action === "create_database") return "Create a database"
  return "Vector Cloud"
}

function lines(...values: (string | undefined)[]) {
  return values.filter((value): value is string => Boolean(value)).join("\n")
}

function nameList(values?: string[]) {
  return values?.length ? values.join(", ") : "none"
}

// What the user has to do before this action can work. Cloud actions depend on
// an account Vector cannot connect on the user's behalf, so an unfinished setup
// has to read as an instruction rather than as a failed run.
const SETUP_HINT = "Connect an account in Vector Cloud > Connections (Vercel or Supabase), then try again."

function formatReport(action: Action, report: CloudReport) {
  // Handled before the generic failure branch: a create_database that stopped to
  // ask which organization to bill is not a failed run, and the answer the user
  // has to give is the list of organizations, which the generic branch drops.
  if (action === "create_database") {
    if (report.needsChoice) {
      return lines(
        report.error ?? "Vector needs to know which Supabase organization the new project belongs to.",
        `Organizations: ${
          report.organizations
            ?.map((item) => `${item.name} (organizationId ${item.id}${item.plan ? `, ${item.plan} plan` : ""})`)
            .join("; ") || "none"
        }`,
        report.nextStep,
      )
    }
    if (report.ok === false) {
      return lines(
        `Vector Cloud did not create a database: ${report.error ?? "the action did not complete."}`,
        report.nextStep ?? SETUP_HINT,
      )
    }
    return lines(
      report.createdNow
        ? "Created a new Supabase project and connected it to this project."
        : "No database was created; this project already has one connected.",
      `Database: ${JSON.stringify(report.database ?? { connected: false })}`,
      report.applied ? `Project environment prepared: ${JSON.stringify(report.applied)}` : undefined,
      report.nextStep,
    )
  }
  if (report.ok === false) {
    return lines(
      `Vector Cloud could not run ${action}: ${report.error ?? "the action did not complete."}`,
      report.nextStep ?? SETUP_HINT,
    )
  }
  if (SUPABASE_ACTIONS.has(action)) return formatSupabase(action, report)
  if (action === "logs") {
    if (!report.logs) return lines(report.error, report.nextStep) || "No deployment logs are available."
    const logs = report.logs
    return lines(
      `Deployment ${report.deploymentId} on ${logs.provider} (${logs.environment}, health ${logs.status}, created ${logs.createdAt}).`,
      report.url ? `URL: ${report.url}` : undefined,
      `Source: ${logs.source === "build" ? "build output recorded by Vector" : "provider API"}. ${logs.lines} line(s) shown${
        logs.droppedLines ? `, ${logs.droppedLines} earlier line(s) dropped` : ""
      }.`,
      logs.detail,
      logs.tail ? `--- newest last ---\n${logs.tail}` : "This deployment produced no log output.",
    )
  }
  if (action === "apply_migrations") {
    const migrations = report.migrations
    if (!migrations) return lines(report.error, report.nextStep) || "No migrations were applied."
    return lines(
      migrations.dryRun
        ? `Migration plan for ${migrations.directory} (dry run: nothing was applied). ${migrations.pending?.length ?? 0} migration(s) would run against Supabase project ${migrations.projectRef} (production).`
        : `Migrations in ${migrations.directory}, applied to Supabase project ${migrations.projectRef} (production).`,
      `Already applied: ${nameList(migrations.alreadyApplied)}`,
      migrations.appliedByCli?.length
        ? `Recorded by the Supabase CLI, so not run again: ${nameList(migrations.appliedByCli)}`
        : undefined,
      migrations.changed?.length
        ? `Changed after they were applied, so nothing runs until they are restored: ${nameList(migrations.changed)}`
        : undefined,
      migrations.dryRun
        ? `Would apply, in order: ${nameList(migrations.pending)}`
        : `Applied now, in order: ${nameList(migrations.applied)}`,
      !migrations.dryRun && migrations.pending?.length
        ? `Not attempted after the failure: ${nameList(migrations.pending)}`
        : undefined,
      migrations.failed ? `FAILED on ${migrations.failed.name}: ${migrations.failed.error}` : undefined,
      migrations.skipped?.length ? `Ignored (unsupported filename): ${nameList(migrations.skipped)}` : undefined,
      report.nextStep,
    )
  }
  if (action === "publish") {
    return lines(
      "Vector Cloud publish completed.",
      report.url ? `URL: ${report.url}` : undefined,
      report.deploymentId ? `Deployment: ${report.deploymentId}` : undefined,
      report.checks ? `Checks: ${JSON.stringify(report.checks)}` : undefined,
      report.nextStep,
    )
  }
  if (action === "database_status" || action === "prepare_database") {
    return [
      `Vector Cloud database: ${JSON.stringify(report.database ?? { connected: false })}`,
      report.applied ? `Project environment prepared: ${JSON.stringify(report.applied)}` : undefined,
      report.nextStep ?? report.error,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n")
  }
  if (action === "prepare_auth") {
    return [
      `Vector Cloud authentication backend: ${JSON.stringify(report.database ?? { connected: false })}`,
      report.applied ? `Project environment prepared: ${JSON.stringify(report.applied)}` : undefined,
      report.nextStep ?? report.error,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n")
  }
  if (action === "cloud_connections") {
    return `Vector Cloud connections:\n${JSON.stringify({ connections: report.connections, links: report.links }, null, 2)}`
  }
  if (action === "supabase_services") return `Supabase services:\n${JSON.stringify(report.services, null, 2)}`
  if (action === "sync_environment") return `Environment sync:\n${JSON.stringify(report.sync ?? report.error, null, 2)}`
  if (action === "detect_build") return `Vector Cloud build settings:\n${JSON.stringify(report.build, null, 2)}`
  if (action === "list_deployments")
    return `Vector Cloud deployments:\n${JSON.stringify(report.deployments ?? [], null, 2)}`
  return [
    `Vector Cloud configured: ${report.configured ? "yes" : "no"}`,
    `Publish destinations: ${JSON.stringify(report.targets ?? [])}`,
    `Connections: ${JSON.stringify(report.connections ?? [])}`,
    `Build settings: ${JSON.stringify(report.build ?? null)}`,
    `Database: ${JSON.stringify(report.database ?? { connected: false })}`,
    `Recent deployments: ${JSON.stringify(report.deployments ?? [])}`,
  ].join("\n")
}

// Supabase replies carry names, counts and settings, never credentials or env
// values; the desktop scrubs them before they arrive here.
function formatSupabase(action: Action, report: CloudReport) {
  const data = Object.fromEntries(Object.entries(report).filter(([key]) => key !== "ok"))
  if (action === "run_sql") {
    const result = report.result as
      | { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; readOnly: boolean }
      | undefined
    const project = report.project as { name?: string } | undefined
    if (!result) return JSON.stringify(data)
    return lines(
      `${result.readOnly ? "Read-only query" : "Write"} on Supabase project ${project?.name ?? ""}: ${result.rows.length} of ${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""}.`,
      result.columns.length ? result.columns.join(" | ") : undefined,
      ...result.rows.map((row) => row.map((cell) => (cell === null ? "null" : String(cell))).join(" | ")),
    )
  }
  if (action === "supabase_logs") {
    const entries = (report.entries as { at: string; message: string }[] | undefined) ?? []
    return lines(
      `${report.label} logs from ${report.from} to ${report.to}: ${entries.length} line(s)${report.truncated ? ", older lines not shown" : ""}.`,
      entries.length
        ? `--- newest last ---\n${entries.map((entry) => `${entry.at} ${entry.message}`).join("\n")}`
        : "No log lines in that window.",
    )
  }
  if (action === "security_check") {
    const security = report.security as
      | {
          status: string
          detail: string
          advisors: { level: string; title: string; entity?: string; remediation?: string }[]
          environment: { level: string; where: string; reason: string }[]
          bundle: { level: string; where: string; reason: string }[]
        }
      | undefined
    if (!security) return JSON.stringify(data)
    return lines(
      `Supabase security check: ${security.status}. ${security.detail}`,
      ...security.advisors.map(
        (item) =>
          `${item.level} · ${item.title}${item.entity ? ` · ${item.entity}` : ""}${item.remediation ? ` (${item.remediation})` : ""}`,
      ),
      ...[...security.environment, ...security.bundle].map((item) => `${item.level} · ${item.where} ${item.reason}`),
    )
  }
  return `Supabase ${action.replaceAll("_", " ")}:\n${JSON.stringify(data, null, 2)}`
}

function supabaseFields(params: Schema.Schema.Type<typeof Parameters>) {
  return {
    projectRef: params.projectRef,
    name: params.migrationName,
    sql: params.sql,
    downSql: params.downSql,
    write: params.allowWrite,
    maxRows: params.maxRows,
    siteUrl: params.siteUrl,
    redirectUrls: params.redirectUrls,
    removeRedirectUrls: params.removeRedirectUrls,
    addVercelUrls: params.addVercelUrls,
    emailEnabled: params.emailEnabled,
    providers: params.authProvider
      ? { [params.authProvider]: { enabled: params.providerEnabled, clientId: params.clientId } }
      : undefined,
    email: params.email,
    userId: params.userId,
    page: params.page,
    bucket: params.bucket,
    public: params.publicBucket,
    fileSizeLimit: params.fileSizeLimit,
    allowedMimeTypes: params.allowedMimeTypes,
    empty: params.emptyBucket,
    functionName: params.functionName,
    secretNames: params.secretNames,
    service: params.service,
    minutes: params.minutes,
    search: params.search,
    writeDatabaseUrl: params.writeDatabaseUrl,
    syncVercel: params.syncVercel,
  }
}

export const VectorCloudTool = Tool.define<typeof Parameters, Metadata, never>(
  "vector_cloud",
  Effect.succeed({
    description:
      "Controls Vector Cloud for the active project: Vercel for hosting and Supabase for data. Use it before building authentication, accounts, databases, persistence, environment-backed features, or publishing. Inspect cloud_connections before provider work; use database_status plus prepare_database or prepare_auth before implementing Supabase-backed code; and use supabase_services to inspect storage and Edge Functions. When a feature needs a database and database_status reports none, do not stop and send the user to a dashboard: offer create_database, which creates a real Supabase project on their connected Supabase account and wires it in so prepare_database, supabase_services and apply_migrations work straight afterwards. Prefer an existing database over creating one — if the user already has a Supabase project for this app, ask them to link it in Vector Cloud > Database, and never create a second project for a project that already has one unless the user asks. create_database creates something the user's account is billed for, so if it reports several organizations, ask the user which one and call it again with that organizationId rather than picking one, and if it reports a plan or quota limit, relay Supabase's own words instead of retrying. publish deploys to the Vercel project linked to this repository; if none is linked, relay the setup step instead of trying another host. Hosting and database operations follow the connected account's billing and do not guarantee zero cost. When a published app errors, 500s, renders blank, or otherwise misbehaves, read its logs with the logs action before guessing at a cause or asking the user to paste an error. After writing or changing a .sql migration file, apply it with apply_migrations so the connected database actually has the schema the code expects; call it with dryRun first when you want to see the pending files. Never claim a resource was created unless this tool reports it. " +
      "Supabase control for the linked project: supabase_projects lists organizations and projects; link_database and unlink_database; pause_database and restore_database; write_database_url writes a server-only DATABASE_URL, only when the user wants one; rotate_database_password resets the password and can rewrite DATABASE_URL and push the environment to Vercel. Database: migration_status; create_migration writes a timestamped file (pass downSql so it can be rolled back); apply_migrations; rollback_migration undoes only the latest applied migration and only with its down migration; run_sql runs read-only unless allowWrite. Auth: auth_config; update_auth for the site URL, redirect URLs (addVercelUrls adds the linked Vercel production and preview addresses), email sign-in and Google, GitHub or Apple sign-in; auth_users, invite_user, delete_user. Storage: create_bucket, update_bucket, delete_bucket (supabase_services lists buckets and functions). Edge Functions: deploy_function from supabase/functions/<name>, delete_function, function_secrets (names only), set_function_secrets from names of stored environment variables, delete_function_secrets. supabase_logs reads api, postgres, auth, storage or functions logs, so check them when a Supabase-backed feature fails. security_check runs Supabase's security advisors and a scan for leaked server keys; a production publish requires it to pass. Every changing action asks the user first. OAuth client secrets and other secret values are entered by the user in Cloud Services, never pasted into chat.",
    parameters: Parameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const supabase = SUPABASE_ACTIONS.has(params.action)
        const request = {
          projectPath: instance.directory,
          taskId: ctx.sessionID,
          production: params.production,
          provider: params.provider,
          deploymentId: params.deploymentId,
          limit: params.limit,
          dryRun: params.dryRun,
          organizationId: params.organizationId,
          region: params.region,
          force: params.force,
          ...(supabase ? supabaseFields(params) : {}),
        }
        // A new migration is a file in the repository, so it asks like any other
        // edit (plan mode refuses it) and the prompt shows the SQL it writes.
        if (params.action === "create_migration") {
          const planned = yield* Effect.promise(() =>
            bridgeRequest({ ...request, command: "describe", action: params.action }, ctx.abort),
          )
          const files = Array.isArray(planned.files)
            ? planned.files.filter((item): item is string => typeof item === "string")
            : []
          if (!planned.ok || !files.length) {
            return {
              title: toolTitle(params.action),
              metadata: { action: params.action, projectPath: instance.directory },
              output: formatReport(params.action, planned),
            }
          }
          const filepath = path.join(instance.directory, files[0])
          yield* ctx.ask({
            permission: "edit",
            patterns: files.map((file) => path.relative(instance.worktree, path.join(instance.directory, file))),
            always: ["*"],
            metadata: {
              filepath,
              diff: trimDiff(createTwoFilesPatch(filepath, filepath, "", `${params.sql?.trim() ?? ""}\n`)),
            },
          })
        }
        // Publishing, database changes and host environment writes act on the
        // user's own accounts, so each asks first. The bridge describes the
        // provider, project and environment the action would touch, and the
        // prompt shows them. A migration dry run only reads, so it uses a
        // separate permission that is allowed by default.
        const permission =
          params.action === "publish"
            ? "vector_cloud_publish"
            : params.action === "sync_environment"
              ? "vector_cloud_environment"
              : params.action === "apply_migrations" && params.dryRun === true
                ? "vector_cloud_inspect"
                : params.action === "apply_migrations" ||
                    params.action === "create_database" ||
                    params.action === "prepare_database" ||
                    params.action === "prepare_auth" ||
                    SUPABASE_CHANGES.has(params.action)
                  ? "vector_cloud_database"
                  : undefined
        if (permission) {
          const described = yield* Effect.promise(() =>
            bridgeRequest({ ...request, command: "describe", action: params.action }, ctx.abort),
          )
          // Nothing to approve yet: the action cannot run until setup is done.
          if (!described.ok || !described.scope) {
            return {
              title: toolTitle(params.action),
              metadata: { action: params.action, projectPath: instance.directory },
              output: formatReport(params.action, described),
            }
          }
          // A Supabase change is approved per action, so "always" for creating a
          // bucket never covers deleting users. Destructive, billed or
          // credential-bearing requests get no "always" and a pattern of their
          // own, so an earlier "always" for a milder form of the same action (a
          // read-only run_sql, a private bucket) never approves them.
          const pattern = [
            described.scope.provider.toLowerCase(),
            described.scope.project,
            described.scope.environment,
            ...(supabase ? [params.action] : []),
            ...(described.repeatable === false ? ["each-time"] : []),
          ].join("/")
          yield* ctx.ask({
            permission,
            patterns: [pattern],
            always: described.repeatable === false ? [] : [pattern],
            metadata: {
              projectPath: instance.directory,
              action: supabase ? params.action : undefined,
              ...described.scope,
              production: params.action === "publish" ? params.production !== false : undefined,
              dryRun: params.action === "apply_migrations" ? params.dryRun === true : undefined,
              organizationId: params.organizationId,
              region: params.region,
              force: params.action === "create_database" ? params.force === true : undefined,
            },
          })
        }
        const report = yield* Effect.promise(() => bridgeRequest({ ...request, command: params.action }, ctx.abort))
        return {
          title: toolTitle(params.action),
          metadata: {
            action: params.action,
            projectPath: instance.directory,
            url: report.url,
          },
          output: formatReport(params.action, report),
        }
      }),
  }),
)
