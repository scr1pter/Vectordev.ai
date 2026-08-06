import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import {
  cloudAgentWorkspaceApi,
  cloudApi,
  publishApi,
  type CloudAgentWorkspace,
  type CloudBuildSettings,
  type CloudDeployment,
  type CloudDomain,
  type CloudDomainProvider,
  type CloudEnvVar,
  type CloudDatabaseConnection,
  type CloudProviderConnection,
  type CloudProviderId,
  type CloudProviderProjectLink,
  type CloudProviderResource,
  type PublishProgressEvent,
  type PublishTarget,
  type PublishTargetId,
} from "./cloud-api"
import "./cloud-console.css"

export type CloudSection =
  | "connections"
  | "deployments"
  | "observability"
  | "domains"
  | "environment"
  | "database"
  | "settings"
type Notice = { tone: "info" | "success" | "error"; text: string }
type BuildDraft = Omit<CloudBuildSettings, "source" | "updatedAt">

const SECTIONS: { id: CloudSection; label: string }[] = [
  { id: "connections", label: "Connections" },
  { id: "deployments", label: "Deployments" },
  { id: "observability", label: "Observability" },
  { id: "domains", label: "Domains" },
  { id: "environment", label: "Environment" },
  { id: "database", label: "Database" },
  { id: "settings", label: "Build & runtime" },
]

// Stroke icons for the nav and empty states — matches the shell's SVG icon
// language (viewBox 0 0 16 16, currentColor stroke) instead of glyph fonts.
function sectionIcon(id: CloudSection) {
  switch (id) {
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

function isPublishTargetId(value: string): value is PublishTargetId {
  return value === "vector-cloud" || value === "vercel" || value === "netlify"
}

function isPackageManager(value: string): value is BuildDraft["packageManager"] {
  return value === "bun" || value === "pnpm" || value === "yarn" || value === "npm" || value === "static"
}

function providerLabel(provider: CloudProviderId) {
  if (provider === "vercel") return "Vercel"
  if (provider === "netlify") return "Netlify"
  return "Supabase"
}

export function CloudConsole(props: {
  projectPath: string
  taskId?: string
  onClose: () => void
  onRepair?: (context: string) => void
  initialSection?: CloudSection
  embedded?: boolean
}) {
  const platform = usePlatform()
  const macDesktop = platform.platform === "desktop" && platform.os === "macos"
  const api = cloudApi()
  const publish = publishApi()
  const workspaceApi = cloudAgentWorkspaceApi()
  const [section, setSection] = createSignal<CloudSection>(props.initialSection ?? "deployments")
  const [notice, setNotice] = createSignal<Notice>()

  const [publishTargets, setPublishTargets] = createSignal<PublishTarget[]>([])
  const [publishTargetId, setPublishTargetId] = createSignal<PublishTargetId>("vercel")
  const [deploymentEnvironment, setDeploymentEnvironment] = createSignal<"preview" | "production">("production")
  const [publishing, setPublishing] = createSignal(false)
  const [activeRunId, setActiveRunId] = createSignal("")
  const [publishEvents, setPublishEvents] = createSignal<PublishProgressEvent[]>([])

  const [deployments, setDeployments] = createSignal<CloudDeployment[]>([])
  const [agentWorkspaces, setAgentWorkspaces] = createSignal<CloudAgentWorkspace[]>([])
  const [domains, setDomains] = createSignal<CloudDomain[]>([])
  const [envVars, setEnvVars] = createSignal<CloudEnvVar[]>([])
  const [database, setDatabase] = createSignal<CloudDatabaseConnection>(null)
  const [connections, setConnections] = createSignal<CloudProviderConnection[]>([])
  const [providerResources, setProviderResources] = createSignal<
    Partial<Record<CloudProviderId, CloudProviderResource[]>>
  >({})
  const [providerLinks, setProviderLinks] = createSignal<CloudProviderProjectLink[]>([])
  const [providerSelections, setProviderSelections] = createSignal<Partial<Record<CloudProviderId, string>>>({})
  const [providerBusy, setProviderBusy] = createSignal<CloudProviderId | "">("")
  const [buildSettings, setBuildSettings] = createSignal<CloudBuildSettings | null>(null)
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
  const [domainProvider, setDomainProvider] = createSignal<Exclude<CloudDomainProvider, "vector-cloud">>("vercel")
  const [envKey, setEnvKey] = createSignal("")
  const [envValue, setEnvValue] = createSignal("")
  const [syncingProvider, setSyncingProvider] = createSignal<"vercel" | "netlify" | "">("")
  const [verifyingId, setVerifyingId] = createSignal("")
  const [confirmId, setConfirmId] = createSignal("")
  const [copiedId, setCopiedId] = createSignal("")
  const [revealedEnvKey, setRevealedEnvKey] = createSignal("")
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
    const isCurrent = () => props.projectPath === projectPath && props.taskId === taskId
    const [nextDeployments, nextDomains, nextEnv, nextDatabase, nextBuild, nextWorkspaces, nextConnections, nextLinks] =
      await Promise.all([
        api.deployments.list(projectPath, taskId).catch(() => []),
        projectPath ? api.domains.list(projectPath, taskId).catch(() => []) : Promise.resolve([]),
        projectPath ? api.env.list(projectPath, taskId).catch(() => []) : Promise.resolve([]),
        projectPath ? api.database.get(projectPath, taskId).catch(() => null) : Promise.resolve(null),
        projectPath ? api.build.get(projectPath, taskId).catch(() => null) : Promise.resolve(null),
        projectPath && workspaceApi
          ? workspaceApi.list({ sourcePath: projectPath, parentSessionId: taskId }).catch(() => [])
          : Promise.resolve([]),
        api.connections.list().catch(() => []),
        projectPath ? api.providers.links(projectPath, taskId).catch(() => []) : Promise.resolve([]),
      ])
    if (!isCurrent()) return
    setDeployments(nextDeployments)
    setDomains(nextDomains)
    setEnvVars(nextEnv)
    setDatabase(nextDatabase)
    setBuildSettings(nextBuild)
    setAgentWorkspaces(nextWorkspaces)
    setConnections(nextConnections)
    setProviderLinks(nextLinks)
    if (!nextLinks.some((item) => item.provider === domainProvider())) {
      const first = nextLinks.find((item) => item.provider === "vercel" || item.provider === "netlify")
      if (first) setDomainProvider(first.provider)
    }
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
    props.projectPath
    props.taskId
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
        text:
          deployment.target === "vector-cloud"
            ? `Unpublished ${deployment.name}.`
            : `Removed ${deployment.name} from Vector's deployment history. Manage the live site in ${deployment.target === "vercel" ? "Vercel" : "Netlify"}.`,
      })
    } catch {
      setNotice({ tone: "error", text: `Could not remove ${deployment.name} — try again.` })
    }
  }

  const runPublish = async (override?: {
    target?: PublishTargetId
    environment?: "preview" | "production"
    workspace?: CloudAgentWorkspace
  }) => {
    if (!publish || !props.projectPath) return
    const targetId = override?.target ?? publishTargetId()
    const environment = override?.environment ?? deploymentEnvironment()
    const target = publishTargets().find((item) => item.id === targetId)
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
        : `Publishing a ${environment} release to ${target?.label ?? targetId}… this can take a minute.`,
    })
    try {
      const result = await publish.run({
        projectPath: override?.workspace?.isolatedPath ?? props.projectPath,
        taskId: props.taskId,
        scopeProjectPath: override?.workspace ? props.projectPath : undefined,
        scopeTaskId: override?.workspace ? props.taskId : undefined,
        workspaceId: override?.workspace?.id,
        workspaceName: override?.workspace?.name,
        target: targetId,
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
          text: result.error ?? "Publish failed — make sure the CLI is installed and you're logged in.",
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

  const repairDeployment = async (deployment: CloudDeployment) => {
    const evidence = [
      `Repair the deployment for ${deployment.name}.`,
      `Deployment: ${cleanDeploymentUrl(deployment.url) || deployment.url}`,
      deployment.git
        ? `Git: ${deployment.git.branch} at ${deployment.git.commitShort}${deployment.git.dirty ? " (dirty)" : ""}`
        : "",
      ...deployment.checks
        .filter((check) => check.status === "failed")
        .map((check) => `${check.label}: ${check.details ?? "failed"}\n${check.output ?? ""}`),
      deployment.runtimeLog ?? deployment.log ?? "",
      "Find the root cause, make the smallest safe fix, run the relevant checks, and explain what changed.",
    ]
      .filter(Boolean)
      .join("\n\n")
    if (props.onRepair) {
      props.onRepair(evidence)
      return
    }
    await navigator.clipboard?.writeText(evidence).catch(() => undefined)
    setNotice({ tone: "info", text: "Repair context copied. Return to the agent and paste it into the composer." })
  }

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
    const provider = domainProvider()
    if (!providerLink(provider)) {
      setNotice({ tone: "error", text: `Link a ${providerLabel(provider)} project before adding a domain.` })
      return
    }
    try {
      await api.providers.addDomain(props.projectPath, props.taskId, provider, domainDraft().trim())
      setDomainDraft("")
      setDomains(await api.domains.list(props.projectPath, props.taskId))
      setNotice({
        tone: "success",
        text: `Domain attached to ${providerLabel(provider)}. Configure the DNS record shown, then verify.`,
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not add domain." })
    }
  }
  const verifyDomain = async (domain: CloudDomain) => {
    if (!api || !props.projectPath) return
    setVerifyingId(domain.id)
    try {
      const updated =
        domain.provider === "vector-cloud"
          ? await api.domains.verify(props.projectPath, props.taskId, domain.id)
          : await api.providers.verifyDomain(props.projectPath, props.taskId, domain.id)
      setDomains((list) => list.map((item) => (item.id === updated.id ? updated : item)))
      setNotice(
        updated.status === "verified"
          ? {
              tone: "success",
              text:
                updated.provider === "vector-cloud"
                  ? `${updated.domain} DNS is verified.`
                  : `${updated.domain} is verified on ${providerLabel(updated.provider)}.`,
            }
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
      setDomains(
        domain.provider === "vector-cloud"
          ? await api.domains.remove(props.projectPath, props.taskId, domain.id)
          : await api.providers.removeDomain(props.projectPath, props.taskId, domain.id),
      )
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not remove domain — try again.",
      })
    }
  }

  // --- Environment ---------------------------------------------------------
  const addEnv = async () => {
    if (!api || !props.projectPath || !envKey().trim()) return
    try {
      setEnvVars(await api.env.set(props.projectPath, props.taskId, envKey().trim(), envValue()))
      setEnvKey("")
      setEnvValue("")
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Invalid variable name." })
    }
  }
  const removeEnv = async (key: string) => {
    if (!api || !props.projectPath) return
    try {
      setEnvVars(await api.env.remove(props.projectPath, props.taskId, key))
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not remove variable — try again.",
      })
    }
  }
  const applyEnv = async () => {
    if (!api || !props.projectPath) return
    try {
      const result = await api.env.apply(props.projectPath, props.taskId)
      const count = envVars().length
      setNotice({
        tone: "success",
        text: `Wrote ${count} ${count === 1 ? "variable" : "variables"} to ${result.written} in your project.`,
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not write .env." })
    }
  }

  const syncEnvironment = async (provider: "vercel" | "netlify") => {
    if (!api || !props.projectPath) return
    setSyncingProvider(provider)
    try {
      const result = await api.providers.syncEnvironment(props.projectPath, props.taskId, provider)
      setNotice({ tone: "success", text: result.detail })
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : `Could not sync variables to ${providerLabel(provider)}.`,
      })
    } finally {
      setSyncingProvider("")
    }
  }

  // --- Provider connections ------------------------------------------------
  const providerConnection = (provider: CloudProviderId) => connections().find((item) => item.provider === provider)
  const providerLink = (provider: "vercel" | "netlify") => providerLinks().find((item) => item.provider === provider)

  const connectProvider = async (provider: CloudProviderId) => {
    if (!api) return
    setProviderBusy(provider)
    try {
      const connection = await api.connections.connect(provider)
      setConnections((items) => [connection, ...items.filter((item) => item.provider !== provider)])
      const resources = await api.providers.resources(provider)
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

  const linkProviderProject = async (provider: "vercel" | "netlify") => {
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

  const unlinkProviderProject = async (provider: "vercel" | "netlify") => {
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
    setProviderBusy("supabase")
    try {
      const connection = await api.database.connectProject(props.projectPath, props.taskId, projectRef)
      setDatabase(connection)
      setEnvVars(await api.env.list(props.projectPath, props.taskId))
      setNotice({
        tone: "success",
        text: `${connection?.projectName ?? "Supabase"} connected. Vector configured the project locally without asking you to copy API keys.`,
      })
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not connect the database." })
    } finally {
      setProviderBusy("")
    }
  }
  const disconnectDb = async () => {
    if (!api || !props.projectPath) return
    try {
      await api.database.disconnect(props.projectPath, props.taskId)
      setDatabase(null)
      setNotice({ tone: "info", text: "Supabase disconnected. Your .env keys were left in place." })
    } catch (error) {
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
          <div class="text-[13px] font-semibold text-white">Cloud Services</div>
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
          <For each={SECTIONS}>
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

            {/* Connections */}
            <Show when={section() === "connections"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Your accounts</div>
                  <h1>Cloud connections</h1>
                  <p>
                    Sign in once, then let Vector publish, link projects, and configure your database through your own
                    accounts. Provider tokens stay encrypted on this device.
                  </p>
                </div>
              </div>
              <div class="cloud-connection-list">
                <For each={["vercel", "netlify", "supabase"] as CloudProviderId[]}>
                  {(provider) => {
                    const connection = () => providerConnection(provider)
                    const linked = () => (provider === "supabase" ? undefined : providerLink(provider))
                    const resources = () => providerResources()[provider] ?? []
                    return (
                      <section class="cloud-panel cloud-connection-card">
                        <div class="cloud-provider-mark" data-provider={provider}>
                          {provider === "vercel" ? "V" : provider === "netlify" ? "N" : "S"}
                        </div>
                        <div class="cloud-connection-main">
                          <div class="flex items-center gap-2">
                            <div class="cloud-panel-title">{providerLabel(provider)}</div>
                            <span
                              class="cloud-status"
                              data-tone={
                                connection()?.connected ? "success" : connection()?.configured ? undefined : "warning"
                              }
                            >
                              {connection()?.connected
                                ? "Connected"
                                : connection()?.configured
                                  ? "Not connected"
                                  : "Setup required"}
                            </span>
                          </div>
                          <p class="cloud-muted mt-1 text-[12px]">
                            {connection()?.connected
                              ? connection()?.account
                                ? `Signed in as ${connection()?.account}`
                                : "Account authorized"
                              : (connection()?.detail ?? "Checking provider availability…")}
                          </p>

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
                                    onClick={() => void linkProviderProject(provider as "vercel" | "netlify")}
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
                                    onClick={() => void unlinkProviderProject(provider as "vercel" | "netlify")}
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
                            when={connection()?.connected}
                            fallback={
                              <button
                                class="cloud-button"
                                data-variant="primary"
                                type="button"
                                disabled={!api || !connection()?.configured || providerBusy() === provider}
                                onClick={() => void connectProvider(provider)}
                              >
                                {providerBusy() === provider
                                  ? "Waiting for sign-in…"
                                  : `Connect ${providerLabel(provider)}`}
                              </button>
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
                    Vector runs the whole deploy on your own Vercel or Netlify account — authorize once, then it's a
                    single click. Your code is never proxied through Vector.
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
                    <For each={publishTargets()}>
                      {(target) => (
                        <button
                          type="button"
                          class="cloud-button"
                          data-variant={publishTargetId() === target.id ? "primary" : undefined}
                          title={target.available ? undefined : target.loginHint}
                          onClick={() => setPublishTargetId(target.id)}
                        >
                          {target.label}
                          {target.available ? "" : " · setup needed"}
                        </button>
                      )}
                    </For>
                    <button
                      class="cloud-button ml-auto"
                      data-variant="primary"
                      type="button"
                      disabled={!publish || publishing()}
                      onClick={() => void runPublish()}
                    >
                      {publishing() ? "Publishing…" : "Publish →"}
                    </button>
                  </div>
                  <Show when={publish && publishTargets().find((item) => item.id === publishTargetId())}>
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
                  <Show
                    when={publish && publishTargets().length > 0 && !publishTargets().some((item) => item.available)}
                  >
                    <p class="cloud-muted mt-2 text-[11px]">
                      No publisher detected. Install the Vercel CLI (<code>npm i -g vercel</code>) and run{" "}
                      <code>vercel login</code> in Terminal, then reopen this panel.
                    </p>
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
                    <div class="cloud-agent-grid mt-3">
                      <For
                        each={agentWorkspaces().filter(
                          (workspace) => workspace.isolatedPath && !["discarded", "merged"].includes(workspace.status),
                        )}
                      >
                        {(workspace) => {
                          const preview = () =>
                            deployments().find((deployment) => deployment.workspaceId === workspace.id)
                          return (
                            <div class="cloud-agent-row">
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
                    <p>Open a project, hit Publish in the preview, and your live apps appear here.</p>
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
                        deployment.releaseStatus === "preview" &&
                        !deployment.workspaceId &&
                        (deployment.target === "vector-cloud" || deployment.target === "vercel") &&
                        failedChecks().length === 0
                      const canRollback = () =>
                        (deployment.releaseStatus === "superseded" || deployment.releaseStatus === "rolled-back") &&
                        (deployment.target === "vector-cloud" || deployment.target === "vercel") &&
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
                                onClick={() => void repairDeployment(deployment)}
                              >
                                Repair with Vector
                              </button>
                            </Show>
                            <Show when={isPublishTargetId(deployment.target) ? deployment.target : undefined}>
                              {(targetId) => (
                                <button
                                  class="cloud-button"
                                  type="button"
                                  disabled={!publish || publishing()}
                                  onClick={() =>
                                    void runPublish({ target: targetId(), environment: deployment.environment })
                                  }
                                >
                                  Redeploy
                                </button>
                              )}
                            </Show>
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
                    Attach a domain you own to the linked Vercel or Netlify project for <strong>{projectName()}</strong>
                    . Vector performs the provider action and checks the result.
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
                        <span>Link a Vercel or Netlify project before connecting a domain.</span>
                        <button class="cloud-button" type="button" onClick={() => setSection("connections")}>
                          Open Connections
                        </button>
                      </div>
                    }
                  >
                    <form
                      class="mt-3 grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_auto]"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void addDomain()
                      }}
                    >
                      <select
                        class="cloud-input"
                        value={domainProvider()}
                        onChange={(event) =>
                          setDomainProvider(event.currentTarget.value as Exclude<CloudDomainProvider, "vector-cloud">)
                        }
                      >
                        <For each={providerLinks()}>
                          {(link) => <option value={link.provider}>{providerLabel(link.provider)}</option>}
                        </For>
                      </select>
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
                        disabled={
                          !api || !props.projectPath || !domainDraft().trim() || !providerLink(domainProvider())
                        }
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
                              <span class="cloud-provider-chip">
                                {domain.provider === "vector-cloud" ? "Legacy DNS" : providerLabel(domain.provider)}
                              </span>
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
                    a linked Vercel or Netlify project through your authorized account.
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
                  <form
                    class="mt-3 flex flex-wrap gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void addEnv()
                    }}
                  >
                    <input
                      class="cloud-input w-[220px] font-mono"
                      value={envKey()}
                      onInput={(event) => setEnvKey(event.currentTarget.value.toUpperCase())}
                      placeholder="API_KEY"
                    />
                    <input
                      class="cloud-input flex-1"
                      value={envValue()}
                      onInput={(event) => setEnvValue(event.currentTarget.value)}
                      placeholder="value"
                    />
                    <button
                      class="cloud-button"
                      data-variant="primary"
                      type="submit"
                      disabled={!api || !envKey().trim()}
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
                      disabled={!api || !envVars().length}
                      onClick={() => void applyEnv()}
                    >
                      Write to .env
                    </button>
                    <For each={providerLinks()}>
                      {(link) => (
                        <button
                          class="cloud-button"
                          data-variant="primary"
                          type="button"
                          disabled={!api || !envVars().length || Boolean(syncingProvider())}
                          onClick={() => void syncEnvironment(link.provider)}
                        >
                          {syncingProvider() === link.provider ? "Syncing…" : `Sync to ${providerLabel(link.provider)}`}
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
                        <p>Add one above. Nothing is written until you click "Write to .env".</p>
                      </div>
                    }
                  >
                    {(variable) => (
                      <div class="cloud-row">
                        <code class="min-w-0 flex-1 truncate text-[12.5px] text-white/80">
                          <span class="text-[color:var(--cc-purple)]">{variable.key}</span>=
                          <span class="text-white/45">
                            {revealedEnvKey() === variable.key ? variable.value || '""' : "••••••••••••"}
                          </span>
                        </code>
                        <button
                          class="cloud-button"
                          type="button"
                          onClick={() => setRevealedEnvKey((current) => (current === variable.key ? "" : variable.key))}
                        >
                          {revealedEnvKey() === variable.key ? "Hide" : "Reveal"}
                        </button>
                        <button
                          class="cloud-button"
                          data-variant="danger"
                          type="button"
                          disabled={!api}
                          onClick={() => void removeEnv(variable.key)}
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
                              Authorize Vector through Supabase. Your password never enters Vector.
                            </p>
                            <button
                              class="cloud-button mt-3"
                              data-variant="primary"
                              type="button"
                              disabled={
                                !api || !providerConnection("supabase")?.configured || providerBusy() === "supabase"
                              }
                              onClick={() => void connectProvider("supabase")}
                            >
                              {providerBusy() === "supabase" ? "Waiting for sign-in…" : "Connect Supabase"}
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

            {/* Build and runtime */}
            <Show when={section() === "settings"}>
              <div class="cloud-heading">
                <div>
                  <div class="cloud-kicker">Build pipeline</div>
                  <h1>Build & runtime</h1>
                  <p>
                    Detect the project framework and keep its install, build, output, and Node settings attached to this
                    repository. Cloud Services uses these settings for its build before publishing.
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
