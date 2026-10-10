import type { IpcRenderer } from "electron"
import type { VercelCloudApi } from "../main/cloud-vercel-ipc"

// window.api.cloud.vercel: one invoke per control registered by
// registerVercelIpc in the main process.
const NAMES = [
  "status",
  "scopes",
  "selectScope",
  "projects",
  "createProject",
  "link",
  "unlink",
  "updateSettings",
  "enableBypass",
  "deployments",
  "inspect",
  "logs",
  "cancel",
  "redeploy",
  "promote",
  "rollback",
  "env",
  "envSet",
  "envRemove",
  "envDiff",
  "envPlan",
  "envApply",
  "envPullPlan",
  "envPull",
  "domains",
  "domainAdd",
  "domainVerify",
  "domainRemove",
] as const satisfies readonly (keyof VercelCloudApi)[]

// Fails to compile when the main process gains a control this list lacks.
const complete: Exclude<keyof VercelCloudApi, (typeof NAMES)[number]> extends never ? true : false = true

export function vercelPreloadApi(ipcRenderer: IpcRenderer): VercelCloudApi {
  if (!complete) throw new Error("The Vercel preload API is incomplete.")
  return Object.fromEntries(
    NAMES.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke(`cloud-vercel-${name}`, ...args)]),
  ) as VercelCloudApi
}
