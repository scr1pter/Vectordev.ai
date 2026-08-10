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
}

type Metadata = {
  action: Schema.Schema.Type<typeof Action>
  projectPath: string
  url?: string
}

function bridgeRequest(input: Record<string, unknown>, signal: AbortSignal) {
  const url = process.env.VECTOR_CLOUD_AGENT_BRIDGE_URL
  const token = process.env.VECTOR_CLOUD_AGENT_BRIDGE_TOKEN
  if (!url || !token) throw new Error("Vector Cloud agent tools are available in the Vector desktop app only.")
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

function formatReport(action: Schema.Schema.Type<typeof Action>, report: CloudReport) {
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
      "Controls Vector Cloud for the active project. Use it before building authentication, accounts, databases, persistence, environment-backed features, AWS-backed systems, or publishing. Inspect cloud_connections before provider work; use database_status plus prepare_database or prepare_auth before implementing Supabase-backed code; use supabase_services to inspect storage and Edge Functions; and use aws_status or aws_resources before AWS work. For publish requests, choose the named target or default to Vector Cloud. Never claim a resource was created unless this tool reports it.",
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
            },
            ctx.abort,
          ),
        )
        return {
          title: params.action === "publish" ? "Publish with Vector Cloud" : "Vector Cloud",
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
