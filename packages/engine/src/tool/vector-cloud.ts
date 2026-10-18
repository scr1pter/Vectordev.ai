import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"
import path from "path"

import { PermissionPolicy } from "@vectordevai/schema/permission-policy"

import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { Tool } from "./tool"
import {
  isVercelAction,
  vercelPermission,
  VercelParameters,
  VERCEL_ACTIONS,
  VERCEL_GUIDANCE,
} from "./vector-cloud-vercel"

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
  "check_health",
  "rerun_checks",
  "set_release_settings",
  "stored_env",
  "write_env_file",
  "remove_stored_env",
  ...VERCEL_ACTIONS,
  "supabase_projects",
  "create_organization",
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
  "create_organization",
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
    description:
      "For publish: true builds for production, checks it and promotes it. Defaults to false, a preview that leaves production alone; set it only when the user asked to ship to production.",
  }),
  provider: Schema.optional(Schema.Literals(["vercel"])).annotate({
    description: "For sync_environment, the linked hosting provider to update. Vercel is the only hosting provider.",
  }),
  deploymentId: Schema.optional(Schema.String).annotate({
    description:
      "For logs, inspect_deployment, promote, rollback, redeploy and cancel_deployment: a deployment id (dpl_...) or URL from list_deployments. logs defaults to the newest deployment; rollback defaults to the last deployment that served production and passed Vector's checks.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description:
      "For logs, how many trailing log lines to return (default 100, at most 500); for list_deployments, how many deployments (default 20).",
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
  ...VercelParameters,
  packageManager: Schema.optional(Schema.Literals(["bun", "pnpm", "yarn", "npm", "static"])).annotate({
    description: "For set_release_settings: the package manager Vector installs and builds with.",
  }),
  testCommand: Schema.optional(Schema.String).annotate({
    description:
      "For set_release_settings: the test command Vector runs before it publishes. An empty string runs none.",
  }),
  healthPath: Schema.optional(Schema.String).annotate({
    description:
      "For set_release_settings: the path Vector's health probe opens on each release, for example /api/health.",
  }),
  requiredChecks: Schema.optional(
    Schema.Struct({
      test: Schema.optional(Schema.Boolean),
      secrets: Schema.optional(Schema.Boolean),
      health: Schema.optional(Schema.Boolean),
      browser: Schema.optional(Schema.Boolean),
    }),
  ).annotate({
    description:
      "For set_release_settings: which checks must pass before a release can reach production. Name only the ones to change; turn one off only when the user asks.",
  }),
  projectRef: Schema.optional(Schema.String).annotate({
    description: "For link_database, the reference of a Supabase project from supabase_projects.",
  }),
  organizationName: Schema.optional(Schema.String).annotate({
    description:
      "For create_organization, the name of the new Supabase organization, as the user chose it (at most 100 characters).",
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
      "For update_auth, the OAuth provider to change. Its client secret is entered by the user in Vector Cloud > Authentication, never in chat.",
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

// SQL a prompt shows, cut to a readable length; `length` is the whole of it.
type Statement = { label: string; sql: string; length: number; truncated: boolean }

type CloudCheck = { label?: string; status?: string; required?: boolean; details?: string; output?: string }

type CloudReport = {
  [key: string]: unknown
  ok: boolean
  scope?: { provider: string; project: string; environment: string; summary: string }
  /** From describe: what the approved action runs with, such as the id of the plan the user saw. */
  carry?: Record<string, unknown>
  /** From describe: there is nothing to change, so nothing is asked or run. */
  noop?: boolean
  /** A Vercel action's report, already worded for the model. */
  text?: string
  errorCode?: string
  environment?: string
  productionUrl?: string
  alias?: string
  protectedChecks?: string
  notes?: string[]
  /** The SQL the action would run or write, for the permission prompt. */
  statements?: Statement[]
  /** Sent back with the command, so it does exactly what the prompt showed. */
  approved?: Record<string, unknown>
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
  /** stored_env: { key, visibility } per variable; remove_stored_env: the names still stored. */
  variables?: unknown[]
  removed?: string
  services?: unknown
  sync?: unknown
  url?: string
  target?: string
  targets?: { id: string; label: string; projectName?: string }[]
  deploymentId?: string
  checks?: CloudCheck[]
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
  if (isVercelAction(action)) return "Vercel"
  if (SUPABASE_ACTIONS.has(action)) return "Supabase"
  if (action === "check_health" || action === "rerun_checks" || action === "set_release_settings")
    return "Release checks"
  if (action === "publish") return "Publish with Vector Cloud"
  if (action === "logs") return "Read deployment logs"
  if (action === "apply_migrations") return "Apply database migrations"
  if (action === "create_database") return "Create a database"
  if (action === "stored_env" || action === "write_env_file" || action === "remove_stored_env")
    return "Environment variables"
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
// has to read as an instruction rather than as a failed run. It is only added
// when the report says setup is missing: a failed build is not a setup problem.
const SETUP_HINT = "Ask the user to connect Vercel or Supabase in Vector Cloud > Connections, then try again."

// How much of a failed check's output, or of the publish log, reaches the
// model: the end of a build log is where the error is.
const TAIL_LINES = 40

function tail(text: string | undefined) {
  return (text ?? "").trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join("\n")
}

function setupStep(report: CloudReport) {
  return report.nextStep ?? (report.needsSetup ? SETUP_HINT : undefined)
}

// Handled before the generic failure branch: a failed publish carries the
// evidence the agent needs to repair it (the failed checks with their output,
// and the redacted log), which the generic branch would drop.
function formatPublish(report: CloudReport) {
  const checks = report.checks ?? []
  if (report.ok) {
    return lines(
      report.environment === "production"
        ? "Vector Cloud published a production release."
        : report.environment === "preview"
          ? "Vector Cloud published a preview release. Production is unchanged."
          : "Vector Cloud publish completed.",
      report.url ? `URL: ${report.url}` : undefined,
      report.alias ? `Stable preview address for this branch: ${report.alias}` : undefined,
      report.productionUrl && report.productionUrl !== report.url ? `Production: ${report.productionUrl}` : undefined,
      report.deploymentId ? `Deployment: ${report.deploymentId}` : undefined,
      checks.length ? `Checks: ${checks.map((check) => `${check.label} ${check.status}`).join("; ")}` : undefined,
      report.protectedChecks === "skipped"
        ? "Deployment Protection kept Vector's checks out of this deployment. Offer enable_protection_bypass so they can run."
        : undefined,
      ...(report.notes ?? []),
      report.nextStep ??
        (report.environment === "preview"
          ? "Share the preview URL. Release to production only after the user asks: publish again with production: true."
          : undefined),
    )
  }
  const failed = checks.filter((check) => check.status === "failed")
  const evidence = failed.some((check) => check.output?.trim())
  return lines(
    `Vector Cloud publish failed: ${report.error ?? "the publish did not complete."}`,
    report.url ? `URL: ${report.url}` : undefined,
    report.deploymentId ? `Deployment: ${report.deploymentId}` : undefined,
    failed.length ? "Failed checks:" : undefined,
    ...failed.map((check) =>
      lines(
        `- ${check.label}${check.required === false ? " (optional)" : ""}: ${check.details ?? "failed"}`,
        check.output?.trim() ? `--- last lines of ${check.label} output ---\n${tail(check.output)}` : undefined,
      ),
    ),
    !evidence && report.log?.trim() ? `--- last lines of the publish log ---\n${tail(report.log)}` : undefined,
    setupStep(report),
  )
}

function formatReport(action: Action, report: CloudReport) {
  if (
    report.text &&
    (isVercelAction(action) ||
      ["list_deployments", "sync_environment", "check_health", "rerun_checks", "set_release_settings"].includes(action))
  ) {
    return lines(report.text, report.nextStep)
  }
  if (action === "publish") return formatPublish(report)
  // Handled before the generic failure branch: a create_database that stopped to
  // ask which organization to bill is not a failed run, and the answer the user
  // has to give is the list of organizations, which the generic branch drops.
  if (action === "create_database") {
    if (report.needsChoice) {
      return lines(
        report.error ?? "Vector needs to know which Supabase organization the new Supabase project belongs to.",
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
        setupStep(report),
      )
    }
    return lines(
      report.createdNow
        ? "Created a new Supabase project and connected it to this repository."
        : "No database was created; this repository already has one connected.",
      `Database: ${JSON.stringify(report.database ?? { connected: false })}`,
      report.applied ? `Repository environment prepared: ${JSON.stringify(report.applied)}` : undefined,
      report.nextStep,
    )
  }
  if (report.ok === false) {
    return lines(
      `Vector Cloud could not run ${action}: ${report.error ?? "the action did not complete."}`,
      setupStep(report),
    )
  }
  if (SUPABASE_ACTIONS.has(action)) return formatSupabase(action, report)
  if (action === "logs") {
    if (!report.logs) return lines(report.error, report.nextStep) || "No deployment logs are available."
    const logs = report.logs
    return lines(
      `Deployment ${report.deploymentId} on ${logs.provider} (${logs.environment}, health ${logs.status}, created ${logs.createdAt}).`,
      report.url ? `URL: ${report.url}` : undefined,
      `Source: ${logs.source === "build" ? "build output recorded by Vector" : logs.source === "runtime" ? "Vercel runtime logs" : "Vercel build logs"}. ${logs.lines} line(s) shown${
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
  if (action === "database_status" || action === "prepare_database") {
    return [
      `Vector Cloud database: ${JSON.stringify(report.database ?? { connected: false })}`,
      report.applied ? `Repository environment prepared: ${JSON.stringify(report.applied)}` : undefined,
      report.nextStep ?? report.error,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n")
  }
  if (action === "prepare_auth") {
    return [
      `Vector Cloud authentication backend: ${JSON.stringify(report.database ?? { connected: false })}`,
      report.applied ? `Repository environment prepared: ${JSON.stringify(report.applied)}` : undefined,
      report.nextStep ?? report.error,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n")
  }
  if (action === "stored_env") {
    const variables = (report.variables ?? []).filter(
      (item): item is { key: string; visibility?: string } =>
        typeof item === "object" && item !== null && typeof Reflect.get(item, "key") === "string",
    )
    return variables.length
      ? `Variables Vector stores for this repository (names only; values never reach you): ${variables
          .map((item) => `${item.key} (${item.visibility === "public" ? "public" : "server-only"})`)
          .join(", ")}`
      : "Vector stores no environment variables for this repository. The user adds them in Vector Cloud > Environment variables."
  }
  if (action === "write_env_file") {
    return `Wrote the stored variables to .env: ${JSON.stringify(report.applied)}. Do not read .env or print its values.`
  }
  if (action === "remove_stored_env") {
    return `Removed ${report.removed} from the variables Vector stores for this repository. Still stored: ${nameList(
      (report.variables ?? []).filter((item): item is string => typeof item === "string"),
    )}. Write .env again (write_env_file) or sync Vercel to drop older copies.`
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
      | {
          columns: string[]
          rows: unknown[][]
          rowCount: number
          truncated: boolean
          readOnly: boolean
          hiddenColumns?: string[]
        }
      | undefined
    const project = report.project as { name?: string } | undefined
    if (!result) return JSON.stringify(data)
    return lines(
      `${result.readOnly ? "Read-only query" : "Write"} on Supabase project ${project?.name ?? ""}: ${result.rows.length} of ${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""}.`,
      result.hiddenColumns?.length
        ? `Hidden because they hold or may hold sign-in credentials: ${result.hiddenColumns.join(", ")}. A query that reads Supabase's auth, vault or pgsodium tables shows only their known non-credential columns, named as they are. The user can see them in Vector Cloud > Database.`
        : undefined,
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
          nextStep?: string
          advisors: { level: string; title: string; entity?: string; remediation?: string }[]
          environment: { level: string; where: string; reason: string }[]
          bundle: { level: string; where: string; reason: string }[]
        }
      | undefined
    if (!security) return JSON.stringify(data)
    return lines(
      `Supabase security check: ${security.status}. ${security.detail}`,
      security.nextStep,
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
    organizationName: params.organizationName,
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
    description: [
      "Controls Vector Cloud for the active project. Vector Cloud has exactly two providers: Vercel hosts the app and Supabase stores its data. There is no other host or database; never offer or switch to one. Inspect cloud_connections before provider work.",
      "Databases: before building authentication, accounts, persistence or other database-backed features, call database_status. When a database is connected, run prepare_database (or prepare_auth for sign-in) and build against it. When none is connected, do not stop and do not just send the user to a dashboard: offer create_database, which creates a new Supabase project on the user's connected Supabase account and wires it in, or link the user's existing Supabase project: find it with supabase_projects and link it with link_database (the user can also link it in Vector Cloud > Database). Never create a second database for a project that already has one unless the user asks. create_database is billed to the user's Supabase organization: when it lists several organizations, ask which one and call it again with that organizationId; when the account has none, ask the user what to name one, create it with create_organization and pass its organizationId; when it reports a plan or quota limit, relay Supabase's own words instead of retrying. After writing or changing a .sql migration file, run apply_migrations (call it with dryRun first to see what would run). Use supabase_services to inspect storage and Edge Functions.",
      "Supabase control for the linked project: supabase_projects lists organizations and projects; create_organization creates an organization, only when the user wants one; link_database and unlink_database; pause_database and restore_database; write_database_url writes a server-only DATABASE_URL, only when the user wants one; rotate_database_password resets the password and can rewrite DATABASE_URL and push it to Vercel. Database: migration_status; create_migration writes a timestamped file (pass downSql so it can be rolled back); apply_migrations; rollback_migration undoes only the latest applied migration and only with its down migration; run_sql runs read-only unless allowWrite, and hides cells in columns named like passwords, tokens or secrets. Auth: auth_config; update_auth for the site URL, redirect URLs (addVercelUrls adds the linked Vercel production and preview addresses), email sign-in and Google, GitHub or Apple sign-in; auth_users, invite_user, delete_user. Storage: create_bucket, update_bucket, delete_bucket. Edge Functions: deploy_function from supabase/functions/<name>, delete_function, function_secrets (names only), set_function_secrets from names of stored environment variables, delete_function_secrets. supabase_logs reads api, postgres, auth, storage or functions logs, so check them when a Supabase-backed feature fails. security_check runs Supabase's security advisors and a scan for leaked server keys; production only moves to a release while it passes, as long as Secret scan is a required release check, which it is by default.",
      "Publishing: publish deploys this project to the Vercel project linked to it. It publishes a preview by default and leaves production unchanged; pass production: true only when the user asked for a production release, and say which Vercel project before calling. Vector then builds production, runs the release checks and promotes it only if they pass. Report the URL and the check results. When a publish fails, the result lists the failed checks with the end of their output: fix the cause in the project and publish a preview again. Do not tell the user to reconnect an account unless the result says setup is needed. When a live production release is broken, first offer rollback (with no deploymentId it returns production to the last deployment that served it and passed Vector's checks), then read its logs with the logs action before guessing at a cause or asking the user to paste an error.",
      VERCEL_GUIDANCE,
      "Vector's release checks: status shows the saved build settings and which checks are required before production. check_health probes every release Vector published (or the one deploymentId names) and reports its HTTP status and response time; rerun_checks re-runs Vector's release checks on one release; set_release_settings changes the install, test and build commands, output directory, health path and the required checks (requiredChecks), and asks first.",
      "Secrets: results carry names, never values. Never ask the user to paste a token, key or password into the chat. Name what is needed and where to add it: Vector Cloud > Environment variables for the app's settings (stored_env lists the names stored there; write_env_file writes them to the project's .env; remove_stored_env removes one; set_env without a value copies a stored one to Vercel), Vector Cloud > Connections for the Vercel and Supabase accounts (the user signs in there; only the user can connect or disconnect an account). OAuth client secrets and function secret values are also entered by the user in Vector Cloud.",
      "Every action that publishes or moves production, creates or changes a database, or writes hosting settings, domains, host variables, Vector's stored variables or .env asks the user first, every time, naming the provider, project and environment. Auto-accept, permission rules and earlier approvals never answer these prompts, so expect one for each such call and do not batch unrelated changes into one. A rejected prompt means nothing changed. Hosting and database usage follow the connected accounts' billing. Never claim a resource was created unless this tool reports it.",
    ].join(" "),
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
          source: params.source,
          teamId: params.teamId,
          projectId: params.projectId,
          name: params.name,
          framework: params.framework,
          rootDirectory: params.rootDirectory,
          buildCommand: params.buildCommand,
          outputDirectory: params.outputDirectory,
          installCommand: params.installCommand,
          nodeVersion: params.nodeVersion,
          key: params.key,
          value: params.value,
          targets: params.targets,
          gitBranch: params.gitBranch,
          envType: params.envType,
          domain: params.domain,
          packageManager: params.packageManager,
          testCommand: params.testCommand,
          healthPath: params.healthPath,
          requiredChecks: params.requiredChecks,
          ...(supabase ? supabaseFields(params) : {}),
        }
        // Runs the action with what its prompt approved: the id of the exact
        // environment plan the user saw, the migration file it named, or the
        // checksum of the down SQL it showed.
        const run = (approved?: Record<string, unknown>) =>
          Effect.promise(() => bridgeRequest({ ...request, ...approved, command: params.action }, ctx.abort)).pipe(
            Effect.map((report) => ({
              title: toolTitle(params.action),
              metadata: { action: params.action, projectPath: instance.directory, url: report.url },
              output: formatReport(params.action, report),
            })),
          )
        // A new migration is a file in the repository, so it asks like any other
        // edit (plan mode refuses it), and the prompt shows the SQL of both the
        // migration and its down file, which rollback_migration later runs.
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
          yield* ctx.ask({
            permission: "edit",
            patterns: files.map((file) => path.relative(instance.worktree, path.join(instance.directory, file))),
            always: ["*"],
            metadata: {
              filepath: path.join(instance.directory, files[0]),
              diff: files
                .map((file, index) => {
                  const filepath = path.join(instance.directory, file)
                  const sql = index === 0 ? params.sql : params.downSql
                  return trimDiff(createTwoFilesPatch(filepath, filepath, "", `${sql?.trim() ?? ""}\n`))
                })
                .join("\n"),
              statements: planned.statements,
            },
          })
          return yield* run(planned.approved)
        }
        // Publishing, database changes, hosting settings and host environment
        // writes act on the user's own accounts, so each asks first. The bridge
        // describes the provider, project and environment the action would
        // touch, and the prompt shows them. A migration dry run only reads, so it
        // uses a separate permission that is allowed by default.
        const permission =
          vercelPermission(params.action) ??
          (params.action === "publish"
            ? "vector_cloud_publish"
            : params.action === "set_release_settings"
              ? "vector_cloud_hosting"
              : params.action === "sync_environment" ||
                  params.action === "write_env_file" ||
                  params.action === "remove_stored_env"
                ? "vector_cloud_environment"
                : params.action === "apply_migrations" && params.dryRun === true
                  ? "vector_cloud_inspect"
                  : params.action === "apply_migrations" ||
                      params.action === "create_database" ||
                      params.action === "prepare_database" ||
                      params.action === "prepare_auth" ||
                      SUPABASE_CHANGES.has(params.action)
                    ? "vector_cloud_database"
                    : undefined)
        const described = permission
          ? yield* Effect.promise(() =>
              bridgeRequest({ ...request, command: "describe", action: params.action }, ctx.abort),
            )
          : undefined
        // Nothing to approve: the action cannot run until setup is done, or
        // there is nothing for it to change.
        if (described && (!described.ok || !described.scope || described.noop)) {
          return {
            title: toolTitle(params.action),
            metadata: { action: params.action, projectPath: instance.directory },
            output: formatReport(params.action, described),
          }
        }
        if (!permission || !described?.scope) return yield* run()
        // The pattern names the provider, project, environment and action, so
        // a deny rule can target exactly one of them. The account permissions
        // (publish, database, environment, hosting) ask every time under the
        // shared PermissionPolicy: auto-accept, a configured allow and an
        // earlier "always" answer none of them, so they offer no "always".
        // Only the read-only migration dry run can be remembered.
        const pattern = [
          described.scope.provider.toLowerCase(),
          described.scope.project,
          described.scope.environment,
          params.action,
        ].join("/")
        yield* ctx.ask({
          permission,
          patterns: [pattern],
          always: PermissionPolicy.canAlwaysApprove(permission, [pattern]) ? [pattern] : [],
          metadata: {
            projectPath: instance.directory,
            action: params.action,
            ...described.scope,
            production: params.action === "publish" ? params.production === true : undefined,
            dryRun: params.action === "apply_migrations" ? params.dryRun === true : undefined,
            organizationId: params.organizationId,
            region: params.region,
            force: params.action === "create_database" ? params.force === true : undefined,
            statements: described.statements,
          },
        })
        return yield* run({ ...described.carry, ...described.approved })
      }),
  }),
)
