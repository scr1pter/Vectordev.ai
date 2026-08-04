import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { ElectronAPI, WslServersEvent } from "./types"
import type { UpdaterState } from "@opencode-ai/app/updater"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeAddable: (distros) => ipcRenderer.invoke("wsl-servers-probe-addable", distros),
    installOpencode: (name) => ipcRenderer.invoke("wsl-servers-install-opencode", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  license: {
    status: () => ipcRenderer.invoke("license-status"),
    activate: (licenseKey) => ipcRenderer.invoke("license-activate", licenseKey),
    deactivate: () => ipcRenderer.invoke("license-deactivate"),
    setCancellation: (cancel) => ipcRenderer.invoke("license-set-cancellation", cancel),
    openBillingPortal: () => ipcRenderer.invoke("license-open-billing-portal"),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  pathExists: (path) => ipcRenderer.invoke("path-exists", path),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),
  workProjects: {
    ensureDirectory: (projectId, name) => ipcRenderer.invoke("work-project-ensure-directory", projectId, name),
  },
  voice: {
    speak: (text) => ipcRenderer.invoke("voice-speak", text),
    stop: () => ipcRenderer.invoke("voice-stop"),
  },

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  getWindowID: () => ipcRenderer.invoke("get-window-id"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getMicrophonePermission: () => ipcRenderer.invoke("get-microphone-permission"),
  requestMicrophonePermission: () => ipcRenderer.invoke("request-microphone-permission"),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  runBrowserAgent: (input) => ipcRenderer.invoke("browser-agent-command", input),
  prepareAgentTask: (root, task) => ipcRenderer.invoke("agent-task-prepare", root, task),
  onBrowserAgentPageEvent: (cb) => {
    const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
    ipcRenderer.on("browser-agent-page-event", handler)
    return () => ipcRenderer.removeListener("browser-agent-page-event", handler)
  },
	  parallelWorkspaces: {
	    list: (scope) => ipcRenderer.invoke("parallel-workspaces-list", scope),
	    create: (input) => ipcRenderer.invoke("parallel-workspaces-create", input),
	    refresh: (id) => ipcRenderer.invoke("parallel-workspaces-refresh", id),
	    run: (id, concurrency) => ipcRenderer.invoke("parallel-workspaces-run", id, concurrency),
	    stop: (id) => ipcRenderer.invoke("parallel-workspaces-stop", id),
	    merge: (id, force, commit) => ipcRenderer.invoke("parallel-workspaces-merge", id, force, commit),
	    mainDiff: (sourcePath) => ipcRenderer.invoke("parallel-workspaces-main-diff", sourcePath),
	    pullRequest: (id) => ipcRenderer.invoke("parallel-workspaces-pull-request", id),
	    mergeSelection: (id, selection, force) =>
	      ipcRenderer.invoke("parallel-workspaces-merge-selection", id, selection, force),
	    discard: (id) => ipcRenderer.invoke("parallel-workspaces-discard", id),
	    remove: (id) => ipcRenderer.invoke("parallel-workspaces-remove", id),
	  },
	  swarmOrchestrator: {
	    list: (scope) => ipcRenderer.invoke("swarm-runs-list", scope),
	    create: (input) => ipcRenderer.invoke("swarm-runs-create", input),
	    resume: (id) => ipcRenderer.invoke("swarm-runs-resume", id),
	    stop: (id) => ipcRenderer.invoke("swarm-runs-stop", id),
	    merge: (id, force) => ipcRenderer.invoke("swarm-runs-merge", id, force),
	    mergeSelection: (id, selection, force) => ipcRenderer.invoke("swarm-runs-merge-selection", id, selection, force),
	    discard: (id) => ipcRenderer.invoke("swarm-runs-discard", id),
	  },
	  backgroundTasks: {
	    list: (scope) => ipcRenderer.invoke("background-tasks-list", scope),
	    cancel: (id) => ipcRenderer.invoke("background-tasks-cancel", id),
	    clearCompleted: (scope) => ipcRenderer.invoke("background-tasks-clear-completed", scope),
	  },
	  publish: {
	    targets: () => ipcRenderer.invoke("publish-targets"),
	    run: (input) => ipcRenderer.invoke("publish-project", input),
	    subscribe: (cb) => {
	      const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
	      ipcRenderer.on("cloud-publish-progress", handler)
	      return () => ipcRenderer.removeListener("cloud-publish-progress", handler)
	    },
	  },
	  cloud: {
	    connections: {
	      list: () => ipcRenderer.invoke("cloud-connections-list"),
	      connect: (provider) => ipcRenderer.invoke("cloud-connections-connect", provider),
	      disconnect: (provider) => ipcRenderer.invoke("cloud-connections-disconnect", provider),
	    },
	    providers: {
	      resources: (provider) => ipcRenderer.invoke("cloud-provider-resources-list", provider),
	      links: (projectPath, taskId) => ipcRenderer.invoke("cloud-provider-links-list", projectPath, taskId),
	      link: (projectPath, taskId, provider, projectId) =>
	        ipcRenderer.invoke("cloud-provider-links-set", projectPath, taskId, provider, projectId),
	      unlink: (projectPath, taskId, provider) =>
	        ipcRenderer.invoke("cloud-provider-links-remove", projectPath, taskId, provider),
	      syncEnvironment: (projectPath, taskId, provider) =>
	        ipcRenderer.invoke("cloud-provider-env-sync", projectPath, taskId, provider),
	      addDomain: (projectPath, taskId, provider, domain) =>
	        ipcRenderer.invoke("cloud-provider-domains-add", projectPath, taskId, provider, domain),
	      verifyDomain: (projectPath, taskId, id) =>
	        ipcRenderer.invoke("cloud-provider-domains-verify", projectPath, taskId, id),
	      removeDomain: (projectPath, taskId, id) =>
	        ipcRenderer.invoke("cloud-provider-domains-remove", projectPath, taskId, id),
	    },
		    deployments: {
		      list: (projectPath, taskId) => ipcRenderer.invoke("cloud-deployments-list", projectPath, taskId),
		      remove: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-deployments-remove", projectPath, taskId, id),
		      check: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-deployments-check", projectPath, taskId, id),
		      checkAll: (projectPath, taskId) => ipcRenderer.invoke("cloud-deployments-check-all", projectPath, taskId),
		      promote: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-deployments-promote", projectPath, taskId, id),
		      rollback: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-deployments-rollback", projectPath, taskId, id),
		      logs: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-deployments-logs", projectPath, taskId, id),
		      rerunChecks: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-deployments-rerun-checks", projectPath, taskId, id),
		    },
	    env: {
	      list: (projectPath, taskId) => ipcRenderer.invoke("cloud-env-list", projectPath, taskId),
	      set: (projectPath, taskId, key, value) => ipcRenderer.invoke("cloud-env-set", projectPath, taskId, key, value),
	      remove: (projectPath, taskId, key) => ipcRenderer.invoke("cloud-env-remove", projectPath, taskId, key),
	      apply: (projectPath, taskId) => ipcRenderer.invoke("cloud-env-apply", projectPath, taskId),
	    },
	    domains: {
	      list: (projectPath, taskId) => ipcRenderer.invoke("cloud-domains-list", projectPath, taskId),
	      add: (projectPath, taskId, input) => ipcRenderer.invoke("cloud-domains-add", projectPath, taskId, input),
	      verify: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-domains-verify", projectPath, taskId, id),
	      remove: (projectPath, taskId, id) => ipcRenderer.invoke("cloud-domains-remove", projectPath, taskId, id),
	    },
		    database: {
		      get: (projectPath, taskId) => ipcRenderer.invoke("cloud-db-get", projectPath, taskId),
		      connect: (projectPath, taskId, input) => ipcRenderer.invoke("cloud-db-connect", projectPath, taskId, input),
		      connectProject: (projectPath, taskId, projectRef) =>
		        ipcRenderer.invoke("cloud-supabase-project-connect", projectPath, taskId, projectRef),
		      disconnect: (projectPath, taskId) => ipcRenderer.invoke("cloud-db-disconnect", projectPath, taskId),
		    },
		    build: {
		      get: (projectPath, taskId) => ipcRenderer.invoke("cloud-build-get", projectPath, taskId),
		      detect: (projectPath, taskId) => ipcRenderer.invoke("cloud-build-detect", projectPath, taskId),
		      set: (projectPath, taskId, input) => ipcRenderer.invoke("cloud-build-set", projectPath, taskId, input),
		    },
		  },
	  github: {
	    detect: () => ipcRenderer.invoke("github-detect"),
	    publish: (input) => ipcRenderer.invoke("github-publish", input),
	    auth: {
	      status: () => ipcRenderer.invoke("github-auth-status"),
	      start: () => ipcRenderer.invoke("github-auth-start"),
	      openVerification: () => ipcRenderer.invoke("github-auth-open-verification"),
	      complete: () => ipcRenderer.invoke("github-auth-complete"),
	      cancel: () => ipcRenderer.invoke("github-auth-cancel"),
	      logout: () => ipcRenderer.invoke("github-auth-logout"),
	    },
	    repos: {
	      list: () => ipcRenderer.invoke("github-repos-list"),
	      create: (input) => ipcRenderer.invoke("github-repos-create", input),
	    },
	    pushOauth: (input) => ipcRenderer.invoke("github-push-oauth", input),
	  },
	  gitlab: {
	    auth: {
	      status: () => ipcRenderer.invoke("gitlab-auth-status"),
	      start: () => ipcRenderer.invoke("gitlab-auth-start"),
	      openVerification: () => ipcRenderer.invoke("gitlab-auth-open-verification"),
	      complete: () => ipcRenderer.invoke("gitlab-auth-complete"),
	      cancel: () => ipcRenderer.invoke("gitlab-auth-cancel"),
	      logout: () => ipcRenderer.invoke("gitlab-auth-logout"),
	    },
	    repos: {
	      list: () => ipcRenderer.invoke("gitlab-repos-list"),
	      create: (input) => ipcRenderer.invoke("gitlab-repos-create", input),
	    },
	    pushOauth: (input) => ipcRenderer.invoke("gitlab-push-oauth", input),
	  },
	  scheduledAgents: {
	    list: (scope) => ipcRenderer.invoke("scheduled-agents-list", scope),
	    create: (input) => ipcRenderer.invoke("scheduled-agents-create", input),
	    cancel: (id) => ipcRenderer.invoke("scheduled-agents-cancel", id),
	    remove: (id) => ipcRenderer.invoke("scheduled-agents-remove", id),
	  },
	  externalAgents: {
	    detect: () => ipcRenderer.invoke("external-agents-detect"),
	    openInEditor: (input) => ipcRenderer.invoke("external-agents-open-editor", input),
	    prepareWorkspace: (projectPath) => ipcRenderer.invoke("external-agents-prepare-workspace", projectPath),
	  },
	  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
}

contextBridge.exposeInMainWorld("api", api)
