import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { DialogGithubPush } from "@/components/session-github-push"
import { DialogGitlabPush } from "@/components/session-gitlab-push"
import { Icon } from "@vectordevai/ui/icon"
import { useDialog } from "@vectordevai/ui/context/dialog"
import {
  cloudAgentWorkspaceApi,
  cloudApi,
  publishApi,
  type CloudAgentWorkspace,
  type CloudBuildSettings,
  type CloudDeployment,
  type CloudDomain,
  type CloudDatabaseConnection,
  type CloudProviderConnection,
  type CloudProviderId,
  type CloudProviderProjectLink,
  type CloudProviderResource,
  type CloudSupabaseServices,
  type PublishProgressEvent,
  type PublishTarget,
} from "./cloud-api"
import { cloudProviderConnectionMode, cloudProviderTokenGuide } from "./cloud-provider-token"
import { createCloudEnvironment } from "./cloud-environment"
import { deploymentEvidence, deployRepairPrompt } from "./cloud-handoff"
import "./cloud-console.css"

export type CloudSection =
  | "overview"
  | "connections"
  | "deployments"
  | "logs"
  | "observability"
  | "domains"
  | "environment"
  | "database"
  | "authentication"
  | "storage"
  | "functions"
  | "settings"
type Notice = { tone: "info" | "success" | "error"; text: string }
type BuildDraft = Omit<CloudBuildSettings, "source" | "updatedAt">

const SECTION_GROUPS: { label?: string; items: { id: CloudSection; label: string }[] }[] = [
  { items: [{ id: "overview", label: "Project overview" }] },
  {
    label: "Deploy & observe",
    items: [
      { id: "deployments", label: "Deployments" },
      { id: "logs", label: "Logs" },
      { id: "observability", label: "Observability" },
      { id: "domains", label: "Domains" },
      { id: "environment", label: "Environment variables" },
    ],
  },
  {
    label: "Data services",
    items: [
      { id: "database", label: "Database" },
      { id: "authentication", label: "Authentication" },
      { id: "storage", label: "Storage" },
      { id: "functions", label: "Edge functions" },
    ],
  },
  {
    label: "Setup",
    items: [
      { id: "connections", label: "Connections" },
      { id: "settings", label: "Project settings" },
    ],
  },
]

// Stroke icons for the nav and empty states — matches the shell's SVG icon
// language (viewBox 0 0 16 16, currentColor stroke) instead of glyph fonts.
function sectionIcon(id: CloudSection) {
  switch (id) {
    case "overview":
      return (
        <>
          <rect x="2.5" y="2.5" width="4.25" height="4.25" rx=".5" fill="none" stroke="currentColor" />
          <rect x="9.25" y="2.5" width="4.25" height="4.25" rx=".5" fill="none" stroke="currentColor" />
          <rect x="2.5" y="9.25" width="4.25" height="4.25" rx=".5" fill="none" stroke="currentColor" />
          <rect x="9.25" y="9.25" width="4.25" height="4.25" rx=".5" fill="none" stroke="currentColor" />
        </>
      )
    case "connections":
      return (
        <>
          <path
            d="M5.6 5.8 4.2 4.4m6.2 5.8 1.4 1.4M5 9.8l-1.2 1.2a2.1 2.1 0 0 0 3 3L8 12.8m3-6.6L12.2 5a2.1 2.1 0 0 0-3-3L8 3.2M5.7 10.3l4.6-4.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </>
      )
    case "deployments":
      return (
        <>
          <path
            d="M8 2.4c1.7 1.15 2.75 3.05 2.75 5.55 0 1.4-.35 2.75-1 3.9l-1.75-1-1.75 1c-.65-1.15-1-2.5-1-3.9 0-2.5 1.05-4.4 2.75-5.55Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linejoin="round"
          />
          <circle cx="8" cy="7.3" r="1.05" fill="none" stroke="currentColor" stroke-width="1.05" />
          <path
            d="M6.3 10.75 5 11.9l.35-1.95M9.7 10.75 11 11.9l-.35-1.95"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </>
      )
    case "logs":
      return (
        <>
          <path
            d="M3 3h10v10H3zM5.2 6.2l1.6 1.55-1.6 1.55M8.5 9.3h2.3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </>
      )
    case "domains":
      return (
        <>
          <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path
            d="M2.8 8h10.4M8 2.6c-3.2 3.4-3.2 7.4 0 10.8 3.2-3.4 3.2-7.4 0-10.8Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
          />
        </>
      )
    case "observability":
      return (
        <>
          <path
            d="M2.3 11.9h11.4M3.25 10.2l2.2-2.45 1.8 1.45 2.35-4.1 2.95 2.15"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="9.6" cy="5.1" r=".7" fill="currentColor" />
        </>
      )
    case "environment":
      return (
        <path
          d="M8 10.35A2.35 2.35 0 1 0 8 5.65a2.35 2.35 0 0 0 0 4.7Zm4.72-1.35a4.8 4.8 0 0 0 0-2l1.2-.92-1.2-2.08-1.42.58a5.1 5.1 0 0 0-1.72-1L9.4 2H6.6l-.18 1.58a5.1 5.1 0 0 0-1.72 1L3.28 4l-1.2 2.08 1.2.92a4.8 4.8 0 0 0 0 2l-1.2.92L3.28 12l1.42-.58a5.1 5.1 0 0 0 1.72 1L6.6 14h2.8l.18-1.58a5.1 5.1 0 0 0 1.72-1l1.42.58 1.2-2.08-1.2-.92Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.15"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      )
    case "database":
      return (
        <>
          <ellipse cx="8" cy="4.2" rx="4.15" ry="1.45" fill="none" stroke="currentColor" stroke-width="1.15" />
          <path
            d="M3.85 4.2v7.1c0 .8 1.85 1.45 4.15 1.45s4.15-.65 4.15-1.45V4.2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.15"
            stroke-linecap="round"
          />
          <path
            d="M3.85 7.75c0 .8 1.85 1.45 4.15 1.45s4.15-.65 4.15-1.45"
            fill="none"
            stroke="currentColor"
            stroke-width="1.05"
            stroke-linecap="round"
          />
        </>
      )
    case "authentication":
      return (
        <>
          <rect x="3" y="6.7" width="10" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.1" />
          <path
            d="M5.2 6.7V5.1a2.8 2.8 0 0 1 5.6 0v1.6M8 9.2v2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linecap="round"
          />
        </>
      )
    case "storage":
      return (
        <path
          d="M2.5 4.2h4l1.1 1.4h5.9v7.1h-11z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.15"
          stroke-linejoin="round"
        />
      )
    case "functions":
      return (
        <path
          d="M4.6 3.2H2.9v9.6h1.7M11.4 3.2h1.7v9.6h-1.7M9.8 5.2 6.2 10.8M6.2 5.2l3.6 5.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.1"
          stroke-linecap="round"
        />
      )
    case "settings":
      return (
        <>
          <path
            d="M3 4.2h10M3 8h10M3 11.8h10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.15"
            stroke-linecap="round"
          />
          <circle cx="6" cy="4.2" r="1.15" fill="var(--cc-bg)" stroke="currentColor" stroke-width="1.05" />
          <circle cx="10.2" cy="8" r="1.15" fill="var(--cc-bg)" stroke="currentColor" stroke-width="1.05" />
          <circle cx="7.5" cy="11.8" r="1.15" fill="var(--cc-bg)" stroke="currentColor" stroke-width="1.05" />
        </>
      )
  }
  return <></>
}

function formatDate(value?: string) {
  if (!value) return "—"
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function formatDuration(value?: number) {
  if (value === undefined) return "—"
  if (value < 1000) return `${value} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`
}

function cleanDeploymentUrl(value: string) {
  const candidate = value.match(/https?:\/\/[^\s"'`,}\]]+/i)?.[0]?.replace(/[);.]+$/, "")
  if (!candidate || !URL.canParse(candidate)) return ""
  const parsed = new URL(candidate)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""
  return parsed.toString()
}

function isPackageManager(value: string): value is BuildDraft["packageManager"] {
  return value === "bun" || value === "pnpm" || value === "yarn" || value === "npm" || value === "static"
}

function providerLabel(provider: CloudProviderId) {
  return provider === "vercel" ? "Vercel" : "Supabase"
}

export function CloudConsole(props: {
  projectPath: string
  taskId?: string
  onClose: () => void
  /** Starts the agent on a failed release, with `prompt` (redacted evidence) as its first message. */
  onRepair: (prompt: string) => void
  initialSection?: CloudSection
  embedded?: boolean
}) {
  const platform = usePlatform()
  const dialog = useDialog()
  const macDesktop = platform.platform === "desktop" && platform.os === "macos"
  const api = cloudApi()
  const publish = publishApi()
  const workspaceApi = cloudAgentWorkspaceApi()
  const [section, setSection] = createSignal<CloudSection>(props.initialSection ?? "overview")
  // A deep link that names a section opens it, even when Cloud is already open.
  createEffect(
    on(
      () => props.initialSection,
      (value) => value && setSection(value),
      { defer: true },
    ),
  )
  const [notice, setNotice] = createSignal<Notice>()

  const [publishTargets, setPublishTargets] = createSignal<PublishTarget[]>([])
  const vercelTarget = () => publishTargets().find((item) => item.id === "vercel")
  const [deploymentEnvironment, setDeploymentEnvironment] = createSignal<"preview" | "production">("preview")
  const [publishing, setPublishing] = createSignal(false)
  const [activeRunId, setActiveRunId] = createSignal("")
  const [publishEvents, setPublishEvents] = createSignal<PublishProgressEvent[]>([])

  const [deployments, setDeployments] = createSignal<CloudDeployment[]>([])
  const [agentWorkspaces, setAgentWorkspaces] = createSignal<CloudAgentWorkspace[]>([])
  const [domains, setDomains] = createSignal<CloudDomain[]>([])
  const environment = createCloudEnvironment({ api: () => api, notice: setNotice })
  const envVars = () => environment.state.variables
  const [database, setDatabase] = createSignal<CloudDatabaseConnection>(null)
  const [connections, setConnections] = createSignal<CloudProviderConnection[]>([])
  const [providerResources, setProviderResources] = createSignal<
    Partial<Record<CloudProviderId, CloudProviderResource[]>>
  >({})
  const [providerLinks, setProviderLinks] = createSignal<CloudProviderProjectLink[]>([])
  const [providerSelections, setProviderSelections] = createSignal<Partial<Record<CloudProviderId, string>>>({})
  const [providerBusy, setProviderBusy] = createSignal<CloudProviderId | "">("")
  const [manualTokenProvider, setManualTokenProvider] = createSignal<CloudProviderId | "">("")
  const [manualToken, setManualToken] = createSignal("")
  const [manualTokenError, setManualTokenError] = createSignal("")
  const [buildSettings, setBuildSettings] = createSignal<CloudBuildSettings | null>(null)
  const [supabaseServices, setSupabaseServices] = createSignal<CloudSupabaseServices>()
  const [supabaseServicesBusy, setSupabaseServicesBusy] = createSignal(false)
  const [supabaseServicesLoaded, setSupabaseServicesLoaded] = createSignal(false)
  const [buildDraft, setBuildDraft] = createSignal<BuildDraft>({
    framework: "",
    packageManager: "npm",
    installCommand: "",
    testCommand: "",
    buildCommand: "",
    outputDirectory: "",
    nodeVersion: "",
    healthPath: "/",
    requiredChecks: { test: false, secrets: true, health: true, browser: true },
  })

  const [domainDraft, setDomainDraft] = createSignal("")
  const [verifyingId, setVerifyingId] = createSignal("")
  const [confirmId, setConfirmId] = createSignal("")
  const [copiedId, setCopiedId] = createSignal("")
  const [expandedLogId, setExpandedLogId] = createSignal("")
  const [checkingId, setCheckingId] = createSignal("")
  const [checkingAll, setCheckingAll] = createSignal(false)
  const [deploymentActionId, setDeploymentActionId] = createSignal("")
  const [expandedChecksId, setExpandedChecksId] = createSignal("")
  const [detectingBuild, setDetectingBuild] = createSignal(false)
  const [savingBuild, setSavingBuild] = createSignal(false)
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  const unsubscribePublish = publish?.subscribe((event) => {
    if (event.runId !== activeRunId()) return
    setPublishEvents((items) => [...items, event].slice(-200))
  })
  onCleanup(() => {
    clearTimeout(confirmTimer)
    clearTimeout(copiedTimer)
    unsubscribePublish?.()
  })

  // One-click destructive actions morph into a "Confirm …?" state for 3s
  // instead of firing immediately; a second click within that window commits.
  const requestConfirm = (id: string, action: () => void) => {
    clearTimeout(confirmTimer)
    if (confirmId() === id) {
      setConfirmId("")
      action()
      return
    }
    setConfirmId(id)
    confirmTimer = setTimeout(() => setConfirmId(""), 3000)
  }

  const refreshAll = async () => {
    if (publish) setPublishTargets(await publish.targets().catch(() => []))
    if (!api) return
    const projectPath = props.projectPath
    const taskId = props.taskId
    const scope = environment.scope()
    const isCurrent = () => environment.isCurrent(scope)
    const [nextDeployments, nextDomains, nextDatabase, nextBuild, nextWorkspaces, nextConnections, nextLinks] =
      await Promise.all([
        api.deployments.list(projectPath, taskId).catch(() => []),
        projectPath ? api.domains.list(projectPath, taskId).catch(() => []) : Promise.resolve([]),
        projectPath ? api.database.get(projectPath, taskId).catch(() => null) : Promise.resolve(null),
        projectPath ? api.build.get(projectPath, taskId).catch(() => null) : Promise.resolve(null),
        projectPath && workspaceApi
          ? workspaceApi.list({ sourcePath: projectPath, parentSessionId: taskId }).catch(() => [])
          : Promise.resolve([]),
        api.connections.list().catch(() => []),
        projectPath ? api.providers.links(projectPath, taskId).catch(() => []) : Promise.resolve([]),
        environment.refresh(),
      ])
    if (!isCurrent()) return
    setDeployments(nextDeployments)
    setDomains(nextDomains)
    setDatabase(nextDatabase)
    setBuildSettings(nextBuild)
    setAgentWorkspaces(nextWorkspaces)
    setConnections(nextConnections)
    setProviderLinks(nextLinks)
    const connectedProviders = nextConnections.filter((item) => item.connected).map((item) => item.provider)
    const resources = await Promise.all(
      connectedProviders.map(async (provider) => ({
        provider,
        items: await api.providers.resources(provider).catch(() => []),
      })),
    )
    if (!isCurrent()) return
    setProviderResources(
      Object.fromEntries(resources.map((entry) => [entry.provider, entry.items])) as Partial<
        Record<CloudProviderId, CloudProviderResource[]>
      >,
    )
    if (nextBuild) {
      setBuildDraft({
        framework: nextBuild.framework,
        packageManager: nextBuild.packageManager,
        installCommand: nextBuild.installCommand,
        testCommand: nextBuild.testCommand,
        buildCommand: nextBuild.buildCommand,
        outputDirectory: nextBuild.outputDirectory,
        nodeVersion: nextBuild.nodeVersion,
        healthPath: nextBuild.healthPath,
        requiredChecks: nextBuild.requiredChecks,
      })
    }
  }

  createEffect(() => {
    // Reload task-scoped data when the active task or project changes.
    environment.changeScope(props.projectPath, props.taskId)
    setNotice(undefined)
    setDatabase(null)
    setProviderLinks([])
    setProviderSelections({})
    setSupabaseServices(undefined)
    setSupabaseServicesLoaded(false)
    if (api) void refreshAll()
  })

  const projectName = createMemo(() => props.projectPath.split("/").filter(Boolean).at(-1) ?? "No project")

  // --- Deployments ---------------------------------------------------------
  const removeDeployment = async (deployment: CloudDeployment) => {
    if (!api) return
    try {
      setDeployments(await api.deployments.remove(props.projectPath, props.taskId, deployment.id))
      setNotice({
        tone: "success",
        text: `Removed ${deployment.name} from Vector's deployment history. Manage the live site in Vercel.`,
      })
    } catch {
      setNotice({ tone: "error", text: `Could not remove ${deployment.name} — try again.` })
    }
  }

  const runPublish = async (override?: { environment?: "preview" | "production"; workspace?: CloudAgentWorkspace }) => {
    if (!publish || !props.projectPath) return
    const environment = override?.environment ?? deploymentEnvironment()
    const target = vercelTarget()
    if (target && !target.available) {
      setNotice({ tone: "error", text: target.loginHint || `${target.label} is not available on this machine.` })
      return
    }
    const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`
    setActiveRunId(runId)
    setPublishEvents([])
    setPublishing(true)
    setNotice({
      tone: "info",
      text: override?.workspace
        ? `Publishing ${override.workspace.name} as an isolated preview…`
        : `Publishing a ${environment} release to Vercel… this can take a minute.`,
    })
    try {
      const result = await publish.run({
        projectPath: override?.workspace?.isolatedPath ?? props.projectPath,
        taskId: props.taskId,
        scopeProjectPath: override?.workspace ? props.projectPath : undefined,
        scopeTaskId: override?.workspace ? props.taskId : undefined,
        workspaceId: override?.workspace?.id,
        workspaceName: override?.workspace?.name,
        target: "vercel",
        production: override?.workspace ? false : environment === "production",
        runId,
      })
      if (result.ok && result.url) {
        setNotice({
          tone: "success",
          text: `${override?.workspace ? "Workspace preview" : "Release"} live at ${result.url}`,
        })
      } else {
        setNotice({
          tone: "error",
          text: result.error ?? "Publish failed. Open the release's evidence for the cause.",
        })
      }
      if (api && (result.deploymentId || result.url)) {
        setDeployments(await api.deployments.list(props.projectPath, props.taskId).catch(() => deployments()))
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Publish failed." })
    } finally {
      setPublishing(false)
    }
  }

  const copyDeploymentUrl = async (deployment: CloudDeployment) => {
    const url = cleanDeploymentUrl(deployment.productionUrl ?? deployment.url)
    if (!url) {
      setNotice({ tone: "error", text: "This deployment does not have a valid public link yet." })
      return
    }
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(url)
      setCopiedId(deployment.id)
      clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => setCopiedId((current) => (current === deployment.id ? "" : current)), 1500)
    } catch {
      setNotice({ tone: "error", text: "Could not copy — try selecting the link instead." })
    }
  }

  const openDeploymentUrl = (deployment: CloudDeployment) => {
    const url = cleanDeploymentUrl(deployment.productionUrl ?? deployment.url)
    if (!url) {
      setNotice({ tone: "error", text: "This deployment does not have a valid public link yet." })
      return
    }
    platform.openLink(url)
  }

  const checkDeployment = async (deployment: CloudDeployment) => {
    if (!api || !props.projectPath) return
    setCheckingId(deployment.id)
    try {
      const updated = await api.deployments.check(props.projectPath, props.taskId, deployment.id)
      setDeployments((items) => items.map((item) => (item.id === updated.id ? updated : item)))
      setNotice({
        tone: updated.status === "ready" ? "success" : "error",
        text:
          updated.status === "ready"
            ? `${updated.name} responded with HTTP ${updated.statusCode} in ${formatDuration(updated.latencyMs)}.`
            : `${updated.name} is ${updated.status}: ${updated.healthError ?? "health check failed"}`,
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Health check failed." })
    } finally {
      setCheckingId("")
    }
  }

  const checkAllDeployments = async () => {
    if (!api || !props.projectPath || !deployments().length) return
    setCheckingAll(true)
    try {
      const next = await api.deployments.checkAll(props.projectPath, props.taskId)
      setDeployments(next)
      const healthy = next.filter((item) => item.status === "ready").length
      setNotice({
        tone: healthy === next.length ? "success" : "info",
        text: `${healthy} of ${next.length} deployments are healthy.`,
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Health checks failed." })
    } finally {
      setCheckingAll(false)
    }
  }

  const replaceDeployment = (updated: CloudDeployment) => {
    setDeployments((items) => items.map((item) => (item.id === updated.id ? updated : item)))
  }

  const promoteRelease = async (deployment: CloudDeployment) => {
    if (!api) return
    setDeploymentActionId(deployment.id)
    try {
      const updated = await api.deployments.promote(props.projectPath, props.taskId, deployment.id)
      setDeployments(await api.deployments.list(props.projectPath, props.taskId))
      setNotice({ tone: "success", text: `${updated.name} is now the current production release.` })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Promotion failed." })
    } finally {
      setDeploymentActionId("")
    }
  }

  const rollbackRelease = async (deployment: CloudDeployment) => {
    if (!api) return
    setDeploymentActionId(deployment.id)
    try {
      const updated = await api.deployments.rollback(props.projectPath, props.taskId, deployment.id)
      setDeployments(await api.deployments.list(props.projectPath, props.taskId))
      setNotice({ tone: "success", text: `Production rolled back to ${updated.name}.` })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Rollback failed." })
    } finally {
      setDeploymentActionId("")
    }
  }

  const readRuntimeLogs = async (deployment: CloudDeployment) => {
    if (!api) return
    setDeploymentActionId(deployment.id)
    try {
      const result = await api.deployments.logs(props.projectPath, props.taskId, deployment.id)
      replaceDeployment({ ...deployment, runtimeLog: result.log, runtimeLogFetchedAt: result.fetchedAt })
      setExpandedLogId(deployment.id)
      setNotice({
        tone: "success",
        text: `Loaded ${result.source === "provider" ? "runtime" : "build and check"} logs.`,
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not read deployment logs." })
    } finally {
      setDeploymentActionId("")
    }
  }

  const rerunChecks = async (deployment: CloudDeployment) => {
    if (!api) return
    setDeploymentActionId(deployment.id)
    try {
      const updated = await api.deployments.rerunChecks(props.projectPath, props.taskId, deployment.id)
      replaceDeployment(updated)
      const failed = updated.checks.filter((check) => check.required && check.status === "failed").length
      setNotice({
        tone: failed ? "error" : "success",
        text: failed
          ? `${failed} required check${failed === 1 ? "" : "s"} failed.`
          : "All required release checks passed.",
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not run release checks." })
    } finally {
      setDeploymentActionId("")
    }
  }

  // Logs and check output arrive from the desktop already redacted.
  const repairDeployment = (deployment: CloudDeployment) =>
    props.onRepair(deployRepairPrompt(deploymentEvidence(deployment)))

  const detectBuild = async () => {
    if (!api || !props.projectPath) return
    setDetectingBuild(true)
    try {
      const detected = await api.build.detect(props.projectPath, props.taskId)
      setBuildSettings(detected)
      setBuildDraft({
        framework: detected.framework,
        packageManager: detected.packageManager,
        installCommand: detected.installCommand,
        testCommand: detected.testCommand,
        buildCommand: detected.buildCommand,
        outputDirectory: detected.outputDirectory,
        nodeVersion: detected.nodeVersion,
        healthPath: detected.healthPath,
        requiredChecks: detected.requiredChecks,
      })
      setNotice({
        tone: "success",
        text: `Detected ${detected.framework} with ${detected.packageManager}. Review the commands, then save.`,
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not detect build settings." })
    } finally {
      setDetectingBuild(false)
    }
  }

  const saveBuild = async () => {
    if (!api || !props.projectPath) return
    setSavingBuild(true)
    try {
      const saved = await api.build.set(props.projectPath, props.taskId, buildDraft())
      setBuildSettings(saved)
      setNotice({ tone: "success", text: "Build and runtime settings saved for this project session." })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save build settings." })
    } finally {
      setSavingBuild(false)
    }
  }

  // --- Domains -------------------------------------------------------------
  const addDomain = async () => {
    if (!api || !props.projectPath || !domainDraft().trim()) return
    if (!providerLink("vercel")) {
      setNotice({ tone: "error", text: "Link a Vercel project before adding a domain." })
      return
    }
    try {
      await api.providers.addDomain(props.projectPath, props.taskId, "vercel", domainDraft().trim())
      setDomainDraft("")
      setDomains(await api.domains.list(props.projectPath, props.taskId))
      setNotice({
        tone: "success",
        text: "Domain attached to Vercel. Configure the DNS record shown, then verify.",
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not add domain." })
    }
  }
  const verifyDomain = async (domain: CloudDomain) => {
    if (!api || !props.projectPath) return
    setVerifyingId(domain.id)
    try {
      const updated = await api.providers.verifyDomain(props.projectPath, props.taskId, domain.id)
      setDomains((list) => list.map((item) => (item.id === updated.id ? updated : item)))
      setNotice(
        updated.status === "verified"
          ? { tone: "success", text: `${updated.domain} is verified on Vercel.` }
          : { tone: "info", text: updated.detail ?? "Not verified yet — DNS can take a few minutes." },
      )
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Verification failed — check your connection and try again.",
      })
    } finally {
      setVerifyingId("")
    }
  }
  const removeDomain = async (domain: CloudDomain) => {
    if (!api || !props.projectPath) return
    try {
      setDomains(await api.providers.removeDomain(props.projectPath, props.taskId, domain.id))
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not remove domain — try again.",
      })
    }
  }

  createEffect(() => {
    if (section() !== "environment") environment.hide()
  })

  // --- Provider connections ------------------------------------------------
  const providerConnection = (provider: CloudProviderId) => connections().find((item) => item.provider === provider)
  const providerLink = (provider: "vercel") => providerLinks().find((item) => item.provider === provider)

  // Whether this project can publish now, from the same state publishing
  // checks: a connected Vercel account with a linked project, or a machine
  // already signed in with the Vercel CLI.
  const hostingState = createMemo(() => {
    const connected = providerConnection("vercel")?.connected
    const link = providerLink("vercel")
    const target = vercelTarget()
    // Connected but unable to run the deploy: the hint says what this machine lacks.
    if (connected && target && !target.available) {
      return { tone: "warning", label: "Cannot publish yet", detail: target.loginHint, fix: false }
    }
    if (connected && link) return { tone: "success", label: `Vercel · ${link.projectName}`, detail: "", fix: false }
    if (connected) {
      return {
        tone: "warning",
        label: "Link a Vercel project",
        detail: "Vercel is connected. Link one of its projects to this repository in Connections to publish.",
        fix: true,
      }
    }
    if (target?.available) {
      return { tone: "success", label: `Vercel CLI · ${target.account ?? "signed in"}`, detail: "", fix: false }
    }
    return {
      tone: undefined,
      label: "Not connected",
      detail: "Connect Vercel in Connections with an access token to publish this project.",
      fix: true,
    }
  })

  const supabaseDashboard = (pathname = "") => {
    const ref = database()?.projectRef
    if (!ref) return "https://supabase.com/dashboard/projects"
    return `https://supabase.com/dashboard/project/${encodeURIComponent(ref)}${pathname}`
  }

  const refreshSupabaseServices = async () => {
    if (!api || !props.projectPath) return
    setSupabaseServicesBusy(true)
    try {
      setSupabaseServices(await api.services.supabase(props.projectPath, props.taskId))
    } catch (error) {
      setSupabaseServices(undefined)
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load Supabase services." })
    } finally {
      setSupabaseServicesBusy(false)
      setSupabaseServicesLoaded(true)
    }
  }

  createEffect(() => {
    const current = section()
    if (["authentication", "storage", "functions"].includes(current) && !supabaseServicesLoaded()) {
      void refreshSupabaseServices()
    }
  })

  const connectProvider = async (provider: CloudProviderId) => {
    if (!api) return
    setProviderBusy(provider)
    try {
      const connection = await api.connections.connect(provider)
      setConnections((items) => [connection, ...items.filter((item) => item.provider !== provider)])
      const resources = await api.providers.resources(provider).catch(() => [])
      setProviderResources((current) => ({ ...current, [provider]: resources }))
      setNotice({
        tone: "success",
        text: `${providerLabel(provider)} connected${connection.account ? ` as ${connection.account}` : ""}.`,
      })
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : `Could not connect ${providerLabel(provider)}.`,
      })
    } finally {
      setProviderBusy("")
    }
  }

  const openManualToken = (provider: CloudProviderId) => {
    setManualTokenProvider(provider)
    setManualToken("")
    setManualTokenError("")
  }

  const cancelManualToken = () => {
    setManualTokenProvider("")
    setManualToken("")
    setManualTokenError("")
  }

  const connectProviderWithToken = async (provider: CloudProviderId) => {
    if (!api || providerBusy()) return
    const token = manualToken().trim()
    if (!token) {
      setManualTokenError(`Paste a ${providerLabel(provider)} access token before connecting.`)
      return
    }
    if (!api.connections.connectWithToken) {
      setManualTokenError("Update Vector to connect this provider with an access token.")
      return
    }
    setProviderBusy(provider)
    setManualTokenError("")
    try {
      const connection = await api.connections.connectWithToken(provider, token)
      // The saved credential no longer belongs in the renderer draft.
      cancelManualToken()
      setConnections((items) => [connection, ...items.filter((item) => item.provider !== provider)])
      const resources = await api.providers.resources(provider).catch(() => [])
      setProviderResources((current) => ({ ...current, [provider]: resources }))
      setNotice({
        tone: "success",
        text: `${providerLabel(provider)} connected${connection.account ? ` as ${connection.account}` : ""}.`,
      })
    } catch (error) {
      setManualTokenError(
        error instanceof Error ? error.message : `${providerLabel(provider)} rejected that access token.`,
      )
    } finally {
      setProviderBusy("")
    }
  }

  const disconnectProvider = async (provider: CloudProviderId) => {
    if (!api) return
    setProviderBusy(provider)
    try {
      await api.connections.disconnect(provider)
      setConnections((items) =>
        items.map((item) =>
          item.provider === provider
            ? { ...item, connected: false, account: undefined, accountId: undefined, connectedAt: undefined }
            : item,
        ),
      )
      setProviderResources((current) => ({ ...current, [provider]: [] }))
      cancelManualToken()
      setNotice({ tone: "info", text: `${providerLabel(provider)} disconnected from Vector.` })
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : `Could not disconnect ${providerLabel(provider)}.`,
      })
    } finally {
      setProviderBusy("")
    }
  }

  const linkProviderProject = async (provider: CloudProviderId) => {
    if (provider === "supabase") return
    if (!api || !props.projectPath) return
    const projectId = providerSelections()[provider]
    if (!projectId) return
    setProviderBusy(provider)
    try {
      const link = await api.providers.link(props.projectPath, props.taskId, provider, projectId)
      setProviderLinks((items) => [link, ...items.filter((item) => item.provider !== provider)])
      setNotice({ tone: "success", text: `${link.projectName} is linked to this Vector project.` })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not link that project." })
    } finally {
      setProviderBusy("")
    }
  }

  const unlinkProviderProject = async (provider: CloudProviderId) => {
    if (provider === "supabase") return
    if (!api || !props.projectPath) return
    setProviderBusy(provider)
    try {
      setProviderLinks(await api.providers.unlink(props.projectPath, props.taskId, provider))
      setNotice({ tone: "info", text: `${providerLabel(provider)} project link removed.` })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not unlink that project." })
    } finally {
      setProviderBusy("")
    }
  }

  // --- Database ------------------------------------------------------------
  const connectSupabaseProject = async () => {
    if (!api || !props.projectPath) return
    const projectRef = providerSelections().supabase
    if (!projectRef) return
    const scope = environment.scope()
    setProviderBusy("supabase")
    try {
      const connection = await api.database.connectProject(scope.projectPath, scope.taskId, projectRef)
      if (!environment.isCurrent(scope)) return
      setDatabase(connection)
      await environment.refresh()
      if (!environment.isCurrent(scope)) return
      setSupabaseServices(undefined)
      setSupabaseServicesLoaded(false)
      setNotice({
        tone: "success",
        text: `${connection?.projectName ?? "Supabase"} connected. Vector configured the project locally without asking you to copy API keys.`,
      })
    } catch (error) {
      if (!environment.isCurrent(scope)) return
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not connect the database." })
    } finally {
      setProviderBusy("")
    }
  }
  const disconnectDb = async () => {
    if (!api || !props.projectPath) return
    const scope = environment.scope()
    try {
      await api.database.disconnect(scope.projectPath, scope.taskId)
      if (!environment.isCurrent(scope)) return
      setDatabase(null)
      setNotice({ tone: "info", text: "Supabase disconnected. Your .env keys were left in place." })
    } catch (error) {
      if (!environment.isCurrent(scope)) return
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not disconnect — try again." })
    }
  }

  return (
    <section
      data-cloud-console
      data-embedded={props.embedded ? "true" : undefined}
      class={`${props.embedded ? "absolute inset-0 z-0" : "fixed inset-0 z-[140]"} flex min-h-0 flex-col overflow-hidden`}
    >
      <header class="cloud-header" style={{ "padding-left": !props.embedded && macDesktop ? "84px" : undefined }}>
        <button class="cloud-button" type="button" onClick={props.onClose}>
          Back
        </button>
        <img src="/vector-logo.png" alt="" class="size-9 rounded-[10px] object-cover" draggable={false} />
        <div class="min-w-0">
          <div class="text-[13px] font-semibold text-white">Vector Cloud</div>
          <div class="max-w-[440px] truncate text-[11px] text-white/45">
            {props.projectPath || "Open a project to manage its cloud"}
          </div>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <span class="cloud-status">
            {deployments().length} releases · {deployments().filter((item) => item.releaseStatus === "current").length}{" "}
            live
          </span>
        </div>
      </header>

      <div class="cloud-shell">
        <aside class="cloud-sidebar">
          <For each={SECTION_GROUPS}>
            {(group) => (
              <section class="cloud-nav-group">
                <Show when={group.label}>
                  <div class="cloud-nav-label">{group.label}</div>
                </Show>
                <For each={group.items}>
                  {(item) => (
                    <button
                      class="cloud-nav"
                      data-active={section() === item.id}
                      data-section={item.id}
                      type="button"
                      onClick={() => {
                        setSection(item.id)
                        setNotice(undefined)
                      }}
                    >
                      <svg viewBox="0 0 16 16" class="cloud-nav-icon" aria-hidden="true">
                        {sectionIcon(item.id)}
                      </svg>
                      <span>{item.label}</span>
                    </button>
                  )}
                </For>
              </section>
            )}
          </For>
        </aside>

        <main class="cloud-content">
          <div class="cloud-inner">
            <Show when={!api}>
              <p class="cloud-offline">Cloud controls activate once Vector connects to this workspace.</p>
            </Show>

            <Show when={notice()}>
              {(item) => (
                <div class="cloud-notice" data-tone={item().tone}>
                  {item().text}
                </div>
              )}
            </Show>

            {/* Project overview */}
            <Show when={section() === "overview"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">{projectName()}</div>
                  <h1>Project overview</h1>
                  <p>
                    One repository-scoped view of releases, provider connections, data services, and runtime health.
                    Vector's agent uses the same project context when it deploys or prepares cloud-backed features.
                  </p>
                </div>
              </div>
              <div class="cloud-grid">
                <button class="cloud-metric" type="button" onClick={() => setSection("deployments")}>
                  <span class="cloud-metric-value">{deployments().length}</span>
                  <strong>Deployments</strong>
                  <small>
                    {deployments().filter((item) => item.releaseStatus === "current").length} current releases
                  </small>
                </button>
                <button class="cloud-metric" type="button" onClick={() => setSection("observability")}>
                  <span class="cloud-metric-value">
                    {deployments().filter((item) => item.status === "ready").length}/{deployments().length || 0}
                  </span>
                  <strong>Healthy releases</strong>
                  <small>Based on the latest recorded health checks</small>
                </button>
                <button class="cloud-metric" type="button" onClick={() => setSection("connections")}>
                  <span class="cloud-metric-value">{connections().filter((item) => item.connected).length}</span>
                  <strong>Cloud accounts</strong>
                  <small>Vercel and Supabase connections</small>
                </button>
                <button class="cloud-metric" type="button" onClick={() => setSection("environment")}>
                  <span class="cloud-metric-value">{envVars().length}</span>
                  <strong>Environment variables</strong>
                  <small>Stored for this repository and project scope</small>
                </button>
              </div>
              <section class="cloud-service-list mt-4">
                <button type="button" onClick={() => setSection("deployments")}>
                  <span class="cloud-service-icon">
                    <Icon name="cloud-upload" />
                  </span>
                  <span>
                    <strong>Deploy and publish</strong>
                    <small>Build, verify, promote, and roll back releases.</small>
                  </span>
                  <em data-tone={hostingState().tone}>{hostingState().label}</em>
                </button>
                <button type="button" onClick={() => setSection("database")}>
                  <span class="cloud-service-icon">
                    <Icon name="server" />
                  </span>
                  <span>
                    <strong>Data services</strong>
                    <small>Database, authentication, storage, and functions.</small>
                  </span>
                  <em data-tone={database() ? "success" : undefined}>
                    {database()
                      ? `Supabase · ${database()?.projectName ?? database()?.projectRef ?? "connected"}`
                      : providerConnection("supabase")?.connected
                        ? "Choose a Supabase project"
                        : "No database"}
                  </em>
                </button>
              </section>
            </Show>

            {/* Connections */}
            <Show when={section() === "connections"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Your accounts</div>
                  <h1>Cloud connections</h1>
                  <p>
                    Connect your Vercel and Supabase accounts once, then publish, link projects, and configure your
                    database here or by asking Vector. Access tokens stay encrypted on this device.
                  </p>
                </div>
              </div>
              <section class="cloud-source-control">
                <div>
                  <div class="cloud-panel-title">Source control</div>
                  <p class="cloud-muted mt-1 text-[12px]">
                    Commit this repository and push it to a new or existing remote through your connected account.
                  </p>
                </div>
                <div class="cloud-source-control-actions">
                  <button
                    class="cloud-repository-button"
                    data-provider="github"
                    type="button"
                    onClick={() => void dialog.show(() => <DialogGithubPush projectPath={props.projectPath} />)}
                  >
                    <Icon name="github" />
                    <span>Push to GitHub</span>
                  </button>
                  <button
                    class="cloud-repository-button"
                    data-provider="gitlab"
                    type="button"
                    onClick={() => void dialog.show(() => <DialogGitlabPush projectPath={props.projectPath} />)}
                  >
                    <Icon name="gitlab" />
                    <span>Push to GitLab</span>
                  </button>
                </div>
              </section>
              <div class="cloud-connection-list">
                <For each={["vercel", "supabase"] as CloudProviderId[]}>
                  {(provider) => {
                    const connection = () => providerConnection(provider)
                    const connectionMode = () => cloudProviderConnectionMode(connection())
                    const tokenGuide = () => cloudProviderTokenGuide(provider)
                    const linked = () => (provider === "supabase" ? undefined : providerLink(provider))
                    const resources = () => providerResources()[provider] ?? []
                    return (
                      <section class="cloud-panel cloud-connection-card">
                        <div class="cloud-provider-mark" data-provider={provider}>
                          {provider === "vercel" ? "V" : "S"}
                        </div>
                        <div class="cloud-connection-main">
                          <div class="flex items-center gap-2">
                            <div class="cloud-panel-title">{providerLabel(provider)}</div>
                            <span
                              class="cloud-status"
                              data-tone={
                                connectionMode() === "connected"
                                  ? "success"
                                  : connectionMode() === "unavailable"
                                    ? "warning"
                                    : undefined
                              }
                            >
                              {connectionMode() === "connected"
                                ? "Connected"
                                : connectionMode() === "checking"
                                  ? "Checking…"
                                  : connectionMode() === "unavailable"
                                    ? "Unavailable"
                                    : "Not connected"}
                            </span>
                          </div>
                          <p class="cloud-muted mt-1 text-[12px]">
                            {connectionMode() === "connected"
                              ? connection()?.account
                                ? `Signed in as ${connection()?.account}`
                                : "Account authorized"
                              : connectionMode() === "token"
                                ? `Connect with a ${providerLabel(provider)} access token. It takes about two minutes, and the token stays encrypted on this device.`
                                : (connection()?.detail ?? "Checking provider availability…")}
                          </p>

                          <Show when={manualTokenProvider() === provider && connectionMode() === "token"}>
                            <form
                              class="cloud-token-form"
                              onSubmit={(event) => {
                                event.preventDefault()
                                void connectProviderWithToken(provider)
                              }}
                            >
                              <p class="cloud-token-guide">
                                Create a token in <strong>{tokenGuide().location}</strong>. {tokenGuide().instruction}
                                Vector validates it, encrypts it in the local credential vault, and never shows it again
                                after saving.
                              </p>
                              <button
                                class="cloud-token-link"
                                type="button"
                                onClick={() => platform.openLink(tokenGuide().url)}
                              >
                                Open {providerLabel(provider)} token settings
                              </button>
                              <label class="cloud-token-field">
                                <span>{providerLabel(provider)} access token</span>
                                <input
                                  class="cloud-input"
                                  type="password"
                                  name={`${provider}-access-token`}
                                  autocomplete="off"
                                  spellcheck={false}
                                  placeholder={tokenGuide().placeholder}
                                  value={manualToken()}
                                  onInput={(event) => {
                                    setManualToken(event.currentTarget.value)
                                    setManualTokenError("")
                                  }}
                                />
                              </label>
                              <Show when={manualTokenError()}>
                                <p class="cloud-token-error" role="alert">
                                  {manualTokenError()}
                                </p>
                              </Show>
                              <div class="cloud-token-actions">
                                <button
                                  class="cloud-button"
                                  data-variant="primary"
                                  type="submit"
                                  disabled={!manualToken().trim() || providerBusy() === provider}
                                >
                                  {providerBusy() === provider ? "Validating…" : "Save and connect"}
                                </button>
                                <button
                                  class="cloud-button"
                                  type="button"
                                  disabled={providerBusy() === provider}
                                  onClick={cancelManualToken}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          </Show>

                          <Show when={connection()?.connected && provider !== "supabase"}>
                            <Show
                              when={linked()}
                              fallback={
                                <div class="cloud-provider-linker">
                                  <select
                                    class="cloud-input"
                                    value={providerSelections()[provider] ?? ""}
                                    onChange={(event) =>
                                      setProviderSelections((current) => ({
                                        ...current,
                                        [provider]: event.currentTarget.value,
                                      }))
                                    }
                                  >
                                    <option value="">Choose a {providerLabel(provider)} project</option>
                                    <For each={resources()}>
                                      {(resource) => <option value={resource.id}>{resource.name}</option>}
                                    </For>
                                  </select>
                                  <button
                                    class="cloud-button"
                                    data-variant="primary"
                                    type="button"
                                    disabled={
                                      !props.projectPath ||
                                      !providerSelections()[provider] ||
                                      providerBusy() === provider
                                    }
                                    onClick={() => void linkProviderProject(provider)}
                                  >
                                    Link project
                                  </button>
                                </div>
                              }
                            >
                              {(item) => (
                                <div class="cloud-linked-project">
                                  <span>
                                    Linked to <strong>{item().projectName}</strong>
                                  </span>
                                  <button
                                    class="cloud-button"
                                    type="button"
                                    disabled={providerBusy() === provider}
                                    onClick={() => void unlinkProviderProject(provider)}
                                  >
                                    Unlink
                                  </button>
                                </div>
                              )}
                            </Show>
                          </Show>

                          <Show when={connection()?.connected && provider === "supabase"}>
                            <p class="cloud-connection-note">
                              Choose the Supabase project for this repository in Database. Vector will obtain the
                              publishable key through your authorized account.
                            </p>
                          </Show>
                        </div>
                        <div class="cloud-connection-actions">
                          <Show
                            when={connectionMode() === "connected"}
                            fallback={
                              <Show
                                when={connectionMode() === "oauth"}
                                fallback={
                                  <Show
                                    when={connectionMode() === "token"}
                                    fallback={
                                      <button class="cloud-button" type="button" disabled>
                                        {connectionMode() === "checking" ? "Checking…" : "Connection unavailable"}
                                      </button>
                                    }
                                  >
                                    <button
                                      class="cloud-button"
                                      data-variant="primary"
                                      type="button"
                                      disabled={providerBusy() === provider || manualTokenProvider() === provider}
                                      onClick={() => openManualToken(provider)}
                                    >
                                      {manualTokenProvider() === provider ? "Enter token below" : "Use access token"}
                                    </button>
                                  </Show>
                                }
                              >
                                <button
                                  class="cloud-button"
                                  data-variant="primary"
                                  type="button"
                                  disabled={!api || providerBusy() === provider}
                                  onClick={() => void connectProvider(provider)}
                                >
                                  {providerBusy() === provider
                                    ? "Waiting for sign-in…"
                                    : `Connect ${providerLabel(provider)}`}
                                </button>
                              </Show>
                            }
                          >
                            <button
                              class="cloud-button"
                              data-variant="danger"
                              type="button"
                              disabled={providerBusy() === provider}
                              onClick={() =>
                                requestConfirm(`disconnect-${provider}`, () => void disconnectProvider(provider))
                              }
                            >
                              {confirmId() === `disconnect-${provider}` ? "Confirm disconnect?" : "Disconnect"}
                            </button>
                          </Show>
                        </div>
                      </section>
                    )
                  }}
                </For>
              </div>
            </Show>

            {/* Deployments */}
            <Show when={section() === "deployments"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Live on the internet</div>
                  <h1>Deployments</h1>
                  <p>
                    Vector ships this project itself — it runs the build, drives the deploy, and hands you the live
                    link. You authorize your account once; Vector does the rest.
                  </p>
                </div>
              </div>
              <Show
                when={props.projectPath}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("deployments")}
                    </svg>
                    <strong>No project open</strong>
                    <p>Open a project to publish it to a public link.</p>
                  </div>
                }
              >
                <div class="cloud-panel mb-3">
                  <div class="cloud-panel-title">Publish this project</div>
                  <p class="cloud-muted mt-1 text-[12px]">
                    Vector runs the whole deploy on your own Vercel account — authorize once, then it's a single click.
                    Your code is never proxied through Vector.
                  </p>
                  <div class="cloud-segment mt-3" aria-label="Deployment environment">
                    <button
                      type="button"
                      data-active={deploymentEnvironment() === "preview"}
                      onClick={() => setDeploymentEnvironment("preview")}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      data-active={deploymentEnvironment() === "production"}
                      onClick={() => setDeploymentEnvironment("production")}
                    >
                      Production
                    </button>
                  </div>
                  <div class="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      class="cloud-button ml-auto"
                      data-variant="primary"
                      type="button"
                      disabled={!publish || publishing()}
                      onClick={() =>
                        deploymentEnvironment() === "production"
                          ? requestConfirm("publish-production", () => void runPublish())
                          : void runPublish()
                      }
                    >
                      {publishing()
                        ? "Publishing…"
                        : confirmId() === "publish-production"
                          ? `Confirm production release${providerLink("vercel") ? ` to ${providerLink("vercel")?.projectName}` : ""}?`
                          : deploymentEnvironment() === "production"
                            ? "Publish to production →"
                            : "Publish preview →"}
                    </button>
                  </div>
                  <Show when={publish && vercelTarget()}>
                    {(target) => (
                      <p class="cloud-muted mt-2 text-[11px]">
                        {target().account ? (
                          <span>
                            <span class="text-[color:var(--vx-green)]">●</span> Connected to {target().label} as{" "}
                            <strong class="text-white/70">{target().account}</strong>.
                          </span>
                        ) : (
                          target().loginHint
                        )}
                      </p>
                    )}
                  </Show>
                  <Show when={!publish}>
                    <p class="cloud-muted mt-2 text-[11px]">Publishing runs in Vector Desktop.</p>
                  </Show>
                  <Show when={publish && hostingState().tone !== "success"}>
                    <div class="cloud-inline-empty mt-3">
                      <span>{hostingState().detail}</span>
                      <Show when={hostingState().fix}>
                        <button class="cloud-button" type="button" onClick={() => setSection("connections")}>
                          Open Connections
                        </button>
                      </Show>
                    </div>
                  </Show>
                  <Show when={publishEvents().length}>
                    <div class="cloud-pipeline mt-4">
                      <div class="flex items-center justify-between gap-3">
                        <strong>Release pipeline</strong>
                        <span>{publishing() ? "Running" : "Finished"}</span>
                      </div>
                      <div class="cloud-pipeline-events">
                        <For each={publishEvents().slice(-12)}>
                          {(event) => (
                            <div class="cloud-pipeline-event" data-level={event.level}>
                              <span class="cloud-pipeline-dot" />
                              <span class="uppercase">{event.stage}</span>
                              <p>{event.message}</p>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>

                <Show
                  when={
                    agentWorkspaces().filter(
                      (workspace) => workspace.isolatedPath && !["discarded", "merged"].includes(workspace.status),
                    ).length
                  }
                >
                  <div class="cloud-panel mb-3">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <div class="cloud-panel-title">Agent workspace previews</div>
                        <p class="cloud-muted mt-1 text-[12px]">
                          Deploy an isolated agent worktree before merging it. The main project stays untouched.
                        </p>
                      </div>
                      <span class="cloud-status">{agentWorkspaces().length} workspaces</span>
                    </div>
                    <div class="cloud-workspace-grid mt-3">
                      <For
                        each={agentWorkspaces().filter(
                          (workspace) => workspace.isolatedPath && !["discarded", "merged"].includes(workspace.status),
                        )}
                      >
                        {(workspace) => {
                          const preview = () =>
                            deployments().find((deployment) => deployment.workspaceId === workspace.id)
                          return (
                            <div class="cloud-workspace-row">
                              <div class="min-w-0">
                                <div class="flex flex-wrap items-center gap-2">
                                  <strong>{workspace.name}</strong>
                                  <span class="cloud-status">{workspace.status}</span>
                                  <Show when={workspace.gitBranch}>
                                    <code>{workspace.gitBranch}</code>
                                  </Show>
                                </div>
                                <p>{workspace.lastAction || workspace.taskPrompt}</p>
                                <Show when={preview()}>
                                  {(item) => (
                                    <a class="cloud-link" href={item().url} target="_blank" rel="noopener noreferrer">
                                      {item().url}
                                    </a>
                                  )}
                                </Show>
                              </div>
                              <button
                                class="cloud-button"
                                data-variant="primary"
                                type="button"
                                disabled={!publish || publishing()}
                                onClick={() => void runPublish({ environment: "preview", workspace })}
                              >
                                {preview() ? "Redeploy preview" : "Publish preview"}
                              </button>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </Show>
              </Show>
              <Show
                when={deployments().length}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("deployments")}
                    </svg>
                    <strong>Nothing published yet</strong>
                    <p>Publish a preview above, or ask Vector to publish one, and its releases appear here.</p>
                  </div>
                }
              >
                <div class="cloud-list">
                  <For each={deployments()}>
                    {(deployment) => {
                      const failedChecks = () =>
                        deployment.checks.filter((check) => check.required && check.status === "failed")
                      const passedChecks = () => deployment.checks.filter((check) => check.status === "passed")
                      const canPromote = () =>
                        deployment.releaseStatus === "preview" && !deployment.workspaceId && failedChecks().length === 0
                      const canRollback = () =>
                        (deployment.releaseStatus === "superseded" || deployment.releaseStatus === "rolled-back") &&
                        failedChecks().length === 0
                      return (
                        <div class="cloud-row cloud-row-block">
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="cloud-health-dot" data-status={deployment.status} />
                              <strong class="truncate text-[13px] text-white/85">{deployment.name}</strong>
                              <span
                                class="cloud-status"
                                data-tone={deployment.releaseStatus === "current" ? "success" : undefined}
                              >
                                {deployment.releaseStatus}
                              </span>
                              <span class="cloud-status">{deployment.target}</span>
                              <Show when={deployment.workspaceName}>
                                <span class="cloud-status">agent · {deployment.workspaceName}</span>
                              </Show>
                              <Show when={deployment.checks.length}>
                                <span class="cloud-status" data-tone={failedChecks().length ? "error" : "success"}>
                                  {failedChecks().length
                                    ? `${failedChecks().length} failed`
                                    : `${passedChecks().length} checks passed`}
                                </span>
                              </Show>
                            </div>
                            <a
                              href={cleanDeploymentUrl(deployment.productionUrl ?? deployment.url)}
                              target="_blank"
                              rel="noopener noreferrer"
                              class="cloud-link"
                            >
                              {cleanDeploymentUrl(deployment.productionUrl ?? deployment.url)}
                            </a>
                            <p class="cloud-muted text-[11px]">
                              {formatDate(deployment.createdAt)} ·{" "}
                              {deployment.durationMs === undefined
                                ? "duration unavailable"
                                : `built in ${formatDuration(deployment.durationMs)}`}
                              {deployment.lastCheckedAt ? ` · checked ${formatDate(deployment.lastCheckedAt)}` : ""}
                            </p>
                            <Show when={deployment.git}>
                              {(git) => (
                                <p class="cloud-git-line">
                                  <span>{git().branch}</span>
                                  <code>{git().commitShort}</code>
                                  <span>{git().commitMessage}</span>
                                  <Show when={git().dirty}>
                                    <strong>uncommitted changes</strong>
                                  </Show>
                                </p>
                              )}
                            </Show>
                            <Show when={expandedChecksId() === deployment.id}>
                              <div class="cloud-check-list">
                                <For
                                  each={deployment.checks}
                                  fallback={<p>No release checks recorded for this older deployment.</p>}
                                >
                                  {(check) => (
                                    <div class="cloud-check" data-status={check.status}>
                                      <span class="cloud-check-mark">
                                        {check.status === "passed" ? "✓" : check.status === "failed" ? "!" : "–"}
                                      </span>
                                      <div>
                                        <strong>{check.label}</strong>
                                        <p>
                                          {check.details ?? check.status}
                                          {check.durationMs === undefined
                                            ? ""
                                            : ` · ${formatDuration(check.durationMs)}`}
                                        </p>
                                        <Show when={check.output}>
                                          <pre>{check.output}</pre>
                                        </Show>
                                      </div>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
                            <Show when={expandedLogId() === deployment.id}>
                              <pre class="cloud-log mt-3">
                                {deployment.runtimeLog ?? deployment.log ?? "No logs recorded for this deployment."}
                              </pre>
                            </Show>
                          </div>
                          <div class="cloud-deployment-actions">
                            <button
                              class="cloud-button"
                              type="button"
                              disabled={!api || deploymentActionId() === deployment.id}
                              onClick={() => void rerunChecks(deployment)}
                            >
                              {deploymentActionId() === deployment.id ? "Working…" : "Run checks"}
                            </button>
                            <button
                              class="cloud-button"
                              type="button"
                              onClick={() =>
                                setExpandedChecksId((current) => (current === deployment.id ? "" : deployment.id))
                              }
                            >
                              {expandedChecksId() === deployment.id ? "Hide evidence" : "Evidence"}
                            </button>
                            <button
                              class="cloud-button"
                              type="button"
                              disabled={!api || deploymentActionId() === deployment.id}
                              onClick={() => void readRuntimeLogs(deployment)}
                            >
                              Runtime logs
                            </button>
                            <Show when={canPromote()}>
                              <button
                                class="cloud-button"
                                data-variant="primary"
                                type="button"
                                disabled={deploymentActionId() === deployment.id}
                                onClick={() =>
                                  requestConfirm(`promote-${deployment.id}`, () => void promoteRelease(deployment))
                                }
                              >
                                {confirmId() === `promote-${deployment.id}` ? "Confirm promote?" : "Promote"}
                              </button>
                            </Show>
                            <Show when={canRollback()}>
                              <button
                                class="cloud-button"
                                data-variant="warning"
                                type="button"
                                disabled={deploymentActionId() === deployment.id}
                                onClick={() =>
                                  requestConfirm(`rollback-${deployment.id}`, () => void rollbackRelease(deployment))
                                }
                              >
                                {confirmId() === `rollback-${deployment.id}` ? "Confirm rollback?" : "Roll back"}
                              </button>
                            </Show>
                            <Show when={failedChecks().length}>
                              <button
                                class="cloud-button"
                                data-variant="primary"
                                type="button"
                                onClick={() => repairDeployment(deployment)}
                              >
                                Fix this deploy
                              </button>
                            </Show>
                            <button
                              class="cloud-button"
                              type="button"
                              disabled={!publish || publishing()}
                              onClick={() =>
                                deployment.environment === "production"
                                  ? requestConfirm(
                                      `redeploy-${deployment.id}`,
                                      () => void runPublish({ environment: "production" }),
                                    )
                                  : void runPublish({ environment: "preview" })
                              }
                            >
                              {confirmId() === `redeploy-${deployment.id}` ? "Confirm production release?" : "Redeploy"}
                            </button>
                            <button
                              class="cloud-button"
                              type="button"
                              onClick={() => void copyDeploymentUrl(deployment)}
                            >
                              {copiedId() === deployment.id ? "Copied" : "Copy"}
                            </button>
                            <button class="cloud-button" type="button" onClick={() => openDeploymentUrl(deployment)}>
                              Open
                            </button>
                            <button
                              class="cloud-button"
                              data-variant="danger"
                              type="button"
                              disabled={!api || deployment.releaseStatus === "current"}
                              title={
                                deployment.releaseStatus === "current"
                                  ? "Promote another release before removing the live version."
                                  : undefined
                              }
                              onClick={() =>
                                requestConfirm(
                                  `remove-deployment-${deployment.id}`,
                                  () => void removeDeployment(deployment),
                                )
                              }
                            >
                              {confirmId() === `remove-deployment-${deployment.id}` ? "Confirm remove?" : "Remove"}
                            </button>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>

            {/* Logs */}
            <Show when={section() === "logs"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Build and runtime output</div>
                  <h1>Logs</h1>
                  <p>
                    Read the output attached to each deployment. Vector asks the linked provider for runtime logs when
                    available and falls back to its recorded build and check evidence.
                  </p>
                </div>
              </div>
              <Show
                when={deployments().length}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("logs")}
                    </svg>
                    <strong>No deployment logs yet</strong>
                    <p>Publish this repository once and its build and runtime evidence will appear here.</p>
                  </div>
                }
              >
                <div class="cloud-list">
                  <For each={deployments()}>
                    {(deployment) => (
                      <div class="cloud-row cloud-row-block">
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="cloud-health-dot" data-status={deployment.status} />
                            <strong class="truncate text-[13px] text-white/85">{deployment.name}</strong>
                            <span class="cloud-status">{deployment.target}</span>
                            <span class="cloud-status">{deployment.environment}</span>
                          </div>
                          <p class="cloud-muted mt-1 text-[11px]">
                            {deployment.runtimeLogFetchedAt
                              ? `Runtime output fetched ${formatDate(deployment.runtimeLogFetchedAt)}`
                              : `Built ${formatDate(deployment.createdAt)}`}
                          </p>
                          <Show when={expandedLogId() === deployment.id}>
                            <pre class="cloud-log mt-3">
                              {deployment.runtimeLog ?? deployment.log ?? "No output was returned for this deployment."}
                            </pre>
                          </Show>
                        </div>
                        <div class="cloud-deployment-actions">
                          <button
                            class="cloud-button"
                            type="button"
                            disabled={!api || deploymentActionId() === deployment.id}
                            onClick={() => void readRuntimeLogs(deployment)}
                          >
                            {deploymentActionId() === deployment.id ? "Loading…" : "Read logs"}
                          </button>
                          <button class="cloud-button" type="button" onClick={() => openDeploymentUrl(deployment)}>
                            Open release
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>

            {/* Observability */}
            <Show when={section() === "observability"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Runtime evidence</div>
                  <h1>Observability</h1>
                  <p>
                    Probe every live URL from Vector and keep the latest HTTP status, response time, and failure reason
                    with this project.
                  </p>
                </div>
              </div>
              <Show
                when={deployments().length}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("observability")}
                    </svg>
                    <strong>No deployments to monitor</strong>
                    <p>Publish a preview or production release first.</p>
                  </div>
                }
              >
                <div class="mb-3 flex items-center justify-between gap-3">
                  <span class="cloud-muted text-[12px]">
                    {deployments().filter((item) => item.status === "ready").length} healthy ·{" "}
                    {deployments().filter((item) => item.status === "degraded" || item.status === "unreachable").length}{" "}
                    need attention
                  </span>
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    disabled={!api || checkingAll()}
                    onClick={() => void checkAllDeployments()}
                  >
                    {checkingAll() ? "Checking all…" : "Check all"}
                  </button>
                </div>
                <div class="cloud-list">
                  <For each={deployments()}>
                    {(deployment) => (
                      <div class="cloud-row">
                        <span class="cloud-health-dot" data-status={deployment.status} />
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <strong class="truncate text-[13px] text-white/85">{deployment.name}</strong>
                            <span
                              class="cloud-status"
                              data-tone={
                                deployment.status === "ready"
                                  ? "success"
                                  : deployment.status === "unknown"
                                    ? undefined
                                    : "error"
                              }
                            >
                              {deployment.status === "unknown" ? "not checked" : deployment.status}
                            </span>
                          </div>
                          <p class="cloud-muted mt-1 truncate text-[11px]">
                            {cleanDeploymentUrl(deployment.url) || deployment.url}
                          </p>
                          <Show when={deployment.healthError}>
                            <p class="mt-1 text-[11px] text-[#f0b3b6]">{deployment.healthError}</p>
                          </Show>
                        </div>
                        <div class="cloud-observation">
                          <span>HTTP</span>
                          <strong>{deployment.statusCode ?? "—"}</strong>
                        </div>
                        <div class="cloud-observation">
                          <span>Latency</span>
                          <strong>{formatDuration(deployment.latencyMs)}</strong>
                        </div>
                        <button
                          class="cloud-button"
                          type="button"
                          disabled={!api || checkingId() === deployment.id}
                          onClick={() => void checkDeployment(deployment)}
                        >
                          {checkingId() === deployment.id ? "Checking…" : "Check"}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>

            {/* Domains */}
            <Show when={section() === "domains"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Bring your own domain</div>
                  <h1>Domains</h1>
                  <p>
                    Attach a domain you own to the linked Vercel project for <strong>{projectName()}</strong>. Vector
                    performs the provider action and checks the result.
                  </p>
                </div>
              </div>
              <Show
                when={props.projectPath}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("domains")}
                    </svg>
                    <strong>No project open</strong>
                    <p>Open a project to connect a custom domain to it.</p>
                  </div>
                }
              >
                <div class="cloud-panel">
                  <div class="cloud-panel-title">Connect a domain</div>
                  <Show
                    when={providerLinks().length}
                    fallback={
                      <div class="cloud-inline-empty mt-3">
                        <span>Link a Vercel project before connecting a domain.</span>
                        <button class="cloud-button" type="button" onClick={() => setSection("connections")}>
                          Open Connections
                        </button>
                      </div>
                    }
                  >
                    <form
                      class="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void addDomain()
                      }}
                    >
                      <input
                        class="cloud-input min-w-0"
                        value={domainDraft()}
                        onInput={(event) => setDomainDraft(event.currentTarget.value)}
                        placeholder="app.yourdomain.com"
                      />
                      <button
                        class="cloud-button"
                        data-variant="primary"
                        type="submit"
                        disabled={!api || !props.projectPath || !domainDraft().trim() || !providerLink("vercel")}
                      >
                        Add domain
                      </button>
                    </form>
                  </Show>
                </div>
                <Show when={domains().length}>
                  <div class="cloud-list mt-3">
                    <For each={domains()}>
                      {(domain) => (
                        <div class="cloud-row cloud-row-block">
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <strong class="text-[13px] text-white/85">{domain.domain}</strong>
                              <span class="cloud-provider-chip">{providerLabel(domain.provider)}</span>
                              <span
                                class="cloud-status"
                                data-tone={
                                  domain.status === "verified"
                                    ? "success"
                                    : domain.status === "error"
                                      ? "error"
                                      : "warning"
                                }
                              >
                                {domain.status}
                              </span>
                            </div>
                            <div class="cloud-code mt-2">
                              CNAME {domain.domain} → {domain.cnameTarget}
                            </div>
                            <Show when={domain.providerProjectName}>
                              <p class="cloud-muted mt-1 text-[11px]">Attached to {domain.providerProjectName}</p>
                            </Show>
                            <Show when={domain.detail}>
                              <p class="cloud-muted mt-1 text-[11px]">{domain.detail}</p>
                            </Show>
                          </div>
                          <div class="flex shrink-0 items-center gap-2">
                            <button
                              class="cloud-button"
                              type="button"
                              disabled={!api || verifyingId() === domain.id}
                              onClick={() => void verifyDomain(domain)}
                            >
                              {verifyingId() === domain.id ? "Checking…" : "Verify"}
                            </button>
                            <button
                              class="cloud-button"
                              data-variant="danger"
                              type="button"
                              disabled={!api}
                              onClick={() =>
                                requestConfirm(`remove-domain-${domain.id}`, () => void removeDomain(domain))
                              }
                            >
                              {confirmId() === `remove-domain-${domain.id}` ? "Confirm remove?" : "Remove"}
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>

            {/* Environment */}
            <Show when={section() === "environment"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Secrets & config</div>
                  <h1>Environment variables</h1>
                  <p>
                    Manage variables for <strong>{projectName()}</strong>. Write them locally, or securely sync them to
                    a linked Vercel project through your authorized account.
                  </p>
                </div>
              </div>
              <Show
                when={props.projectPath}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("environment")}
                    </svg>
                    <strong>No project open</strong>
                    <p>Open a project to manage its environment variables.</p>
                  </div>
                }
              >
                <div class="cloud-panel">
                  <div class="cloud-panel-title">Add a variable</div>
                  <p class="cloud-muted mt-1 text-[12px]">
                    Values are encrypted on this device. Server-only values can never use a browser-visible name such as
                    VITE_ or NEXT_PUBLIC_.
                  </p>
                  <form
                    class="mt-3 flex flex-wrap gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void environment.save()
                    }}
                  >
                    <input
                      class="cloud-input w-[220px] font-mono"
                      value={environment.state.key}
                      onInput={(event) => environment.setKey(event.currentTarget.value)}
                      placeholder="API_KEY"
                      aria-label="Variable name"
                      autocomplete="off"
                      spellcheck={false}
                      disabled={Boolean(environment.state.busy)}
                    />
                    <input
                      class="cloud-input flex-1"
                      value={environment.state.value}
                      onInput={(event) => environment.setValue(event.currentTarget.value)}
                      placeholder="value"
                      aria-label="Variable value"
                      type="password"
                      autocomplete="off"
                      spellcheck={false}
                      disabled={Boolean(environment.state.busy)}
                    />
                    <select
                      class="cloud-input"
                      aria-label="Who can read this value"
                      value={environment.state.visibility}
                      onChange={(event) => {
                        const value = event.currentTarget.value
                        environment.setVisibility(value === "public" || value === "server" ? value : "")
                      }}
                      disabled={Boolean(environment.state.busy)}
                    >
                      <option value="">From the name</option>
                      <option value="server">Server only</option>
                      <option value="public">Public (browser)</option>
                    </select>
                    <button
                      class="cloud-button"
                      data-variant="primary"
                      type="submit"
                      disabled={!api || !environment.state.key.trim() || Boolean(environment.state.busy)}
                    >
                      Add
                    </button>
                  </form>
                </div>
                <div class="mt-3 flex items-center justify-between">
                  <span class="cloud-muted text-[12px]">
                    {envVars().length} {envVars().length === 1 ? "variable" : "variables"}
                  </span>
                  <div class="flex flex-wrap items-center justify-end gap-2">
                    <button
                      class="cloud-button"
                      type="button"
                      disabled={!api || !environment.state.loaded || Boolean(environment.state.busy)}
                      onClick={() => void environment.apply()}
                    >
                      Write to .env
                    </button>
                    <For each={providerLinks()}>
                      {(link) => (
                        <button
                          class="cloud-button"
                          data-variant="primary"
                          type="button"
                          disabled={!api || !envVars().length || Boolean(environment.state.busy)}
                          onClick={() => void environment.sync(link.provider)}
                        >
                          {environment.state.busy === link.provider
                            ? "Syncing…"
                            : `Sync to ${providerLabel(link.provider)}`}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <div class="cloud-list mt-2">
                  <For
                    each={envVars()}
                    fallback={
                      <div class="cloud-empty">
                        <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                          {sectionIcon("environment")}
                        </svg>
                        <strong>No variables yet</strong>
                        <p>Add one above, or write the empty list to .env to clear Vector’s managed variables.</p>
                      </div>
                    }
                  >
                    {(variable) => (
                      <div class="cloud-row">
                        <code class="min-w-0 flex-1 truncate text-[12.5px] text-white/80">
                          <span class="text-[color:var(--cc-purple)]">{variable.key}</span>=
                          <span class="text-white/45">
                            {environment.state.revealedKey === variable.key ? variable.value || '""' : "••••••••••••"}
                          </span>
                        </code>
                        <span class="cloud-status" data-tone={variable.visibility === "public" ? "warning" : undefined}>
                          {variable.visibility === "public" ? "public" : "server only"}
                        </span>
                        <button class="cloud-button" type="button" onClick={() => environment.reveal(variable.key)}>
                          {environment.state.revealedKey === variable.key ? "Hide" : "Reveal"}
                        </button>
                        <button
                          class="cloud-button"
                          data-variant="danger"
                          type="button"
                          disabled={!api || Boolean(environment.state.busy)}
                          onClick={() => void environment.remove(variable.key)}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>

            {/* Database */}
            <Show when={section() === "database"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Data for your app</div>
                  <h1>Database</h1>
                  <p>
                    Choose a project from your connected Supabase account. Vector configures the public client values in
                    this repository without making you copy keys between dashboards.
                  </p>
                </div>
              </div>
              <Show
                when={props.projectPath}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("database")}
                    </svg>
                    <strong>No project open</strong>
                    <p>Open a project to connect a database to it.</p>
                  </div>
                }
              >
                <Show
                  when={database()}
                  fallback={
                    <div class="cloud-panel">
                      <div class="cloud-panel-title">
                        {providerConnection("supabase")?.connected ? "Choose a Supabase project" : "Connect Supabase"}
                      </div>
                      <Show
                        when={providerConnection("supabase")?.connected}
                        fallback={
                          <>
                            <p class="cloud-muted mt-1 text-[12px]">
                              Connect your Supabase account in Connections with an access token, then choose the project
                              this repository should use.
                            </p>
                            <button
                              class="cloud-button mt-3"
                              data-variant="primary"
                              type="button"
                              disabled={!api}
                              onClick={() => {
                                setSection("connections")
                                if (cloudProviderConnectionMode(providerConnection("supabase")) === "token")
                                  openManualToken("supabase")
                              }}
                            >
                              Set up Supabase connection
                            </button>
                          </>
                        }
                      >
                        <p class="cloud-muted mt-1 text-[12px]">
                          Select the existing Supabase project this repository should use.
                        </p>
                        <div class="cloud-provider-linker mt-3">
                          <select
                            class="cloud-input"
                            value={providerSelections().supabase ?? ""}
                            onChange={(event) =>
                              setProviderSelections((current) => ({
                                ...current,
                                supabase: event.currentTarget.value,
                              }))
                            }
                          >
                            <option value="">Choose a Supabase project</option>
                            <For each={providerResources().supabase ?? []}>
                              {(resource) => (
                                <option value={resource.id}>
                                  {resource.name}
                                  {resource.region ? ` · ${resource.region}` : ""}
                                </option>
                              )}
                            </For>
                          </select>
                          <button
                            class="cloud-button"
                            data-variant="primary"
                            type="button"
                            disabled={!api || !providerSelections().supabase || providerBusy() === "supabase"}
                            onClick={() => void connectSupabaseProject()}
                          >
                            {providerBusy() === "supabase" ? "Connecting…" : "Use this project"}
                          </button>
                        </div>
                      </Show>
                    </div>
                  }
                >
                  {(connection) => (
                    <div class="cloud-panel cloud-gradient-edge">
                      <div class="flex items-center justify-between">
                        <div>
                          <div class="cloud-panel-title">Supabase connected</div>
                          <p class="cloud-muted mt-1 text-[12px]">
                            {connection().projectName ?? connection().projectRef ?? connection().url}
                          </p>
                          <p class="cloud-muted text-[11px]">
                            Connected {formatDate(connection().connectedAt)} ·{" "}
                            {connection().managedByOAuth ? "managed through Supabase OAuth" : "local configuration"} ·
                            client at src/lib/supabase.js
                          </p>
                        </div>
                        <button
                          class="cloud-button"
                          data-variant="danger"
                          type="button"
                          disabled={!api}
                          onClick={() => requestConfirm("disconnect-db", () => void disconnectDb())}
                        >
                          {confirmId() === "disconnect-db" ? "Confirm disconnect?" : "Disconnect"}
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
              </Show>
            </Show>

            {/* Authentication */}
            <Show when={section() === "authentication"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Supabase identity</div>
                  <h1>Authentication</h1>
                  <p>
                    Attach authentication to this repository through its linked Supabase project. Vector can prepare the
                    client configuration and your agent can implement the application code against it.
                  </p>
                </div>
              </div>
              <Show
                when={database()?.projectRef}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("authentication")}
                    </svg>
                    <strong>Connect Supabase first</strong>
                    <p>Choose Database in this sidebar, connect a project, then return here.</p>
                    <button
                      class="cloud-button mt-4"
                      data-variant="primary"
                      type="button"
                      onClick={() => setSection("database")}
                    >
                      Open Database
                    </button>
                  </div>
                }
              >
                <section class="cloud-service-list">
                  <button type="button" onClick={() => platform.openLink(supabaseDashboard("/auth/users"))}>
                    <span class="cloud-service-icon">
                      <Icon name="shield" />
                    </span>
                    <span>
                      <strong>Users</strong>
                      <small>Manage users, identities, sessions, and invitations in Supabase.</small>
                    </span>
                    <em>Open</em>
                  </button>
                  <button type="button" onClick={() => platform.openLink(supabaseDashboard("/auth/providers"))}>
                    <span class="cloud-service-icon">
                      <Icon name="providers" />
                    </span>
                    <span>
                      <strong>Sign-in providers</strong>
                      <small>Configure email, OAuth, and other supported identity providers.</small>
                    </span>
                    <em>Open</em>
                  </button>
                  <button type="button" onClick={() => platform.openLink(supabaseDashboard("/auth/policies"))}>
                    <span class="cloud-service-icon">
                      <Icon name="review" />
                    </span>
                    <span>
                      <strong>Authorization policies</strong>
                      <small>Review row-level security and access policies before release.</small>
                    </span>
                    <em>Open</em>
                  </button>
                </section>
              </Show>
            </Show>

            {/* Storage */}
            <Show when={section() === "storage"}>
              <div class="cloud-heading cloud-heading-with-action">
                <div>
                  <div class="cloud-kicker">Supabase objects</div>
                  <h1>Storage</h1>
                  <p>
                    Inspect the buckets connected to this repository without copying service credentials into Vector.
                  </p>
                </div>
                <button
                  class="cloud-button"
                  type="button"
                  disabled={supabaseServicesBusy()}
                  onClick={() => void refreshSupabaseServices()}
                >
                  {supabaseServicesBusy() ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <Show
                when={supabaseServices()?.connected}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("storage")}
                    </svg>
                    <strong>No Supabase project linked</strong>
                    <p>Connect one from Database to inspect its storage buckets.</p>
                  </div>
                }
              >
                <div class="cloud-list">
                  <For
                    each={supabaseServices()?.storage.buckets ?? []}
                    fallback={
                      <div class="cloud-empty">
                        <strong>
                          {supabaseServices()?.storage.available ? "No storage buckets" : "Storage unavailable"}
                        </strong>
                        <p>
                          {supabaseServices()?.storage.detail ??
                            "Create a bucket in Supabase when this application needs object storage."}
                        </p>
                      </div>
                    }
                  >
                    {(bucket) => (
                      <div class="cloud-row">
                        <span class="cloud-service-icon">
                          <Icon name="folder" />
                        </span>
                        <span class="min-w-0 flex-1">
                          <strong class="block truncate text-[13px] text-white/85">{bucket.name}</strong>
                          <small class="cloud-muted">
                            {bucket.public ? "Public bucket" : "Private bucket"}
                            {bucket.updatedAt ? ` · updated ${formatDate(bucket.updatedAt)}` : ""}
                          </small>
                        </span>
                        <span class="cloud-status" data-tone={bucket.public ? "warning" : "success"}>
                          {bucket.public ? "public" : "private"}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
                <div class="mt-4 flex justify-end">
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    onClick={() => platform.openLink(supabaseDashboard("/storage/buckets"))}
                  >
                    Open Storage
                  </button>
                </div>
              </Show>
            </Show>

            {/* Edge Functions */}
            <Show when={section() === "functions"}>
              <div class="cloud-heading cloud-heading-with-action">
                <div>
                  <div class="cloud-kicker">Serverless logic</div>
                  <h1>Edge functions</h1>
                  <p>Inspect functions deployed in the Supabase project attached to this repository.</p>
                </div>
                <button
                  class="cloud-button"
                  type="button"
                  disabled={supabaseServicesBusy()}
                  onClick={() => void refreshSupabaseServices()}
                >
                  {supabaseServicesBusy() ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <Show
                when={supabaseServices()?.connected}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("functions")}
                    </svg>
                    <strong>No Supabase project linked</strong>
                    <p>Connect a database project before inspecting its Edge Functions.</p>
                  </div>
                }
              >
                <div class="cloud-list">
                  <For
                    each={supabaseServices()?.functions.functions ?? []}
                    fallback={
                      <div class="cloud-empty">
                        <strong>
                          {supabaseServices()?.functions.available ? "No Edge Functions" : "Functions unavailable"}
                        </strong>
                        <p>
                          {supabaseServices()?.functions.detail ??
                            "No functions have been deployed in this Supabase project."}
                        </p>
                      </div>
                    }
                  >
                    {(fn) => (
                      <div class="cloud-row">
                        <span class="cloud-service-icon">
                          <Icon name="code" />
                        </span>
                        <span class="min-w-0 flex-1">
                          <strong class="block truncate text-[13px] text-white/85">{fn.name}</strong>
                          <small class="cloud-muted">
                            {fn.slug}
                            {fn.version ? ` · version ${fn.version}` : ""}
                          </small>
                        </span>
                        <Show when={fn.status}>
                          <span class="cloud-status">{fn.status}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <div class="mt-4 flex justify-end">
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    onClick={() => platform.openLink(supabaseDashboard("/functions"))}
                  >
                    Open Functions
                  </button>
                </div>
              </Show>
            </Show>

            {/* Build and runtime */}
            <Show when={section() === "settings"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Build pipeline</div>
                  <h1>Build & runtime</h1>
                  <p>
                    Detect the project framework and keep its install, build, output, and Node settings attached to this
                    repository. Vector Cloud uses these settings for its build before publishing.
                  </p>
                </div>
              </div>
              <Show
                when={props.projectPath}
                fallback={
                  <div class="cloud-empty">
                    <svg viewBox="0 0 16 16" class="cloud-empty-icon" aria-hidden="true">
                      {sectionIcon("settings")}
                    </svg>
                    <strong>No project open</strong>
                    <p>Open a project to configure its build pipeline.</p>
                  </div>
                }
              >
                <div class="cloud-panel">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div class="cloud-panel-title">Project configuration</div>
                      <p class="cloud-muted mt-1 text-[12px]">
                        {buildSettings()
                          ? `${buildSettings()?.source === "detected" ? "Detected" : "Saved"} ${formatDate(buildSettings()?.updatedAt)}`
                          : "No build settings saved yet."}
                      </p>
                    </div>
                    <button
                      class="cloud-button"
                      type="button"
                      disabled={!api || detectingBuild()}
                      onClick={() => void detectBuild()}
                    >
                      {detectingBuild() ? "Detecting…" : "Detect from project"}
                    </button>
                  </div>
                  <div class="cloud-form-grid mt-5">
                    <label>
                      <span>Framework</span>
                      <input
                        class="cloud-input w-full"
                        value={buildDraft().framework}
                        onInput={(event) =>
                          setBuildDraft((current) => ({ ...current, framework: event.currentTarget.value }))
                        }
                        placeholder="Vite, Next.js, Astro…"
                      />
                    </label>
                    <label>
                      <span>Package manager</span>
                      <select
                        class="cloud-input w-full"
                        value={buildDraft().packageManager}
                        onChange={(event) => {
                          const value = event.currentTarget.value
                          if (isPackageManager(value))
                            setBuildDraft((current) => ({ ...current, packageManager: value }))
                        }}
                      >
                        <option value="bun">bun</option>
                        <option value="pnpm">pnpm</option>
                        <option value="yarn">yarn</option>
                        <option value="npm">npm</option>
                        <option value="static">static</option>
                      </select>
                    </label>
                    <label>
                      <span>Install command</span>
                      <input
                        class="cloud-input w-full font-mono"
                        value={buildDraft().installCommand}
                        onInput={(event) =>
                          setBuildDraft((current) => ({ ...current, installCommand: event.currentTarget.value }))
                        }
                        placeholder="bun install"
                      />
                    </label>
                    <label>
                      <span>Test command</span>
                      <input
                        class="cloud-input w-full font-mono"
                        value={buildDraft().testCommand}
                        onInput={(event) =>
                          setBuildDraft((current) => ({ ...current, testCommand: event.currentTarget.value }))
                        }
                        placeholder="bun test"
                      />
                    </label>
                    <label>
                      <span>Build command</span>
                      <input
                        class="cloud-input w-full font-mono"
                        value={buildDraft().buildCommand}
                        onInput={(event) =>
                          setBuildDraft((current) => ({ ...current, buildCommand: event.currentTarget.value }))
                        }
                        placeholder="bun run build"
                      />
                    </label>
                    <label>
                      <span>Output directory</span>
                      <input
                        class="cloud-input w-full font-mono"
                        value={buildDraft().outputDirectory}
                        onInput={(event) =>
                          setBuildDraft((current) => ({ ...current, outputDirectory: event.currentTarget.value }))
                        }
                        placeholder="dist"
                      />
                    </label>
                    <label>
                      <span>Node version</span>
                      <input
                        class="cloud-input w-full font-mono"
                        value={buildDraft().nodeVersion}
                        onInput={(event) =>
                          setBuildDraft((current) => ({ ...current, nodeVersion: event.currentTarget.value }))
                        }
                        placeholder="20.x"
                      />
                    </label>
                    <label>
                      <span>Health check path</span>
                      <input
                        class="cloud-input w-full font-mono"
                        value={buildDraft().healthPath}
                        onInput={(event) =>
                          setBuildDraft((current) => ({ ...current, healthPath: event.currentTarget.value }))
                        }
                        placeholder="/api/health"
                      />
                    </label>
                  </div>
                  <div class="cloud-check-config mt-5">
                    <div>
                      <strong>Required release checks</strong>
                      <p>Production promotion stops when a required check fails.</p>
                    </div>
                    <For
                      each={[
                        { key: "test" as const, label: "Tests" },
                        { key: "secrets" as const, label: "Secret scan" },
                        { key: "health" as const, label: "Health probe" },
                        { key: "browser" as const, label: "Browser render" },
                      ]}
                    >
                      {(item) => (
                        <label class="cloud-check-toggle">
                          <input
                            type="checkbox"
                            checked={buildDraft().requiredChecks[item.key]}
                            onChange={(event) =>
                              setBuildDraft((current) => ({
                                ...current,
                                requiredChecks: { ...current.requiredChecks, [item.key]: event.currentTarget.checked },
                              }))
                            }
                          />
                          <span>{item.label}</span>
                        </label>
                      )}
                    </For>
                  </div>
                  <div class="mt-5 flex justify-end">
                    <button
                      class="cloud-button"
                      data-variant="primary"
                      type="button"
                      disabled={!api || savingBuild()}
                      onClick={() => void saveBuild()}
                    >
                      {savingBuild() ? "Saving…" : "Save build settings"}
                    </button>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </main>
      </div>
    </section>
  )
}
