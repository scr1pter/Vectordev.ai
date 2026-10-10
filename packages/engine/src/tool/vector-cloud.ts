import { Effect, Schema } from "effect"

import { InstanceState } from "@/effect/instance-state"
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
  ...VERCEL_ACTIONS,
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
})

type CloudReport = {
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
  checks?: { label?: string; status?: string; required?: boolean; details?: string; output?: string }[]
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
  action: Schema.Schema.Type<typeof Action>
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

function toolTitle(action: Schema.Schema.Type<typeof Action>) {
  if (isVercelAction(action)) return "Vercel"
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

function formatReport(action: Schema.Schema.Type<typeof Action>, report: CloudReport) {
  if (report.text && (isVercelAction(action) || action === "list_deployments" || action === "sync_environment")) {
    return lines(report.text, report.nextStep)
  }
  if (action === "publish") return formatPublish(report)
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

// A failed publish shows what failed and the end of the build output, so the
// next step is a fix rather than a guess. Setup advice only follows a setup gap.
function formatPublish(report: CloudReport) {
  const failed = (report.checks ?? []).filter((check) => check.status === "failed")
  const checks = (report.checks ?? [])
    .map(
      (check) =>
        `- ${check.label}: ${check.status}${check.required === false ? " (optional)" : ""}${check.details ? ` · ${check.details}` : ""}`,
    )
    .join("\n")
  if (!report.ok) {
    return lines(
      `Vector Cloud publish failed: ${report.error ?? "the publish did not complete."}`,
      report.url ? `Deployment: ${report.url}` : undefined,
      ...failed.map((check) =>
        lines(
          `FAILED ${check.label}: ${check.details ?? ""}`,
          check.output ? check.output.split("\n").slice(-40).join("\n") : undefined,
        ),
      ),
      checks ? `Checks:\n${checks}` : undefined,
      report.log
        ? `--- end of the build and deploy log ---\n${report.log.split("\n").slice(-30).join("\n")}`
        : undefined,
      report.nextStep ?? (report.needsSetup ? SETUP_HINT : undefined),
    )
  }
  return lines(
    report.environment === "production"
      ? "Published to production."
      : "Published a preview; production did not change.",
    report.url ? `URL: ${report.url}` : undefined,
    report.alias ? `Stable preview address for this branch: ${report.alias}` : undefined,
    report.productionUrl && report.productionUrl !== report.url ? `Production: ${report.productionUrl}` : undefined,
    report.deploymentId ? `Deployment: ${report.deploymentId}` : undefined,
    checks ? `Checks:\n${checks}` : undefined,
    report.protectedChecks === "skipped"
      ? "Deployment Protection kept Vector's checks out of this deployment. Offer enable_protection_bypass so they can run."
      : undefined,
    ...(report.notes ?? []),
    report.nextStep,
  )
}

export const VectorCloudTool = Tool.define<typeof Parameters, Metadata, never>(
  "vector_cloud",
  Effect.succeed({
    description:
      "Controls Vector Cloud for the active project: Vercel for hosting and Supabase for data. Use it before building authentication, accounts, databases, persistence, environment-backed features, or publishing. Inspect cloud_connections before provider work; use database_status plus prepare_database or prepare_auth before implementing Supabase-backed code; and use supabase_services to inspect storage and Edge Functions. When a feature needs a database and database_status reports none, do not stop and send the user to a dashboard: offer create_database, which creates a real Supabase project on their connected Supabase account and wires it in so prepare_database, supabase_services and apply_migrations work straight afterwards. Prefer an existing database over creating one — if the user already has a Supabase project for this app, ask them to link it in Vector Cloud > Database, and never create a second project for a project that already has one unless the user asks. create_database creates something the user's account is billed for, so if it reports several organizations, ask the user which one and call it again with that organizationId rather than picking one, and if it reports a plan or quota limit, relay Supabase's own words instead of retrying. publish deploys to the Vercel project linked to this repository; if none is linked, link or create one with the Vercel actions below or relay the setup step, and never try another host. Hosting and database operations follow the connected account's billing and do not guarantee zero cost. When a published app errors, 500s, renders blank, or otherwise misbehaves, read its logs with the logs action before guessing at a cause or asking the user to paste an error. After writing or changing a .sql migration file, apply it with apply_migrations so the connected database actually has the schema the code expects; call it with dryRun first when you want to see the pending files. Never claim a resource was created unless this tool reports it. " +
      VERCEL_GUIDANCE,
    parameters: Parameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
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
        }
        // Publishing, database changes and host environment writes act on the
        // user's own accounts, so each asks first. The bridge describes the
        // provider, project and environment the action would touch, and the
        // prompt shows them. A migration dry run only reads, so it uses a
        // separate permission that is allowed by default.
        const permission =
          vercelPermission(params.action) ??
          (params.action === "publish"
            ? "vector_cloud_publish"
            : params.action === "sync_environment"
              ? "vector_cloud_environment"
              : params.action === "apply_migrations" && params.dryRun === true
                ? "vector_cloud_inspect"
                : params.action === "apply_migrations" ||
                    params.action === "create_database" ||
                    params.action === "prepare_database" ||
                    params.action === "prepare_auth"
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
        if (permission && described?.scope) {
          // A Vercel action's approval names the action too, so "always" for one
          // (say, adding a domain) never approves another (removing one).
          const pattern = [
            described.scope.provider.toLowerCase(),
            described.scope.project,
            described.scope.environment,
            ...(isVercelAction(params.action) ? [params.action] : []),
          ].join("/")
          yield* ctx.ask({
            permission,
            patterns: [pattern],
            always: [pattern],
            metadata: {
              projectPath: instance.directory,
              ...described.scope,
              production: params.action === "publish" ? params.production === true : undefined,
              dryRun: params.action === "apply_migrations" ? params.dryRun === true : undefined,
              organizationId: params.organizationId,
              region: params.region,
              force: params.action === "create_database" ? params.force === true : undefined,
              action: isVercelAction(params.action) || params.action === "sync_environment" ? params.action : undefined,
            },
          })
        }
        // The approved action runs with what was described, such as the id
        // of the exact environment plan the user saw.
        const report = yield* Effect.promise(() =>
          bridgeRequest({ ...request, ...described?.carry, command: params.action }, ctx.abort),
        )
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
