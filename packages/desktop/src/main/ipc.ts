import { execFile } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell, systemPreferences } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"

import type { BrowserAgentInput, FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import {
  getPinchZoomEnabled,
  getWindowID,
  isTrustedRendererUrl,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import type { UpdaterController } from "./updater-controller"
import type { VectorLicenseService } from "./license-service"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { runBrowserAgent } from "./browser-agent"
import { prepareAgentTask } from "./context-budget"
import { speakVoiceText, stopVoiceSynthesis } from "./voice-synthesis"
import { cancelBackgroundTask, clearCompletedBackgroundTasks, listBackgroundTasks } from "./background-tasks"
import {
  detectPublishTargets,
  fetchDeploymentRuntimeLogs,
  promoteDeployment,
  publishProject,
  rerunDeploymentChecks,
  rollbackDeployment,
  type PublishProjectInput,
} from "./publish"
import {
  addDomain,
  applyEnv,
  checkAllDeployments,
  checkDeployment,
  connectDatabase,
  detectBuildSettings,
  disconnectDatabase,
  getBuildSettings,
  getDatabase,
  listDeployments,
  listDomains,
  listEnv,
  removeDeployment,
  removeDomain,
  removeEnv,
  setBuildSettings,
  setEnv,
  verifyDomain,
} from "./cloud-console"
import {
  addCloudProviderDomain,
  connectCloudProvider,
  connectSupabaseProject,
  disconnectCloudProvider,
  linkCloudProviderProject,
  listCloudProviderConnections,
  listCloudProviderProjectLinks,
  listCloudProviderResources,
  removeCloudProviderDomain,
  syncCloudProviderEnvironment,
  unlinkCloudProviderProject,
  verifyCloudProviderDomain,
  type CloudProviderId,
} from "./cloud-connections"
import {
  detectGithub,
  publishToGithub,
  pushWithOauth,
  type GithubOauthPushInput,
  type GithubPublishInput,
} from "./github"
import {
  cancelDeviceLogin,
  completeDeviceLogin,
  createRepo,
  getAuthStatus,
  listRepos,
  logoutGithub,
  openVerification,
  startDeviceLogin,
  type GithubCreateRepoInput,
} from "./github-auth"
import { pushWithOauth as pushToGitlab, type GitlabOauthPushInput } from "./gitlab"
import {
  cancelDeviceLogin as cancelGitlabLogin,
  completeDeviceLogin as completeGitlabLogin,
  createRepo as createGitlabRepo,
  getAuthStatus as getGitlabAuthStatus,
  listRepos as listGitlabRepos,
  logoutGitlab,
  openVerification as openGitlabVerification,
  startDeviceLogin as startGitlabLogin,
  type GitlabCreateRepoInput,
} from "./gitlab-auth"
import { detectExternalAgents, openInEditor, prepareWorkspace, type OpenInEditorInput } from "./external-agents"
import {
  createParallelWorkspace,
  discardParallelWorkspace,
  listParallelWorkspaces,
  mainWorkingTreeDiff,
  mergeParallelWorkspace,
  mergeParallelWorkspaceSelection,
  openParallelWorkspacePullRequest,
  refreshParallelWorkspace,
  removeParallelWorkspaceRecord,
  runParallelWorkspace,
  stopParallelWorkspace,
  type CreateParallelWorkspaceInput,
} from "./parallel-workspaces"
import {
  createSwarmRun,
  discardSwarmRun,
  listSwarmRuns,
  mergeSwarmRun,
  mergeSwarmRunSelection,
  resumeSwarmRun,
  stopSwarmRun,
  type CreateSwarmRunInput,
} from "./swarm-orchestrator"
import {
  cancelScheduledAgent,
  createScheduledAgent,
  initScheduledAgents,
  listScheduledAgents,
  removeScheduledAgent,
  type CreateScheduledAgentInput,
} from "./scheduled-agents"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  license: VectorLicenseService
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
}

function assertTrustedRenderer(event: IpcMainEvent | IpcMainInvokeEvent) {
  if (event.sender.isDestroyed()) throw new Error("The requesting Vector window is closed.")
  if (!BrowserWindow.fromWebContents(event.sender) || !isTrustedRendererUrl(event.sender.getURL())) {
    throw new Error("Vector rejected a desktop command from an untrusted page.")
  }
}

function handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: T) => R) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRenderer(event)
    return listener(event, ...(args as T))
  })
}

function on<T extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: T) => void) {
  ipcMain.on(channel, (event, ...args) => {
    assertTrustedRenderer(event)
    listener(event, ...(args as T))
  })
}

export function registerIpcHandlers(deps: Deps) {
  const voiceOwners = new Set<number>()
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)

  handle("kill-sidecar", () => deps.killSidecar())
  handle("await-initialization", () => deps.awaitInitialization())
  handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  handle("get-default-server-url", () => deps.getDefaultServerUrl())
  handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) => deps.setDefaultServerUrl(url))
  handle("get-display-backend", () => deps.getDisplayBackend())
  handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) => deps.setDisplayBackend(backend))
  handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  handle("path-exists", async (_event: IpcMainInvokeEvent, targetPath: string) => {
    if (!targetPath?.trim()) return false
    return Boolean(await stat(targetPath).catch(() => undefined))
  })
  handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  handle("license-status", () => deps.license.status())
  handle("license-activate", (_event, licenseKey: string) => deps.license.activate(licenseKey))
  handle("license-deactivate", () => deps.license.deactivate())
  handle("license-set-cancellation", (_event, cancel: boolean) => deps.license.setCancellation(Boolean(cancel)))
  handle("license-open-billing-portal", async () => {
    const url = await deps.license.openBillingPortal()
    await shell.openExternal(url)
    return url
  })
  handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  handle("updater-check", () => deps.updater.check())
  handle("updater-install", () => deps.updater.install())
  handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  handle("browser-agent-command", (event: IpcMainInvokeEvent, input: BrowserAgentInput) =>
    runBrowserAgent(event, input),
  )
  handle("agent-task-prepare", (_event: IpcMainInvokeEvent, root: string, task: string) => prepareAgentTask(root, task))
  handle(
    "parallel-workspaces-list",
    (_event: IpcMainInvokeEvent, scope?: { sourcePath?: string; parentSessionId?: string }) =>
      listParallelWorkspaces(scope),
  )
  handle("parallel-workspaces-create", (_event: IpcMainInvokeEvent, input: CreateParallelWorkspaceInput) =>
    createParallelWorkspace(input),
  )
  handle("parallel-workspaces-refresh", (_event: IpcMainInvokeEvent, id: string) => refreshParallelWorkspace(id))
  handle("parallel-workspaces-run", async (_event: IpcMainInvokeEvent, id: string, concurrency?: number) => {
    const engine = await deps.awaitInitialization()
    return runParallelWorkspace(id, engine, concurrency)
  })
  handle("parallel-workspaces-stop", (_event: IpcMainInvokeEvent, id: string) => stopParallelWorkspace(id))
  handle(
    "parallel-workspaces-merge",
    (_event: IpcMainInvokeEvent, id: string, force?: boolean, commit?: { message: string }) =>
      mergeParallelWorkspace(id, Boolean(force), commit),
  )
  handle("parallel-workspaces-main-diff", (_event: IpcMainInvokeEvent, sourcePath: string) =>
    mainWorkingTreeDiff(sourcePath),
  )
  handle("parallel-workspaces-pull-request", (_event: IpcMainInvokeEvent, id: string) =>
    openParallelWorkspacePullRequest(id),
  )
  handle(
    "parallel-workspaces-merge-selection",
    (_event: IpcMainInvokeEvent, id: string, selection: { hunkIds?: string[]; files?: string[] }, force?: boolean) =>
      mergeParallelWorkspaceSelection(id, selection, Boolean(force)),
  )
  handle("parallel-workspaces-discard", (_event: IpcMainInvokeEvent, id: string) => discardParallelWorkspace(id))
  handle("parallel-workspaces-remove", (_event: IpcMainInvokeEvent, id: string) => removeParallelWorkspaceRecord(id))
  handle("swarm-runs-list", (_event: IpcMainInvokeEvent, scope?: { sourcePath?: string; parentSessionId?: string }) =>
    listSwarmRuns(scope),
  )
  handle("swarm-runs-create", async (_event: IpcMainInvokeEvent, input: CreateSwarmRunInput) => {
    const engine = await deps.awaitInitialization()
    return createSwarmRun(input, engine)
  })
  handle("swarm-runs-resume", async (_event: IpcMainInvokeEvent, id: string) => {
    const engine = await deps.awaitInitialization()
    return resumeSwarmRun(id, engine)
  })
  handle("swarm-runs-stop", (_event: IpcMainInvokeEvent, id: string) => stopSwarmRun(id))
  handle("swarm-runs-merge", (_event: IpcMainInvokeEvent, id: string, force?: boolean) =>
    mergeSwarmRun(id, Boolean(force)),
  )
  handle(
    "swarm-runs-merge-selection",
    (_event: IpcMainInvokeEvent, id: string, selection: { hunkIds?: string[]; files?: string[] }, force?: boolean) =>
      mergeSwarmRunSelection(id, selection, Boolean(force)),
  )
  handle("swarm-runs-discard", (_event: IpcMainInvokeEvent, id: string) => discardSwarmRun(id))
  initScheduledAgents(() => deps.awaitInitialization())
  handle(
    "scheduled-agents-list",
    (_event: IpcMainInvokeEvent, scope?: { directory?: string; parentSessionId?: string }) =>
      listScheduledAgents(scope),
  )
  handle("scheduled-agents-create", (_event: IpcMainInvokeEvent, input: CreateScheduledAgentInput) =>
    createScheduledAgent(input),
  )
  handle("scheduled-agents-cancel", (_event: IpcMainInvokeEvent, id: string) => cancelScheduledAgent(id))
  handle("scheduled-agents-remove", (_event: IpcMainInvokeEvent, id: string) => removeScheduledAgent(id))
  handle("publish-targets", () => detectPublishTargets())
  handle("publish-project", (event: IpcMainInvokeEvent, input: PublishProjectInput) =>
    publishProject(input, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("cloud-publish-progress", progress)
    }),
  )
  handle("github-detect", () => detectGithub())
  handle("github-publish", (_event: IpcMainInvokeEvent, input: GithubPublishInput) => publishToGithub(input))
  handle("github-auth-status", () => getAuthStatus())
  handle("github-auth-start", () => startDeviceLogin())
  handle("github-auth-open-verification", () => openVerification())
  handle("github-auth-complete", () => completeDeviceLogin())
  handle("github-auth-cancel", () => cancelDeviceLogin())
  handle("github-auth-logout", () => logoutGithub())
  handle("github-repos-list", () => listRepos())
  handle("github-repos-create", (_event: IpcMainInvokeEvent, input: GithubCreateRepoInput) => createRepo(input))
  handle("github-push-oauth", (_event: IpcMainInvokeEvent, input: GithubOauthPushInput) => pushWithOauth(input))
  handle("gitlab-auth-status", () => getGitlabAuthStatus())
  handle("gitlab-auth-start", () => startGitlabLogin())
  handle("gitlab-auth-open-verification", () => openGitlabVerification())
  handle("gitlab-auth-complete", () => completeGitlabLogin())
  handle("gitlab-auth-cancel", () => cancelGitlabLogin())
  handle("gitlab-auth-logout", () => logoutGitlab())
  handle("gitlab-repos-list", () => listGitlabRepos())
  handle("gitlab-repos-create", (_event: IpcMainInvokeEvent, input: GitlabCreateRepoInput) => createGitlabRepo(input))
  handle("gitlab-push-oauth", (_event: IpcMainInvokeEvent, input: GitlabOauthPushInput) => pushToGitlab(input))
  handle("external-agents-detect", () => detectExternalAgents())
  handle("external-agents-open-editor", (_event: IpcMainInvokeEvent, input: OpenInEditorInput) => openInEditor(input))
  handle("external-agents-prepare-workspace", (_event: IpcMainInvokeEvent, projectPath: string) =>
    prepareWorkspace(projectPath),
  )
  handle("cloud-connections-list", () => listCloudProviderConnections())
  handle("cloud-connections-connect", (_event: IpcMainInvokeEvent, provider: CloudProviderId) =>
    connectCloudProvider(provider),
  )
  handle("cloud-connections-disconnect", (_event: IpcMainInvokeEvent, provider: CloudProviderId) =>
    disconnectCloudProvider(provider),
  )
  handle("cloud-provider-resources-list", (_event: IpcMainInvokeEvent, provider: CloudProviderId) =>
    listCloudProviderResources(provider),
  )
  handle("cloud-provider-links-list", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    listCloudProviderProjectLinks(projectPath, taskId),
  )
  handle(
    "cloud-provider-links-set",
    (
      _event: IpcMainInvokeEvent,
      projectPath: string,
      taskId: string | undefined,
      provider: "vercel" | "netlify",
      projectId: string,
    ) => linkCloudProviderProject(projectPath, taskId, provider, projectId),
  )
  handle(
    "cloud-provider-links-remove",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, provider: "vercel" | "netlify") =>
      unlinkCloudProviderProject(projectPath, taskId, provider),
  )
  handle(
    "cloud-provider-env-sync",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, provider: "vercel" | "netlify") =>
      syncCloudProviderEnvironment(projectPath, taskId, provider),
  )
  handle(
    "cloud-provider-domains-add",
    (
      _event: IpcMainInvokeEvent,
      projectPath: string,
      taskId: string | undefined,
      provider: "vercel" | "netlify",
      domain: string,
    ) => addCloudProviderDomain(projectPath, taskId, provider, domain),
  )
  handle(
    "cloud-provider-domains-verify",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      verifyCloudProviderDomain(projectPath, taskId, id),
  )
  handle(
    "cloud-provider-domains-remove",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      removeCloudProviderDomain(projectPath, taskId, id),
  )
  handle(
    "cloud-supabase-project-connect",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, projectRef: string) =>
      connectSupabaseProject(projectPath, taskId, projectRef),
  )
  handle("cloud-deployments-list", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    listDeployments(projectPath, taskId),
  )
  handle(
    "cloud-deployments-remove",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      removeDeployment(projectPath, taskId, id),
  )
  handle(
    "cloud-deployments-check",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      checkDeployment(projectPath, taskId, id),
  )
  handle("cloud-deployments-check-all", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    checkAllDeployments(projectPath, taskId),
  )
  handle(
    "cloud-deployments-promote",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      promoteDeployment({ projectPath, taskId, id }),
  )
  handle(
    "cloud-deployments-rollback",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      rollbackDeployment({ projectPath, taskId, id }),
  )
  handle(
    "cloud-deployments-logs",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      fetchDeploymentRuntimeLogs({ projectPath, taskId, id }),
  )
  handle(
    "cloud-deployments-rerun-checks",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      rerunDeploymentChecks({ projectPath, taskId, id }),
  )
  handle("cloud-env-list", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    listEnv(projectPath, taskId),
  )
  handle(
    "cloud-env-set",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, key: string, value: string) =>
      setEnv(projectPath, taskId, key, value),
  )
  handle(
    "cloud-env-remove",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, key: string) =>
      removeEnv(projectPath, taskId, key),
  )
  handle("cloud-env-apply", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    applyEnv(projectPath, taskId),
  )
  handle("cloud-domains-list", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    listDomains(projectPath, taskId),
  )
  handle(
    "cloud-domains-add",
    (
      _event: IpcMainInvokeEvent,
      projectPath: string,
      taskId: string | undefined,
      input: { domain: string; slug?: string },
    ) => addDomain(projectPath, taskId, input),
  )
  handle(
    "cloud-domains-verify",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      verifyDomain(projectPath, taskId, id),
  )
  handle(
    "cloud-domains-remove",
    (_event: IpcMainInvokeEvent, projectPath: string, taskId: string | undefined, id: string) =>
      removeDomain(projectPath, taskId, id),
  )
  handle("cloud-db-get", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    getDatabase(projectPath, taskId),
  )
  handle(
    "cloud-db-connect",
    (
      _event: IpcMainInvokeEvent,
      projectPath: string,
      taskId: string | undefined,
      input: { provider: "supabase"; url: string; anonKey: string },
    ) => connectDatabase(projectPath, taskId, input),
  )
  handle("cloud-db-disconnect", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    disconnectDatabase(projectPath, taskId),
  )
  handle("cloud-build-get", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    getBuildSettings(projectPath, taskId),
  )
  handle("cloud-build-detect", (_event: IpcMainInvokeEvent, projectPath: string, taskId?: string) =>
    detectBuildSettings(projectPath, taskId),
  )
  handle(
    "cloud-build-set",
    (
      _event: IpcMainInvokeEvent,
      projectPath: string,
      taskId: string | undefined,
      input: Parameters<typeof setBuildSettings>[2],
    ) => setBuildSettings(projectPath, taskId, input),
  )
  handle("background-tasks-list", (_event: IpcMainInvokeEvent, scope?: { projectPath?: string; taskId?: string }) =>
    listBackgroundTasks(scope),
  )
  handle("background-tasks-cancel", (_event: IpcMainInvokeEvent, id: string) => cancelBackgroundTask(id))
  handle(
    "background-tasks-clear-completed",
    (_event: IpcMainInvokeEvent, scope?: { projectPath?: string; taskId?: string }) =>
      clearCompletedBackgroundTasks(scope),
  )
  handle("export-debug-logs", () => deps.exportDebugLogs())
  handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })
  handle("voice-speak", (event: IpcMainInvokeEvent, text: string) => {
    const ownerID = event.sender.id
    if (!voiceOwners.has(ownerID)) {
      voiceOwners.add(ownerID)
      event.sender.once("destroyed", () => {
        voiceOwners.delete(ownerID)
        stopVoiceSynthesis(ownerID)
      })
    }
    return speakVoiceText(ownerID, text)
  })
  handle("voice-stop", (event: IpcMainInvokeEvent) => stopVoiceSynthesis(event.sender.id))

  handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  handle("save-file-picker", async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
    const result = await dialog.showSaveDialog({
      title: opts?.title ?? "Save file",
      defaultPath: opts?.defaultPath,
    })
    if (result.canceled) return null
    return result.filePath ?? null
  })

  on("open-link", (_event: IpcMainEvent, url: string) => {
    const external = safeExternalUrl(url)
    if (!external) throw new Error("Vector blocked an unsafe external link.")
    void shell.openExternal(external)
  })

  handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title: title.slice(0, 120), body: body?.slice(0, 500) }).show()
  })

  handle("get-microphone-permission", () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return "unknown"
    return systemPreferences.getMediaAccessStatus("microphone")
  })

  handle("request-microphone-permission", async () => {
    if (process.platform === "darwin") {
      const current = systemPreferences.getMediaAccessStatus("microphone")
      if (current === "not-determined") await systemPreferences.askForMediaAccess("microphone")
      return systemPreferences.getMediaAccessStatus("microphone")
    }
    if (process.platform === "win32") return systemPreferences.getMediaAccessStatus("microphone")
    return "unknown"
  })

  handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  on("relaunch", () => {
    deps.relaunch()
  })

  handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

function safeExternalUrl(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return
  return url.toString()
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
