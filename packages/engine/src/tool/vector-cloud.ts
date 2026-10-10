import { Effect, Schema } from "effect"

import { InstanceState } from "@/effect/instance-state"
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
])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "The Vector Cloud action to perform" }),
  production: Schema.optional(Schema.Boolean).annotate({
    description:
      "For publish, release to production once the checks pass. Defaults to false, which publishes a preview and leaves production unchanged. Set it only when the user asked for a production release.",
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
})

type CloudCheck = { label?: string; status?: string; required?: boolean; details?: string; output?: string }

type CloudReport = {
  ok: boolean
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
  environment?: string
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
// has to read as an instruction rather than as a failed run. It is only added
// when the report says setup is missing: a failed build is not a setup problem.
const SETUP_HINT =
  "Ask the user to connect Vercel or Supabase in Vector Cloud > Connections with an access token, then try again."

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
      report.deploymentId ? `Deployment: ${report.deploymentId}` : undefined,
      checks.length ? `Checks: ${checks.map((check) => `${check.label} ${check.status}`).join("; ")}` : undefined,
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

function formatReport(action: Schema.Schema.Type<typeof Action>, report: CloudReport) {
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
        setupStep(report),
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
  if (action === "publish") return formatPublish(report)
  if (report.ok === false) {
    return lines(
      `Vector Cloud could not run ${action}: ${report.error ?? "the action did not complete."}`,
      setupStep(report),
    )
  }
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

export const VectorCloudTool = Tool.define<typeof Parameters, Metadata, never>(
  "vector_cloud",
  Effect.succeed({
    description: [
      "Controls Vector Cloud for the active project. Vector Cloud has exactly two providers: Vercel hosts the app and Supabase stores its data. There is no other host or database; never offer or switch to one.",
      "Databases: before building authentication, accounts, persistence or other database-backed features, call database_status. When a database is connected, run prepare_database (or prepare_auth for sign-in) and build against it. When none is connected, do not stop and do not just send the user to a dashboard: offer create_database, which creates a new Supabase project on the user's connected Supabase account and wires it in, or linking an existing Supabase project in Vector Cloud > Database. Never create a second database for a project that already has one unless the user asks. create_database is billed to the user's Supabase organization: when it lists several organizations, ask which one and call it again with that organizationId; when it reports a plan or quota limit, relay Supabase's own words instead of retrying. After writing or changing a .sql migration file, run apply_migrations (call it with dryRun first to see what would run). Use supabase_services to inspect storage and Edge Functions.",
      "Publishing: publish deploys this project to the Vercel project linked to it. It publishes a preview by default and leaves production unchanged; pass production: true only when the user asked for a production release, and say which Vercel project before calling. Report the URL and the check results. When a publish fails, the result lists the failed checks with the end of their output: fix the cause in the project and publish a preview again. Do not tell the user to reconnect an account unless the result says setup is needed. When a live production release is broken, first offer to restore the previous release (Vector Cloud > Deployments > Roll back), then read its logs with the logs action before guessing at a cause or asking the user to paste an error.",
      "Secrets: results carry names, never values. Never ask the user to paste a token, key or password into the chat. Name what is needed and where to add it: Vector Cloud > Environment variables for the app's settings, Vector Cloud > Connections for the Vercel and Supabase accounts (connected with an access token).",
      "Every action that publishes, changes a database or writes host settings asks the user first, naming the provider, project and environment. Hosting and database usage follow the connected accounts' billing. Never claim a resource was created unless this tool reports it.",
    ].join(" "),
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
                    params.action === "prepare_auth"
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
          const pattern = [
            described.scope.provider.toLowerCase(),
            described.scope.project,
            described.scope.environment,
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
