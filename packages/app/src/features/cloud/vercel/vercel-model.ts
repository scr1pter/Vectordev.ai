import type { CloudDeployment, PublishResult } from "../cloud-api"
import type { VercelDeployment, VercelEnvTargetState, VercelProjectSettings, VercelRemoteEnv } from "./vercel-api"

// What the Vercel screens show and offer, kept apart from the components so
// the rules can be tested without a renderer.

const RUNNING = ["QUEUED", "INITIALIZING", "BUILDING"]

export function deploymentTone(deployment: Pick<VercelDeployment, "state">) {
  if (deployment.state === "READY") return "success" as const
  if (deployment.state === "ERROR") return "error" as const
  if (RUNNING.includes(deployment.state)) return "warning" as const
  return undefined
}

export type DeploymentAction = "cancel" | "redeploy" | "promote" | "rollback"

// Vercel promotes a production build made after the current one (a staged
// release) and rolls back to one made before it. A preview cannot be pointed
// at production: it was built with preview variables.
export function deploymentActions(
  deployment: VercelDeployment,
  current: VercelDeployment | undefined,
  release?: Pick<CloudDeployment, "checks">,
): DeploymentAction[] {
  if (RUNNING.includes(deployment.state)) return ["cancel"]
  if (deployment.state !== "READY") return ["redeploy"]
  const failedChecks = release?.checks.some((check) => check.required && check.status === "failed") ?? false
  if (deployment.target !== "production" || deployment.current || failedChecks) return ["redeploy"]
  const later = !current || deployment.createdAt > current.createdAt
  return ["redeploy", later ? "promote" : "rollback"]
}

export function matchRelease(deployment: VercelDeployment, releases: CloudDeployment[]) {
  const url = normalizedUrl(deployment.url)
  return releases.find(
    (release) => release.providerDeploymentId === deployment.id || normalizedUrl(release.url) === url,
  )
}

function normalizedUrl(value: string) {
  return URL.canParse(value) ? new URL(value).host : value
}

export function envStateLabel(state: VercelEnvTargetState) {
  if (state === "same") return "Same"
  if (state === "different") return "Different"
  if (state === "missing_remote") return "Missing on Vercel"
  if (state === "remote_only") return "Only on Vercel"
  if (state === "unknown") return "Set (not readable)"
  return "—"
}

export function envStateTone(state: VercelEnvTargetState) {
  if (state === "same") return "success" as const
  if (state === "different" || state === "missing_remote") return "warning" as const
  return undefined
}

// One row per variable name; each Vercel entry keeps its own targets.
export function groupRemoteEnv(variables: VercelRemoteEnv[]) {
  const groups = new Map<string, VercelRemoteEnv[]>()
  for (const variable of variables) groups.set(variable.key, [...(groups.get(variable.key) ?? []), variable])
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => ({ key, entries }))
}

// The repository folder's name, made acceptable as a Vercel project name.
export function suggestedProjectName(projectPath: string) {
  const folder = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "app"
  return (
    folder
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{3,}/g, "--")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 100) || "app"
  )
}

// Vercel's framework identifiers for what Vector's build detection names.
export function vercelFramework(detected?: string) {
  const known: Record<string, string> = {
    "Next.js": "nextjs",
    Nuxt: "nuxtjs",
    SvelteKit: "sveltekit",
    Astro: "astro",
    Remix: "remix",
    Vite: "vite",
    "Create React App": "create-react-app",
  }
  return detected ? (known[detected] ?? "") : ""
}

export function domainStatusLabel(status: "ready" | "needs_verification" | "needs_dns") {
  if (status === "ready") return "Ready"
  if (status === "needs_verification") return "Verify ownership"
  return "Set DNS"
}

export function domainStatusTone(status: "ready" | "needs_verification" | "needs_dns") {
  return status === "ready" ? ("success" as const) : ("warning" as const)
}

export type VercelSettingsDraft = Record<keyof VercelProjectSettings, string>

export function settingsDraft(settings: VercelProjectSettings): VercelSettingsDraft {
  return {
    framework: settings.framework ?? "",
    rootDirectory: settings.rootDirectory ?? "",
    buildCommand: settings.buildCommand ?? "",
    outputDirectory: settings.outputDirectory ?? "",
    installCommand: settings.installCommand ?? "",
    nodeVersion: settings.nodeVersion ?? "",
  }
}

// Only the fields the user changed go to Vercel. An emptied field becomes ""
// so the desktop returns it to Vercel's automatic detection; Node.js has no
// automatic value, so an empty version is never sent.
export function settingsPatch(settings: VercelProjectSettings, draft: VercelSettingsDraft) {
  const current = settingsDraft(settings)
  return Object.fromEntries(
    (Object.keys(draft) as (keyof VercelSettingsDraft)[]).flatMap((key) => {
      const value = draft[key].trim()
      if (value === current[key].trim()) return []
      if (key === "nodeVersion" && !value) return []
      return [[key, value]]
    }),
  ) as Partial<VercelSettingsDraft>
}

// What Cloud Services says after a publish: where it went, whether production
// moved, and why Vector's checks could not open a protected deployment.
export function publishOutcome(result: PublishResult, workspaceName?: string) {
  if (!result.ok || !result.url) {
    return { tone: "error" as const, text: result.error ?? "Publish failed before Vercel returned a deployment." }
  }
  const production = result.environment === "production"
  return {
    tone: "success" as const,
    text: [
      `${production ? "Production release" : workspaceName ? `Preview of ${workspaceName}` : "Preview"} live at ${result.url}.`,
      production ? "" : "Production did not change.",
      result.protectedChecks === "skipped"
        ? "Deployment Protection kept Vector's checks out of this preview; let them through in Project settings."
        : "",
      result.protectedChecks === "checked-after-promotion"
        ? "Deployment Protection kept Vector's checks out of the build, so production was checked after promotion."
        : "",
      ...(result.notes ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  }
}
