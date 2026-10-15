import { redactCloudLog } from "./cloud-console"
import {
  cancelVercelDeployment,
  listVercelDeployments,
  promoteVercelDeployment,
  redeployVercelDeployment,
  rollbackVercelDeployment,
  vercelBuildLogs,
  vercelRuntimeLogs,
} from "./cloud-vercel-deployments"
import { addVercelDomain, listVercelDomains, removeVercelDomain, verifyVercelDomain } from "./cloud-vercel-domains"
import {
  applyVercelEnvPull,
  applyVercelEnvSync,
  diffVercelEnv,
  listVercelEnv,
  planVercelEnvPull,
  planVercelEnvSync,
  removeVercelEnv,
  setVercelEnv,
  type VercelEnvTarget,
  type VercelEnvType,
} from "./cloud-vercel-env"
import {
  createVercelProject,
  enableVercelProtectionBypass,
  linkVercelProject,
  listVercelProjects,
  listVercelScopes,
  selectVercelScope,
  unlinkVercelProject,
  updateVercelProjectSettings,
  vercelProjectStatus,
  type VercelProjectSettings,
} from "./cloud-vercel-projects"

// The Cloud screens' Vercel controls (window.api.cloud.vercel). Each one
// calls the same module the agent's vector_cloud actions do.

export const vercelIpc = {
  status: (projectPath: string) => vercelProjectStatus(projectPath),
  scopes: () => listVercelScopes(),
  selectScope: (teamId: string | null) => selectVercelScope(teamId),
  projects: (teamId: string | null) => listVercelProjects(teamId),
  createProject: (
    projectPath: string,
    input: { name: string; framework?: string; rootDirectory?: string; teamId: string | null },
  ) => createVercelProject(projectPath, input),
  link: (projectPath: string, projectId: string, teamId: string | null) =>
    linkVercelProject(projectPath, projectId, teamId),
  unlink: (projectPath: string) => unlinkVercelProject(projectPath),
  updateSettings: (projectPath: string, patch: Partial<Record<keyof VercelProjectSettings, string>>) =>
    updateVercelProjectSettings(projectPath, patch),
  enableBypass: (projectPath: string) => enableVercelProtectionBypass(projectPath),
  deployments: (projectPath: string, limit?: number) => listVercelDeployments(projectPath, { limit }),
  logs: async (projectPath: string, id: string, source: "build" | "runtime", limit = 200) => {
    const result =
      source === "runtime"
        ? await vercelRuntimeLogs(projectPath, id, limit)
        : await vercelBuildLogs(projectPath, id, limit)
    const lines = result.entries
      .toSorted((left, right) => (left.at ?? 0) - (right.at ?? 0))
      .map((entry) => `${entry.at ? `${new Date(entry.at).toISOString()} ` : ""}${entry.text}`)
      .join("\n")
    return {
      deployment: result.deployment,
      source,
      log: redactCloudLog(projectPath, undefined, lines, [result.token]),
      fetchedAt: new Date().toISOString(),
    }
  },
  cancel: (projectPath: string, id: string) => cancelVercelDeployment(projectPath, id),
  redeploy: (projectPath: string, id: string) => redeployVercelDeployment(projectPath, id),
  promote: (projectPath: string, id: string) => promoteVercelDeployment(projectPath, id),
  rollback: (projectPath: string, id?: string) => rollbackVercelDeployment(projectPath, id),
  env: (projectPath: string) => listVercelEnv(projectPath),
  envSet: (
    projectPath: string,
    input: { key: string; value: string; targets: VercelEnvTarget[]; gitBranch?: string; type?: VercelEnvType },
  ) => setVercelEnv(projectPath, input),
  envRemove: (projectPath: string, input: { key: string; targets?: VercelEnvTarget[]; gitBranch?: string }) =>
    removeVercelEnv(projectPath, input),
  envDiff: (projectPath: string) => diffVercelEnv(projectPath),
  envPlan: (projectPath: string, targets: VercelEnvTarget[]) => planVercelEnvSync(projectPath, targets),
  envApply: (projectPath: string, targets: VercelEnvTarget[], planId: string) =>
    applyVercelEnvSync(projectPath, targets, planId),
  envPullPlan: (projectPath: string) => planVercelEnvPull(projectPath),
  envPull: (projectPath: string, planId: string) => applyVercelEnvPull(projectPath, planId),
  domains: (projectPath: string) => listVercelDomains(projectPath),
  domainAdd: (projectPath: string, domain: string) => addVercelDomain(projectPath, domain),
  domainVerify: (projectPath: string, domain: string) => verifyVercelDomain(projectPath, domain),
  domainRemove: (projectPath: string, domain: string) => removeVercelDomain(projectPath, domain),
}

type VercelIpc = typeof vercelIpc

export type VercelCloudApi = {
  [Name in keyof VercelIpc]: (...args: Parameters<VercelIpc[Name]>) => Promise<Awaited<ReturnType<VercelIpc[Name]>>>
}

export const VERCEL_IPC_PREFIX = "cloud-vercel-"
