import { getDatabase, listDeployments, type CloudDeployment } from "./cloud-console"
import { cachedCloudProviderConnection, getCloudProviderProjectLink } from "./cloud-connections"
import { resolveCloudScope, type CloudWorkspace } from "./cloud-scope"
import { readGitMetadata, type PublishResult } from "./publish"
import { getStore } from "./store"

// The live summary behind the session's Cloud card: everything here is read
// locally, so the card can refresh on every change without calling a provider.

// The stores every cloud screen reads. Deployments, health checks, environment,
// database, build settings, provider connections and project links all live in
// one of them, whether the Cloud screens or the agent changed them.
const CLOUD_STORES = ["cloud-deployments", "cloud-projects", "cloud-provider-connections", "cloud-provider-links"]

// Evidence from a publish is bounded so a failed attempt stays cheap to hold
// and to send to the renderer; the end of a log is where the error is.
const EVIDENCE_CHARS = 8_000

export type CloudPublishFailure = {
  at: string
  environment: "preview" | "production"
  error: string
  checks: { label: string; status: string; required: boolean; details?: string; output?: string }[]
  log?: string
}

const failures = new Map<string, CloudPublishFailure>()
const watched = new Map<string, { store: unknown; stop: () => void }>()
let notify: (() => void) | undefined
let pending: ReturnType<typeof setTimeout> | undefined

/**
 * Calls `callback` (debounced) whenever cloud state changes, from any screen or
 * from the agent. Returns a function that stops watching.
 */
export function watchCloudChanges(callback: () => void) {
  notify = callback
  watchStores()
  return () => {
    notify = undefined
    clearTimeout(pending)
    watched.forEach((entry) => entry.stop())
    watched.clear()
  }
}

export async function cloudOverview(directory: string, workspaces: CloudWorkspace[] = []) {
  watchStores()
  const scope = await resolveCloudScope(directory, workspaces)
  const vercel = cachedCloudProviderConnection("vercel")
  const supabase = cachedCloudProviderConnection("supabase")
  const link = getCloudProviderProjectLink(scope.projectPath, undefined, "vercel")
  const database = getDatabase(scope.projectPath)
  const deployments = listDeployments(scope.projectPath)
  const production = deployments.find((item) => item.releaseStatus === "current")
  const git = await readGitMetadata(scope.directory)
  return {
    projectPath: scope.projectPath,
    directory: scope.directory,
    workspace: scope.workspace,
    hosting: {
      provider: "Vercel" as const,
      connected: vercel.connected,
      account: vercel.account,
      project: link ? { id: link.projectId, name: link.projectName } : undefined,
    },
    database: {
      provider: "Supabase" as const,
      accountConnected: supabase.connected,
      account: supabase.account,
      connected: Boolean(database),
      name: database ? (database.projectName ?? database.projectRef ?? new URL(database.url).hostname) : undefined,
    },
    latest: deployments[0] ? summarize(deployments[0]) : undefined,
    production: production ? summarize(production) : undefined,
    failure: failures.get(scope.projectPath),
    git: git ? { branch: git.branch, commit: git.commitShort, dirty: git.dirty } : undefined,
  }
}

export type CloudOverview = Awaited<ReturnType<typeof cloudOverview>>

/**
 * Remembers the last publish that failed before Vector recorded a deployment
 * (a failed build, a rejected deploy), so the session's Cloud card can offer to
 * fix it. A publish that produced a deployment is tracked by that record.
 */
export function recordPublishAttempt(projectPath: string, production: boolean, result: PublishResult) {
  if (result.ok || result.deploymentId) {
    failures.delete(projectPath)
    changed()
    return
  }
  failures.set(projectPath, {
    at: new Date().toISOString(),
    environment: production ? "production" : "preview",
    error: result.error ?? "The publish did not complete.",
    checks: (result.checks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => ({
        label: check.label,
        status: check.status,
        required: check.required,
        details: check.details,
        output: check.output?.slice(-EVIDENCE_CHARS),
      })),
    log: result.log ? result.log.slice(-EVIDENCE_CHARS) : undefined,
  })
  changed()
}

function summarize(deployment: CloudDeployment) {
  return {
    id: deployment.id,
    url: deployment.productionUrl ?? deployment.url,
    environment: deployment.environment,
    releaseStatus: deployment.releaseStatus,
    status: deployment.status,
    createdAt: deployment.createdAt,
    workspaceName: deployment.workspaceName,
    failedChecks: deployment.checks
      .filter((check) => check.required && check.status === "failed")
      .map((check) => ({ label: check.label, details: check.details })),
  }
}

// A store whose file was removed when it emptied (a disconnect) is recreated on
// its next use, so every overview read re-checks that the live instance is the
// one being watched.
function watchStores() {
  if (!notify) return
  CLOUD_STORES.forEach((name) => {
    const store = getStore(name)
    if (watched.get(name)?.store === store) return
    watched.get(name)?.stop()
    watched.set(name, { store, stop: store.onDidAnyChange(changed) })
  })
}

function changed() {
  clearTimeout(pending)
  pending = setTimeout(() => notify?.(), 150)
}
