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
  checks: CloudDeploymentCheck[]
  git?: CloudGitMetadata
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

export type CloudDomainStatus = "pending" | "verified" | "error"
export type CloudDomainProvider = "vercel"

export type CloudDomain = {
  id: string
  domain: string
  projectPath?: string
  provider: CloudDomainProvider
  providerProjectId?: string
  providerProjectName?: string
  cnameTarget: string
  status: CloudDomainStatus
  lastCheckedAt?: string
  detail?: string
  createdAt: string
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
  url?: string
  linkedAt: string
}

export type CloudProviderSyncResult = {
  provider: "vercel"
  projectId: string
  projectName: string
  changed: number
  syncedAt: string
  detail: string
}

export type CloudSupabaseBucket = {
  id: string
  name: string
  public: boolean
  createdAt?: string
  updatedAt?: string
}

export type CloudSupabaseFunction = {
  id: string
  name: string
  slug: string
  status?: string
  version?: number
  createdAt?: string
  updatedAt?: string
}

export type CloudSupabaseServices = {
  connected: boolean
  projectRef?: string
  projectName?: string
  region?: string
  dashboardUrl?: string
  detail?: string
  storage: { available: boolean; buckets: CloudSupabaseBucket[]; detail?: string }
  functions: { available: boolean; functions: CloudSupabaseFunction[]; detail?: string }
}

export type CloudApi = {
  connections: {
    list: () => Promise<CloudProviderConnection[]>
    connect: (provider: CloudProviderId) => Promise<CloudProviderConnection>
    connectWithToken: (provider: CloudProviderId, token: string) => Promise<CloudProviderConnection>
    disconnect: (provider: CloudProviderId) => Promise<void>
  }
  providers: {
    resources: (provider: CloudProviderId) => Promise<CloudProviderResource[]>
    links: (projectPath: string, taskId?: string) => Promise<CloudProviderProjectLink[]>
    link: (
      projectPath: string,
      taskId: string | undefined,
      provider: "vercel",
      projectId: string,
    ) => Promise<CloudProviderProjectLink>
    unlink: (projectPath: string, taskId: string | undefined, provider: "vercel") => Promise<CloudProviderProjectLink[]>
    syncEnvironment: (
      projectPath: string,
      taskId: string | undefined,
      provider: "vercel",
    ) => Promise<CloudProviderSyncResult>
    addDomain: (
      projectPath: string,
      taskId: string | undefined,
      provider: "vercel",
      domain: string,
    ) => Promise<CloudDomain>
    verifyDomain: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDomain>
    removeDomain: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDomain[]>
  }
  deployments: {
    list: (projectPath: string, taskId?: string) => Promise<CloudDeployment[]>
    remove: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment[]>
    check: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
    checkAll: (projectPath: string, taskId?: string) => Promise<CloudDeployment[]>
    promote: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
    rollback: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
    logs: (
      projectPath: string,
      taskId: string | undefined,
      id: string,
    ) => Promise<{ log: string; fetchedAt: string; source: "provider" | "build" }>
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
    apply: (projectPath: string, taskId?: string) => Promise<{ written: string }>
  }
  domains: {
    list: (projectPath: string, taskId?: string) => Promise<CloudDomain[]>
  }
  database: {
    get: (projectPath: string, taskId?: string) => Promise<CloudDatabaseConnection>
    connect: (
      projectPath: string,
      taskId: string | undefined,
      input: {
        provider: "supabase"
        url: string
        anonKey: string
        projectRef?: string
        projectName?: string
        managedByOAuth?: boolean
      },
    ) => Promise<CloudDatabaseConnection>
    connectProject: (
      projectPath: string,
      taskId: string | undefined,
      projectRef: string,
    ) => Promise<CloudDatabaseConnection>
    disconnect: (projectPath: string, taskId?: string) => Promise<void>
  }
  services: {
    supabase: (projectPath: string, taskId?: string) => Promise<CloudSupabaseServices>
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
}

export type PublishResult = {
  ok: boolean
  url?: string
  target: string
  log: string
  error?: string
  deploymentId?: string
  checks?: CloudDeploymentCheck[]
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
}

type CloudAgentWorkspaceApi = {
  list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<CloudAgentWorkspace[]>
}

export function cloudAgentWorkspaceApi(): CloudAgentWorkspaceApi | undefined {
  return (
    globalThis.window?.api as (Record<string, unknown> & { parallelWorkspaces?: CloudAgentWorkspaceApi }) | undefined
  )?.parallelWorkspaces
}
