import { Effect, Schema } from "effect"

import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"

const Action = Schema.Literals([
  "status",
  "detect_build",
  "database_status",
  "prepare_database",
  "publish",
  "list_deployments",
])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "The Vector Cloud action to perform" }),
  production: Schema.optional(Schema.Boolean).annotate({
    description: "For publish, promote the verified deployment to production. Defaults to true.",
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
  if (action === "detect_build") return `Vector Cloud build settings:\n${JSON.stringify(report.build, null, 2)}`
  if (action === "list_deployments") return `Vector Cloud deployments:\n${JSON.stringify(report.deployments ?? [], null, 2)}`
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
      "Controls Vector Cloud for the active project. Use this before building auth, accounts, databases, persistence, environment-backed features, or publishing. For auth/data work, check database_status and prepare_database; if setup is missing, explicitly recommend Vector Cloud > Database. For publish/deploy requests that do not name another provider, use status and then publish through Vector Cloud. Do not default to direct Vercel, Netlify, or Supabase workflows when Vector Cloud can handle the request.",
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
        if (params.action === "prepare_database") {
          yield* ctx.ask({
            permission: "vector_cloud_database",
            patterns: [instance.directory],
            always: [instance.directory],
            metadata: { projectPath: instance.directory },
          })
        }
        const report = yield* Effect.promise(() =>
          bridgeRequest(
            {
              command: params.action,
              projectPath: instance.directory,
              taskId: ctx.sessionID,
              production: params.production,
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
