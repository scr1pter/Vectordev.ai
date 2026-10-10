import type { CloudDeployment, CloudOverview, PublishTarget } from "./cloud-api"
import type { CloudSection } from "./cloud-console"

// How the rest of Vector hands work to Vector Cloud and back: deep links into
// the Cloud screens, prompts that start the agent on a cloud task, and the
// readiness a publish needs.

/** A link into Vector Cloud for one project, optionally opened at one section. */
export function cloudHref(projectPath?: string, section?: CloudSection) {
  const search = new URLSearchParams()
  if (projectPath) search.set("project", projectPath)
  if (section) search.set("section", section)
  const query = search.toString()
  return query ? `/cloud?${query}` : "/cloud"
}

export const COMPOSER_PROMPT_EVENT = "vector:composer-prompt"

export type ComposerPrompt = {
  text: string
  /** Send it straight away, starting the agent, instead of leaving it in the composer. */
  send: boolean
}

/** Hands a prompt to the session composer on screen. False when no composer took it. */
export function requestComposerPrompt(request: ComposerPrompt) {
  const event = new CustomEvent<ComposerPrompt>(COMPOSER_PROMPT_EVENT, { detail: request, cancelable: true })
  return !(globalThis.window?.dispatchEvent(event) ?? true)
}

/**
 * Lets a composer take the prompts other surfaces hand it. `take` returns false
 * to decline one (a composer holding an unsent draft keeps it), and the surface
 * then starts a new session with the prompt instead. Returns the unsubscribe.
 */
export function onComposerPrompt(take: (request: ComposerPrompt) => boolean) {
  const listener = (event: Event) => {
    // One composer takes each request, so two mounted at once never both send it.
    if (event.defaultPrevented || !(event instanceof CustomEvent)) return
    if (take(event.detail)) event.preventDefault()
  }
  globalThis.window?.addEventListener(COMPOSER_PROMPT_EVENT, listener)
  return () => globalThis.window?.removeEventListener(COMPOSER_PROMPT_EVENT, listener)
}

/**
 * Whether a composer can take a handed-over prompt. It declines while it holds
 * work the user has not sent (text, images, or line comments, which a submit
 * sends and then clears), and while its session takes no input: a subagent
 * session, or one waiting on a permission or a question, shows no message box.
 */
export function composerTakes(input: { dirty: boolean; context: readonly { comment?: string }[]; open: boolean }) {
  return input.open && !input.dirty && !input.context.some((item) => item.comment?.trim())
}

/**
 * Whether a composer still holds exactly the prompt handed to it. Only then is
 * it sent: never a composer the user has changed since, and never an empty
 * one, which a submit treats as Stop for a running turn.
 */
export function holdsHandoff(prompt: readonly { type: string; content?: string }[], text: string) {
  if (!text.trim()) return false
  if (prompt.some((part) => part.type !== "text")) return false
  return prompt.map((part) => part.content ?? "").join("") === text
}

export const DATABASE_SETUP_PROMPT =
  "Set up the database for this project with Vector Cloud. Run vector_cloud database_status first. If a database is connected, prepare it (prepare_database, or prepare_auth when this needs sign-in) and continue. If none is connected, ask me whether to use a Supabase project I already have or create a new one. If I choose one I have, find it with supabase_projects and link it with link_database (I can also link it in Vector Cloud > Database). If I choose a new one, run create_database. Vector asks me to confirm before it links or creates anything."

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
 * Whether a failed publish got as far as its checks or the deploy, so the
 * project has something for Fix this deploy to fix. A publish refused before
 * it ran (one already running, no project open, hosting not set up) does not.
 */
export function publishRan(result: { checks?: readonly unknown[]; log?: string }) {
  return Boolean(result.checks?.length || result.log?.trim())
}

/** The evidence a recorded release carries: its failed checks, and the end of its log. */
export function deploymentEvidence(deployment: CloudDeployment): DeployEvidence {
  return {
    project: deployment.name,
    environment: deployment.environment,
    url: deployment.productionUrl ?? deployment.url,
    git: deployment.git && {
      branch: deployment.git.branch,
      commit: deployment.git.commitShort,
      dirty: deployment.git.dirty,
    },
    checks: deployment.checks,
    log: deployment.runtimeLog ?? deployment.log,
  }
}

/**
 * A failed publish that left no release behind (a failed build, a rejected
 * deploy), when it is newer than the latest release.
 */
export function currentFailure(overview: CloudOverview) {
  const failure = overview.failure
  if (!failure) return
  if (overview.latest && failure.at <= overview.latest.createdAt) return
  return failure
}

/**
 * The warning shown before a publish from a folder with uncommitted changes:
 * a release is built from the files on disk, so it includes them.
 */
export function uncommittedNote(git?: { branch: string; commit: string; dirty: boolean }) {
  if (!git?.dirty) return
  return `This folder has uncommitted changes. It is built from the files as they are on disk, not from ${git.branch} at ${git.commit}.`
}

/**
 * The preview's publish sheet after a failed Promote. The preview did publish
 * and is still live, so the sheet keeps its link and Promote can be tried
 * again. The note carries the last line of what Vercel said: the whole log
 * would crowd the sheet.
 */
export function promoteFailed<T extends { promote?: "confirm" | "working" }>(
  done: T,
  error: unknown,
): Omit<T, "promote"> & { promote?: undefined; promoteError: string } {
  const said =
    error instanceof Error
      ? error.message
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1)
      : undefined
  return { ...done, promote: undefined, promoteError: said || "Vercel did not promote the preview." }
}

export type PublishPlan =
  | { ready: true; project: string; account?: string }
  /** `connect` is true when Vector Cloud > Connections is where it gets fixed. */
  | { ready: false; reason: string; connect: boolean }

/**
 * Where a preview would go, or what has to be set up first. Publishing needs
 * what the agent's publish needs too: the Vercel account connected in Vector
 * Cloud with an access token, a Vercel project linked to this project, and a
 * machine that can run the deploy.
 */
export function publishPlan(hosting: CloudOverview["hosting"], target?: PublishTarget): PublishPlan {
  if (!hosting.connected) {
    return { ready: false, reason: "Connect Vercel in Vector Cloud > Connections with an access token.", connect: true }
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

export type CloudStatus = { tone: "success" | "warning" | "error" | "idle"; label: string }

/** One line for the session's Cloud button: the state that most needs attention. */
export function cloudStatus(overview?: CloudOverview): CloudStatus {
  if (!overview) return { tone: "idle", label: "Checking Vector Cloud" }
  const latest = overview.latest
  if (currentFailure(overview)) return { tone: "error", label: "Last publish failed" }
  if (latest?.failedChecks.length) return { tone: "error", label: "Latest release failed its checks" }
  if (overview.production?.status === "unreachable") return { tone: "error", label: "Production is unreachable" }
  if (overview.production?.status === "degraded") return { tone: "warning", label: "Production is degraded" }
  if (overview.production) return { tone: "success", label: "Live in production" }
  if (latest) return { tone: "success", label: "Preview published" }
  if (overview.hosting.connected && !overview.hosting.project) {
    return { tone: "warning", label: "Link a Vercel project to publish" }
  }
  return { tone: "idle", label: "Not published yet" }
}
