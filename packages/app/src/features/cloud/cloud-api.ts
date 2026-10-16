// Renderer-side handle for the desktop Vector Cloud backend. Everything here
// is real: deployments, .env writes, live DNS domain verification, and the
// Supabase connector. The web build has no window.api, so the console shows a
// "runs in Vector Desktop" state instead.

export type CloudDeployment = {
  id: string
  slug: string
  url: string
  productionUrl?: string
  name: string
  projectPath: string
  taskId?: string
  deploymentPath?: string
  workspaceId?: string
  workspaceName?: string
  target: string
  createdAt: string
  environment: "preview" | "production"
  releaseStatus: "preview" | "current" | "superseded" | "rolled-back"
  status: "ready" | "degraded" | "unreachable" | "unknown"
  log?: string
  runtimeLog?: string
  runtimeLogFetchedAt?: string
  durationMs?: number
  promotedAt?: string
  rolledBackAt?: string
  lastCheckedAt?: string
  statusCode?: number
  latencyMs?: number
  healthError?: string
  /** How the last health probe ended; "protected" means Deployment Protection kept Vector out. */
  probe?: "ok" | "failed" | "protected"
  checks: CloudDeploymentCheck[]
  git?: CloudGitMetadata
  /** Vercel's own id (dpl_...) for this release. */
  providerDeploymentId?: string
  /** The stable per-branch preview address of an agent workspace's release. */
  alias?: string
}

// "public" values may reach browser code; "server" values never use a name a
// bundler inlines into the client.
export type CloudEnvVisibility = "public" | "server"
export type CloudEnvVar = { key: string; value: string; visibility: CloudEnvVisibility }

export type CloudDeploymentCheck = {
  id: string
  type: "install" | "test" | "build" | "secrets" | "health" | "browser"
  label: string
  status: "pending" | "running" | "passed" | "warning" | "failed" | "skipped"
  required: boolean
  details?: string
  output?: string
  durationMs?: number
  checkedAt: string
  screenshotPath?: string
}

export type CloudGitMetadata = {
  branch: string
  commitSha: string
  commitShort: string
  commitMessage: string
  remoteUrl?: string
  dirty: boolean
}

export type CloudRequiredChecks = {
  test: boolean
  secrets: boolean
  health: boolean
  browser: boolean
}

export type CloudBuildSettings = {
  framework: string
  packageManager: "bun" | "pnpm" | "yarn" | "npm" | "static"
  installCommand: string
  testCommand: string
  buildCommand: string
  outputDirectory: string
  nodeVersion: string
  healthPath: string
  requiredChecks: CloudRequiredChecks
  source: "detected" | "custom"
  updatedAt: string
}

export type CloudDatabaseConnection = {
  provider: "supabase"
  url: string
  anonKey: string
  projectRef?: string
  projectName?: string
  managedByOAuth?: boolean
  connectedAt: string
} | null

export type CloudProviderId = "vercel" | "supabase"

export type CloudProviderConnection = {
  provider: CloudProviderId
  configured: boolean
  manualTokenSupported?: boolean
  connected: boolean
  account?: string
  accountId?: string
  connectedAt?: string
  detail: string
  callbackUrl?: string
}

export type CloudProviderResource = {
  provider: CloudProviderId
  id: string
  name: string
  accountId?: string
  accountName?: string
  url?: string
  region?: string
  status?: string
}

export type CloudProviderProjectLink = {
  provider: "vercel"
  projectId: string
  projectName: string
  accountId?: string
  accountName?: string
  teamId?: string
  url?: string
  linkedFrom?: string
  linkedAt: string
}

// The live summary behind the session's Cloud card. Names and states only:
// never a token, key or environment value.
export type CloudReleaseSummary = {
  id: string
  url: string
  environment: "preview" | "production"
  releaseStatus: CloudDeployment["releaseStatus"]
  status: CloudDeployment["status"]
  createdAt: string
  workspaceName?: string
  failedChecks: { label: string; details?: string }[]
}

export type CloudPublishFailure = {
  at: string
  environment: "preview" | "production"
  error: string
  checks: { label: string; status: string; required: boolean; details?: string; output?: string }[]
  log?: string
}

export type CloudOverview = {
  /** The main project every cloud record belongs to. */
  projectPath: string
  /** Where files are built and published from: an agent's worktree, or the project itself. */
  directory: string
  workspace?: { id: string; name: string }
  hosting: { provider: "Vercel"; connected: boolean; account?: string; project?: { id: string; name: string } }
  database: { provider: "Supabase"; accountConnected: boolean; account?: string; connected: boolean; name?: string }
  latest?: CloudReleaseSummary
  production?: CloudReleaseSummary
  failure?: CloudPublishFailure
  git?: { branch: string; commit: string; dirty: boolean }
}

export type CloudApi = {
  overview: (directory: string) => Promise<CloudOverview>
  onChange: (callback: () => void) => () => void
  connections: {
    list: () => Promise<CloudProviderConnection[]>
    connect: (provider: CloudProviderId) => Promise<CloudProviderConnection>
    connectWithToken: (provider: CloudProviderId, token: string) => Promise<CloudProviderConnection>
    disconnect: (provider: CloudProviderId) => Promise<{ revoked: boolean; detail: string }>
  }
  providers: {
    resources: (provider: CloudProviderId) => Promise<CloudProviderResource[]>
    links: (projectPath: string, taskId?: string) => Promise<CloudProviderProjectLink[]>
  }
  deployments: {
    list: (projectPath: string, taskId?: string) => Promise<CloudDeployment[]>
    remove: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment[]>
    check: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
    checkAll: (projectPath: string, taskId?: string) => Promise<CloudDeployment[]>
    rerunChecks: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
  }
  env: {
    list: (projectPath: string, taskId?: string) => Promise<CloudEnvVar[]>
    set: (
      projectPath: string,
      taskId: string | undefined,
      key: string,
      value: string,
      visibility?: CloudEnvVisibility,
    ) => Promise<CloudEnvVar[]>
    remove: (projectPath: string, taskId: string | undefined, key: string) => Promise<CloudEnvVar[]>
    apply: (projectPath: string, taskId?: string) => Promise<{ written: string; gitignoreUpdated: boolean }>
  }
  database: {
    get: (projectPath: string, taskId?: string) => Promise<CloudDatabaseConnection>
  }
  build: {
    get: (projectPath: string, taskId?: string) => Promise<CloudBuildSettings | null>
    detect: (projectPath: string, taskId?: string) => Promise<CloudBuildSettings>
    set: (
      projectPath: string,
      taskId: string | undefined,
      input: Omit<CloudBuildSettings, "source" | "updatedAt">,
    ) => Promise<CloudBuildSettings>
  }
}

export function cloudApi(): CloudApi | undefined {
  return (globalThis.window?.api as (Record<string, unknown> & { cloud?: CloudApi }) | undefined)?.cloud
}

// Publishing runs through the user's own Vercel account. Exposed as
// window.api.publish by the desktop main.
export type PublishTargetId = "vercel"

export type PublishTarget = {
  id: PublishTargetId
  label: string
  loginHint: string
  available: boolean
  account?: string
  /** What stops publishing on this machine. */
  problem?: "no_node" | "not_connected"
}

export type PublishResult = {
  ok: boolean
  url?: string
  target: string
  log: string
  error?: string
  errorCode?: string
  deploymentId?: string
  providerDeploymentId?: string
  environment?: "preview" | "production"
  productionUrl?: string
  alias?: string
  checks?: CloudDeploymentCheck[]
  protectedChecks?: "skipped"
  notes?: string[]
}

export type PublishProgressEvent = {
  runId: string
  stage:
    | "preparing"
    | "installing"
    | "testing"
    | "building"
    | "uploading"
    | "checking"
    | "promoting"
    | "complete"
    | "failed"
  level: "info" | "success" | "warning" | "error"
  message: string
  at: string
}

export type PublishProjectInput = {
  projectPath: string
  taskId?: string
  scopeProjectPath?: string
  scopeTaskId?: string
  workspaceId?: string
  workspaceName?: string
  target: PublishTargetId
  production?: boolean
  runId?: string
}

export type PublishApi = {
  targets: () => Promise<PublishTarget[]>
  run: (input: PublishProjectInput) => Promise<PublishResult>
  subscribe: (cb: (event: PublishProgressEvent) => void) => () => void
}

export function publishApi(): PublishApi | undefined {
  return (globalThis.window?.api as (Record<string, unknown> & { publish?: PublishApi }) | undefined)?.publish
}

export type CloudAgentWorkspace = {
  id: string
  name: string
  taskPrompt: string
  sourcePath: string
  parentSessionId?: string
  isolatedPath: string
  gitBranch?: string
  status: string
  changedFilesCount: number
  lastAction: string
  /** The latest Vercel preview of this workspace, at its stable branch address when Vercel assigned one. */
  previewUrl?: string
}

type CloudAgentWorkspaceApi = {
  list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<CloudAgentWorkspace[]>
}

export function cloudAgentWorkspaceApi(): CloudAgentWorkspaceApi | undefined {
  return (
    globalThis.window?.api as (Record<string, unknown> & { parallelWorkspaces?: CloudAgentWorkspaceApi }) | undefined
  )?.parallelWorkspaces
}
