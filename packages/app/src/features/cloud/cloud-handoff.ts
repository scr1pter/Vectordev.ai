import type { CloudOverview, PublishTarget } from "./cloud-api"
import type { SecurityReport } from "./supabase/supabase-api"

// How Vector Cloud hands work to the rest of Vector: deep links into the Cloud
// screens, prompts that start the agent on a cloud task, and the readiness a
// publish needs. Cloud is reached from Home; a task's own view has no Cloud UI.

/** Every Vector Cloud screen a link can open. */
export const CLOUD_SECTIONS = [
  "overview",
  "deployments",
  "logs",
  "observability",
  "domains",
  "environment",
  "database",
  "authentication",
  "storage",
  "functions",
  "data-logs",
  "security",
  "connections",
  "settings",
] as const

export type CloudSection = (typeof CLOUD_SECTIONS)[number]

/** The screen a /cloud link names, or undefined when it names none Vector Cloud has. */
export function parseCloudSection(value: string | null) {
  return CLOUD_SECTIONS.find((item) => item === value)
}

/** A link into Vector Cloud for one project, optionally opened at one section. */
export function cloudHref(projectPath?: string, section?: CloudSection) {
  const search = new URLSearchParams()
  if (projectPath) search.set("project", projectPath)
  if (section) search.set("section", section)
  const query = search.toString()
  return query ? `/cloud?${query}` : "/cloud"
}

export type DeployEvidence = {
  project: string
  environment?: string
  url?: string
  /** The provider's id for the deployment, so the agent can read its logs. */
  deploymentId?: string
  error?: string
  git?: { branch: string; commit: string; dirty: boolean }
  checks: { label: string; status: string; details?: string; output?: string }[]
  log?: string
}

// The end of a build log is where its error is, and a whole log would crowd
// out the rest of the conversation.
const EVIDENCE_LINES = 40

/**
 * The prompt that starts the agent on a failed deploy. Every log and check
 * output here comes from the desktop already redacted, so the prompt never
 * carries a secret value.
 */
export function deployRepairPrompt(input: DeployEvidence) {
  const failed = input.checks.filter((check) => check.status === "failed")
  const tail = (text: string) => text.trimEnd().split(/\r?\n/).slice(-EVIDENCE_LINES).join("\n")
  return [
    `Fix the failing Vector Cloud deploy of ${input.project}${input.environment ? ` (${input.environment})` : ""}.`,
    input.error ? `Error: ${input.error}` : undefined,
    input.url ? `Deployment: ${input.url}${input.deploymentId ? ` (${input.deploymentId})` : ""}` : undefined,
    input.git
      ? `Git: ${input.git.branch} at ${input.git.commit}${input.git.dirty ? ", with uncommitted changes" : ""}`
      : undefined,
    ...failed.map((check) =>
      [
        `Failed check, ${check.label}: ${check.details ?? "failed"}`,
        check.output?.trim() ? `\`\`\`\n${tail(check.output)}\n\`\`\`` : undefined,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    ),
    // The log repeats a failed check's output, so it only adds evidence when
    // no check carried any (a deploy the provider rejected, for example).
    !failed.some((check) => check.output?.trim()) && input.log?.trim()
      ? `Last lines of the publish log:\n\`\`\`\n${tail(input.log)}\n\`\`\``
      : undefined,
    // Nothing in hand to read: the provider still has the deployment's logs.
    input.deploymentId && !failed.some((check) => check.output?.trim()) && !input.log?.trim()
      ? `Read its build log first: vector_cloud logs with deploymentId ${input.deploymentId} (source runtime for what the running app logged).`
      : undefined,
    "Find the root cause, make the smallest safe fix, and rerun the failing step locally. Then publish a preview with vector_cloud publish and report the result. Do not publish to production unless I ask. The evidence above is redacted: if a missing setting or secret is the cause, tell me its name so I can add it in Vector Cloud > Environment variables, and never ask me to paste its value here.",
  ]
    .filter((line) => line !== undefined)
    .join("\n\n")
}

/**
 * The prompt that starts the agent on what the Supabase security check found.
 * Findings carry variable names, file paths and advisor titles, never a value.
 */
export function securityFixPrompt(
  project: string,
  report: Pick<SecurityReport, "advisors" | "environment" | "bundle">,
) {
  const findings = [
    ...report.environment.map((item) => `${item.level} · the variable ${item.where} ${item.reason}`),
    ...report.bundle.map((item) => `${item.level} · the built file ${item.where} ${item.reason}`),
    ...report.advisors
      .filter((item) => item.level !== "INFO")
      .map(
        (item) =>
          `${item.level} · ${item.title}${item.entity ? ` · ${item.entity}` : ""}${item.remediation ? ` (${item.remediation})` : ""}`,
      ),
  ]
  return [
    `Fix what Vector Cloud's security check found on the Supabase project ${project}.`,
    findings.join("\n"),
    "Make database fixes, such as row level security and its policies, as migrations: write each with vector_cloud create_migration, with down SQL, and apply it with apply_migrations so I review the SQL first. For a server key in a public variable or a built file, change the code to read it only on the server, tell me which variable to rename to a server-only name in Vector Cloud > Environment variables, and say that the exposed key should be rotated; never print its value. Then run vector_cloud security_check again and report what is left.",
  ].join("\n\n")
}

/**
 * The prompt that starts the agent on the Vercel logs the user is reading. It
 * names the deployment and source instead of pasting the lines: the agent reads
 * the same redacted logs with vector_cloud logs.
 */
export function vercelLogsPrompt(input: { deploymentId: string; source: "build" | "runtime"; label: string }) {
  return [
    `Diagnose the ${input.source} logs of the Vercel deployment ${input.deploymentId} (${input.label}).`,
    `Read them with vector_cloud logs (deploymentId ${input.deploymentId}, source ${input.source}). Find the root cause of the errors, make the smallest safe fix in the project, and rerun the failing step locally. Then publish a preview with vector_cloud publish and report the result. Do not publish to production unless I ask. The logs are redacted: if a missing setting or secret is the cause, tell me its name so I can add it in Vector Cloud > Environment variables, and never ask me to paste its value here.`,
  ].join("\n\n")
}

/**
 * The prompt that starts the agent on the Supabase logs the user is reading,
 * by the same service, window and filter the agent's supabase_logs takes.
 */
export function supabaseLogsPrompt(input: {
  project: string
  service: string
  label: string
  minutes: number
  search?: string
}) {
  return [
    `Diagnose the ${input.label} logs of the Supabase project ${input.project} from the last ${input.minutes} minutes${input.search ? `, filtered to "${input.search}"` : ""}.`,
    `Read them with vector_cloud supabase_logs (service ${input.service}, minutes ${input.minutes}${input.search ? `, search "${input.search}"` : ""}). Find the root cause of the errors and fix it: database changes as migrations written with vector_cloud create_migration, with down SQL, and applied with apply_migrations so I review the SQL first; code changes in the project. Then read the logs again and report what changed. If a missing setting or secret is the cause, tell me its name so I can add it in Vector Cloud > Environment variables, and never ask me to paste its value here.`,
  ].join("\n\n")
}

/**
 * Whether a failed publish got as far as its checks or the deploy, so the
 * project has something for Fix this deploy to fix. A publish refused before
 * it ran (one already running, no project open, hosting not set up) does not.
 */
export function publishRan(result: { checks?: readonly unknown[]; log?: string }) {
  return Boolean(result.checks?.length || result.log?.trim())
}

/**
 * The warning shown before a publish from a folder with uncommitted changes:
 * a release is built from the files on disk, so it includes them.
 */
export function uncommittedNote(git?: { branch: string; commit: string; dirty: boolean }) {
  if (!git?.dirty) return
  return `This folder has uncommitted changes. It is built from the files as they are on disk, not from ${git.branch} at ${git.commit}.`
}

export type PublishPlan =
  | { ready: true; project: string; account?: string }
  /** `connect` is true when Vector Cloud > Connections is where it gets fixed. */
  | { ready: false; reason: string; connect: boolean }

/**
 * Where a preview would go, or what has to be set up first. Publishing needs
 * what the agent's publish needs too: the Vercel account connected in Vector
 * Cloud, a Vercel project linked to this project, and a
 * machine that can run the deploy.
 */
export function publishPlan(hosting: CloudOverview["hosting"], target?: PublishTarget): PublishPlan {
  if (!hosting.connected) {
    return { ready: false, reason: "Connect Vercel in Vector Cloud > Connections.", connect: true }
  }
  if (!hosting.project) {
    return {
      ready: false,
      reason: "Link a Vercel project to this project in Vector Cloud > Connections.",
      connect: true,
    }
  }
  // Connected and linked, but this machine cannot run the deploy (no Node.js, for example).
  if (target && !target.available) {
    return { ready: false, reason: target.loginHint || "This machine cannot run the Vercel deploy.", connect: false }
  }
  return { ready: true, project: hosting.project.name, account: hosting.account }
}
