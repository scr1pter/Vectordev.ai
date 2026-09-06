import { Effect, Schema } from "effect"

import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"

const Action = Schema.Literals([
  "status",
  "detect_build",
  "database_status",
  "prepare_database",
  "prepare_auth",
  "cloud_connections",
  "supabase_services",
  "sync_environment",
  "aws_status",
  "aws_resources",
  "publish",
  "list_deployments",
  "logs",
  "apply_migrations",
])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "The Vector Cloud action to perform" }),
  production: Schema.optional(Schema.Boolean).annotate({
    description: "For publish, promote the verified deployment to production. Defaults to true.",
  }),
  target: Schema.optional(Schema.Literals(["vector-cloud", "vercel", "netlify"])).annotate({
    description: "For publish, use Vector Cloud, Vercel, or Netlify. Defaults to Vector Cloud.",
  }),
  provider: Schema.optional(Schema.Literals(["vercel", "netlify"])).annotate({
    description: "For sync_environment, the linked hosting provider to update.",
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
})

type CloudReport = {
  ok: boolean
  error?: string
  needsSetup?: boolean
  configured?: boolean
  nextStep?: string
  build?: unknown
  database?: unknown
  applied?: unknown
  deployments?: unknown[]
  connections?: unknown[]
  links?: unknown[]
  services?: unknown
  aws?: unknown
  sync?: unknown
  url?: string
  target?: string
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
    const report = (await response.json()) as CloudReport
    if (!response.ok && !report.needsSetup) {
      throw new Error(report.error || `Vector Cloud command failed (${response.status})`)
    }
    return report
  })
}

function toolTitle(action: Schema.Schema.Type<typeof Action>) {
  if (action === "publish") return "Publish with Vector Cloud"
  if (action === "logs") return "Read deployment logs"
  if (action === "apply_migrations") return "Apply database migrations"
  return "Vector Cloud"
}

function lines(...values: (string | undefined)[]) {
  return values.filter((value): value is string => Boolean(value)).join("\n")
}

function nameList(values?: string[]) {
  return values?.length ? values.join(", ") : "none"
}

function formatReport(action: Schema.Schema.Type<typeof Action>, report: CloudReport) {
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
        ? `Migration plan for ${migrations.directory} (dry run: nothing was applied).`
        : `Migrations in ${migrations.directory}.`,
      `Already applied: ${nameList(migrations.alreadyApplied)}`,
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
    return report.ok
      ? [
          "Vector Cloud publish completed.",
          report.url ? `URL: ${report.url}` : undefined,
          report.deploymentId ? `Deployment: ${report.deploymentId}` : undefined,
          report.checks ? `Checks: ${JSON.stringify(report.checks)}` : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n")
      : `Vector Cloud publish did not complete: ${report.error ?? "Unknown error"}`
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
  if (action === "aws_status" || action === "aws_resources") {
    return `AWS integration:\n${JSON.stringify(report.aws, null, 2)}`
  }
  if (action === "detect_build") return `Vector Cloud build settings:\n${JSON.stringify(report.build, null, 2)}`
  if (action === "list_deployments")
    return `Vector Cloud deployments:\n${JSON.stringify(report.deployments ?? [], null, 2)}`
  return [
    `Vector Cloud configured: ${report.configured ? "yes" : "no"}`,
    `Build settings: ${JSON.stringify(report.build ?? null)}`,
    `Database: ${JSON.stringify(report.database ?? { connected: false })}`,
    `Recent deployments: ${JSON.stringify(report.deployments ?? [])}`,
  ].join("\n")
}

export const VectorCloudTool = Tool.define<typeof Parameters, Metadata, never>(
  "vector_cloud",
  Effect.succeed({
    description:
      "Controls Vector Cloud for the active project. Use it before building authentication, accounts, databases, persistence, environment-backed features, AWS-backed systems, or publishing. Inspect cloud_connections before provider work; use database_status plus prepare_database or prepare_auth before implementing Supabase-backed code; use supabase_services to inspect storage and Edge Functions; and use aws_status or aws_resources before AWS work. For publish requests, choose the named target or default to Vector Cloud. When a published app errors, 500s, renders blank, or otherwise misbehaves, read its logs with the logs action before guessing at a cause or asking the user to paste an error. After writing or changing a .sql migration file, apply it with apply_migrations so the connected database actually has the schema the code expects; call it with dryRun first when you want to see the pending files. Never claim a resource was created unless this tool reports it.",
    parameters: Parameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        if (params.action === "publish") {
          yield* ctx.ask({
            permission: "vector_cloud_publish",
            patterns: [instance.directory],
            always: [instance.directory],
            metadata: { projectPath: instance.directory, production: params.production !== false },
          })
        }
        if (params.action === "prepare_database" || params.action === "prepare_auth") {
          yield* ctx.ask({
            permission: "vector_cloud_database",
            patterns: [instance.directory],
            always: [instance.directory],
            metadata: { projectPath: instance.directory },
          })
        }
        // Writing schema to the user's real database is destructive, so it asks
        // under the same permission the other database actions use — including
        // the dry run, which still reaches that database to read what applied.
        if (params.action === "apply_migrations") {
          yield* ctx.ask({
            permission: "vector_cloud_database",
            patterns: [instance.directory],
            always: [instance.directory],
            metadata: { projectPath: instance.directory, dryRun: params.dryRun === true },
          })
        }
        if (params.action === "sync_environment") {
          yield* ctx.ask({
            permission: "vector_cloud_environment",
            patterns: [instance.directory],
            always: [instance.directory],
            metadata: { projectPath: instance.directory, provider: params.provider },
          })
        }
        const report = yield* Effect.promise(() =>
          bridgeRequest(
            {
              command: params.action,
              projectPath: instance.directory,
              taskId: ctx.sessionID,
              production: params.production,
              target: params.target,
              provider: params.provider,
              deploymentId: params.deploymentId,
              limit: params.limit,
              dryRun: params.dryRun,
            },
            ctx.abort,
          ),
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
