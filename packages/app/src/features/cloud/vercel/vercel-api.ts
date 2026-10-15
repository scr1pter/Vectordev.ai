// Renderer side of window.api.cloud.vercel (packages/desktop/src/preload/cloud-vercel.ts).
// The desktop holds the Vercel token; nothing here ever receives it, and the
// environment calls return names and targets, never remote values.

export type VercelScope = { teamId?: string; slug: string; name: string; kind: "personal" | "team" }

export type VercelProjectSummary = {
  id: string
  name: string
  accountId?: string
  framework?: string
  productionUrl?: string
  updatedAt?: string
}

export type VercelProjectLink = {
  provider: "vercel"
  projectId: string
  projectName: string
  accountId?: string
  teamId?: string
  url?: string
  linkedFrom?: string
  linkedAt: string
}

export type VercelProjectSettings = {
  framework: string | null
  rootDirectory: string | null
  buildCommand: string | null
  outputDirectory: string | null
  installCommand: string | null
  nodeVersion: string | null
}

export type VercelProjectDetails = {
  id: string
  name: string
  accountId?: string
  settings: VercelProjectSettings
  protection: { vercelAuthentication: string | null; passwordProtection: boolean; bypassReady: boolean }
  productionUrl?: string
  productionDeploymentId?: string
  gitRepository?: string
}

export type VercelProjectStatus = {
  connected: boolean
  account?: string
  link?: VercelProjectLink
  /** The project a .vercel/project.json names, when nothing is linked yet. */
  candidate?: { projectId: string; teamId?: string }
  project?: VercelProjectDetails
  error?: string
}

export type VercelDeploymentState =
  | "QUEUED"
  | "INITIALIZING"
  | "BUILDING"
  | "READY"
  | "ERROR"
  | "CANCELED"
  | "BLOCKED"
  | "DELETED"
  | "UNKNOWN"

export type VercelDeployment = {
  id: string
  url: string
  name: string
  state: VercelDeploymentState
  target: "production" | "preview"
  createdAt: string
  current: boolean
  /** STAGED never served production (built with --skip-domain, not promoted); PROMOTED has. */
  substate?: "STAGED" | "ROLLING" | "PROMOTED"
  source?: string
  branch?: string
  commitSha?: string
  commitMessage?: string
  creator?: string
  errorMessage?: string
  aliases: string[]
}

export type VercelEnvTarget = "production" | "preview" | "development"

export type VercelRemoteEnv = {
  id: string
  key: string
  type: string
  targets: VercelEnvTarget[]
  gitBranch?: string
  comment?: string
  syncedByVector: boolean
  updatedAt?: string
}

export type VercelEnvTargetState = "same" | "different" | "missing_remote" | "remote_only" | "unknown" | "absent"

export type VercelEnvDiffRow = {
  key: string
  local: boolean
  targets: Record<VercelEnvTarget, VercelEnvTargetState>
  branchOverrides: string[]
}

export type VercelEnvPlan = {
  id: string
  project: string
  targets: VercelEnvTarget[]
  changes: { action: "create" | "update" | "delete"; key: string; targets: VercelEnvTarget[] }[]
  skipped: { key: string; targets: VercelEnvTarget[]; reason: string }[]
  unchanged: number
}

export type VercelEnvPullPlan = {
  id: string
  project: string
  variables: { key: string; action: "add" | "overwrite" | "unchanged" }[]
  skipped: { key: string; reason: string }[]
}

export type VercelDnsRecord = {
  type: "A" | "CNAME" | "TXT"
  name: string
  value: string
  purpose: "routing" | "verification"
}

export type VercelDomain = {
  name: string
  apex: boolean
  verified: boolean
  configured: boolean
  status: "ready" | "needs_verification" | "needs_dns"
  records: VercelDnsRecord[]
  certificate?: { status: "issued"; expiresAt: string; issuer?: string } | { status: "pending"; detail: string }
  redirect?: string
  gitBranch?: string
  detail: string
}

export type VercelApi = {
  status: (projectPath: string) => Promise<VercelProjectStatus>
  scopes: () => Promise<{ scopes: VercelScope[]; selected?: string }>
  selectScope: (teamId: string | null) => Promise<{ scopes: VercelScope[]; selected?: string }>
  projects: (teamId: string | null) => Promise<VercelProjectSummary[]>
  createProject: (
    projectPath: string,
    input: { name: string; framework?: string; rootDirectory?: string; teamId: string | null },
  ) => Promise<VercelProjectLink>
  link: (projectPath: string, projectId: string, teamId: string | null) => Promise<VercelProjectLink>
  unlink: (projectPath: string) => Promise<{ unlinked: boolean }>
  updateSettings: (
    projectPath: string,
    patch: Partial<Record<keyof VercelProjectSettings, string>>,
  ) => Promise<VercelProjectDetails>
  enableBypass: (projectPath: string) => Promise<{ enabled: boolean; project: string }>
  deployments: (projectPath: string, limit?: number) => Promise<VercelDeployment[]>
  logs: (
    projectPath: string,
    id: string,
    source: "build" | "runtime",
    limit?: number,
  ) => Promise<{ deployment: VercelDeployment; source: "build" | "runtime"; log: string; fetchedAt: string }>
  cancel: (projectPath: string, id: string) => Promise<VercelDeployment>
  redeploy: (projectPath: string, id: string) => Promise<{ from: VercelDeployment; deployment: VercelDeployment }>
  promote: (projectPath: string, id: string) => Promise<{ deployment: VercelDeployment; productionUrl?: string }>
  rollback: (
    projectPath: string,
    id?: string,
  ) => Promise<{ deployment: VercelDeployment; replaced?: string; productionUrl?: string }>
  env: (projectPath: string) => Promise<{ project: string; variables: VercelRemoteEnv[] }>
  envSet: (
    projectPath: string,
    input: {
      key: string
      value: string
      targets: VercelEnvTarget[]
      gitBranch?: string
      type?: "encrypted" | "sensitive"
    },
  ) => Promise<{ key: string; targets: VercelEnvTarget[]; action: "created" | "updated"; project: string }>
  envRemove: (
    projectPath: string,
    input: { key: string; targets?: VercelEnvTarget[]; gitBranch?: string },
  ) => Promise<{ key: string; removed: number; project: string }>
  envDiff: (projectPath: string) => Promise<{ project: string; rows: VercelEnvDiffRow[] }>
  envPlan: (projectPath: string, targets: VercelEnvTarget[]) => Promise<VercelEnvPlan>
  envApply: (
    projectPath: string,
    targets: VercelEnvTarget[],
    planId: string,
  ) => Promise<VercelEnvPlan & { applied: number; nextStep: string }>
  envPullPlan: (projectPath: string) => Promise<VercelEnvPullPlan>
  envPull: (projectPath: string, planId: string) => Promise<{ project: string; written: string; keys: string[] }>
  domains: (projectPath: string) => Promise<{ project: string; domains: VercelDomain[] }>
  domainAdd: (projectPath: string, domain: string) => Promise<{ project: string; domain: VercelDomain }>
  domainVerify: (projectPath: string, domain: string) => Promise<{ project: string; domain: VercelDomain }>
  domainRemove: (projectPath: string, domain: string) => Promise<{ project: string; removed: string }>
}

export function vercelApi(): VercelApi | undefined {
  const api = globalThis.window?.api as (Record<string, unknown> & { cloud?: { vercel?: VercelApi } }) | undefined
  return api?.cloud?.vercel
}

// Electron prefixes a rejected invoke with "Error invoking remote method …:
// Error:"; the user only needs Vercel's or Vector's own sentence.
export function vercelErrorText(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "").trim() || fallback
}

export const VERCEL_ENV_TARGETS: VercelEnvTarget[] = ["production", "preview", "development"]

// Vercel turned Node.js 18 off in 2025 and Node.js 20 on October 1, 2026.
export const VERCEL_NODE_VERSIONS = ["24.x", "22.x"]
