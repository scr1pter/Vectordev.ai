import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type {
  CloudRuntimeLogResult,
  PublishProgressEvent,
  PublishProjectInput,
  PublishResult,
  PublishTarget,
} from "../main/publish"
import type {
  CloudBuildSettings,
  CloudDatabaseConnection,
  CloudDeployment,
  CloudDomain,
  CloudEnvVar,
} from "../main/cloud-console"
import type {
  CloudProviderConnection,
  CloudProviderId,
  CloudProviderProjectLink,
  CloudProviderResource,
  CloudProviderSyncResult,
} from "../main/cloud-connections"
import type { GithubOauthPushInput, GithubPublishInput, GithubPublishResult, GithubStatus } from "../main/github"
import type {
  GithubAuthStatus,
  GithubCreateRepoInput,
  GithubDeviceLoginResult,
  GithubDeviceLoginStart,
  GithubRepo,
} from "../main/github-auth"
import type { GitlabOauthPushInput, GitlabPublishResult } from "../main/gitlab"
import type {
  GitlabAuthStatus,
  GitlabCreateRepoInput,
  GitlabDeviceLoginResult,
  GitlabDeviceLoginStart,
  GitlabRepo,
} from "../main/gitlab-auth"
import type { CreateScheduledAgentInput, ScheduledAgentRecord } from "../main/scheduled-agents"
import type {
  ExternalAgentStatus,
  OpenInEditorInput,
  OpenInEditorResult,
  PrepareWorkspaceResult,
} from "../main/external-agents"
import type { AgentTaskPreparation } from "../main/context-budget"
export type {
  CloudRuntimeLogResult,
  PublishProgressEvent,
  PublishProjectInput,
  PublishResult,
  PublishTarget,
} from "../main/publish"
export type {
  CloudBuildSettings,
  CloudDatabaseConnection,
  CloudDeployment,
  CloudDeploymentCheck,
  CloudDomain,
  CloudDomainProvider,
  CloudDomainStatus,
  CloudEnvVar,
  CloudGitMetadata,
  CloudRequiredChecks,
} from "../main/cloud-console"
export type {
  CloudProviderConnection,
  CloudProviderId,
  CloudProviderProjectLink,
  CloudProviderResource,
  CloudProviderSyncResult,
} from "../main/cloud-connections"
export type { GithubOauthPushInput, GithubPublishInput, GithubPublishResult, GithubStatus } from "../main/github"
export type {
  GithubAuthStatus,
  GithubCreateRepoInput,
  GithubDeviceLoginResult,
  GithubDeviceLoginStart,
  GithubRepo,
} from "../main/github-auth"
export type { GitlabOauthPushInput, GitlabPublishResult } from "../main/gitlab"
export type {
  GitlabAuthStatus,
  GitlabCreateRepoInput,
  GitlabDeviceLoginResult,
  GitlabDeviceLoginStart,
  GitlabRepo,
} from "../main/gitlab-auth"
export type {
  ExternalAgentId,
  ExternalAgentStatus,
  OpenInEditorApp,
  OpenInEditorInput,
  OpenInEditorResult,
} from "../main/external-agents"
export type {
  CreateScheduledAgentInput,
  ScheduledAgentEngine,
  ScheduledAgentRecord,
  ScheduledAgentStatus,
} from "../main/scheduled-agents"
export type { AgentTaskPreparation, TaskDifficulty } from "../main/context-budget"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}
export type MicrophonePermissionState = "not-determined" | "granted" | "denied" | "restricted" | "unknown"
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type BrowserAgentPageEvent = {
  contextId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export type BrowserAgentBounds = { x: number; y: number; width: number; height: number }

export type BrowserAutomationRun = {
  url: string
  finalUrl: string
  status: number
  ok: boolean
  title: string
  description: string
  htmlBytes: number
  links: number
  scripts: number
  stylesheets: number
  checkedAt: string
  error?: string
  viewport: BrowserAgentBounds
  screenshotDataUrl: string
  console: { level: string; message: string; location?: string }[]
  pageErrors: string[]
  networkErrors?: { url: string; status?: number; error?: string; method?: string }[]
  domSummary?: {
    title: string
    description: string
    textSample: string
    links: number
    scripts: number
    stylesheets: number
    htmlBytes: number
    interactives: BrowserAutomationRun["interactives"]
    inputs: BrowserAutomationRun["inputs"]
  }
  computedStyles?: {
    tag: string
    selector: string
    text: string
    display: string
    visibility: string
    color: string
    backgroundColor: string
    fontSize: string
    rect: { x: number; y: number; width: number; height: number }
  }[]
  pageHtml?: string
  diagnostics?: {
    consoleCount: number
    runtimeErrorCount: number
    networkErrorCount: number
    interactiveCount: number
    inputCount: number
    htmlBytes: number
  }
  actions: { label: string; ok: boolean; error?: string; result?: unknown; at?: string }[]
  interactives: { tag: string; text: string; selector: string; role?: string; type?: string }[]
  inputs: { tag: string; selector: string; placeholder?: string; type?: string; name?: string }[]
  browserStatus?: "stopped" | "launching" | "running"
  currentPage?: string
}

export type BrowserAgentInput = {
  contextId: string
  command?:
    | "attach"
    | "setBounds"
    | "detach"
    | "closeBrowser"
    | "openUrl"
    | "click"
    | "type"
    | "press"
    | "wait"
    | "waitForSelector"
    | "waitForText"
    | "takeScreenshot"
    | "inspectDom"
    | "inspectComputedStyles"
    | "inspectPageHtml"
    | "reload"
    | "goBack"
    | "goForward"
    | "scroll"
    | "clearLogs"
    | "setVisible"
  url?: string
  allowExternal?: boolean
  selector?: string
  text?: string
  key?: string
  milliseconds?: number
  deltaY?: number
  bounds?: BrowserAgentBounds
  visible?: boolean
}

export type ParallelWorkspaceStatus =
  | "queued"
  | "planning"
  | "editing"
  | "running commands"
  | "testing"
  | "complete"
  | "failed"
  | "needs review"
  | "stopped"
  | "merged"
  | "discarded"

export type WorkspaceValidationCheck = {
  id: string
  label: string
  command: string
  args: string[]
  reason: string
  status: "passed" | "failed" | "skipped"
  exitCode?: number
  durationMs: number
  output: string
}

export type WorkspaceValidationReport = {
  startedAt: string
  completedAt: string
  passed: boolean
  hadChecks: boolean
  checks: WorkspaceValidationCheck[]
  failureSummary: string
}

export type ParallelWorkspaceRecord = {
  id: string
  name: string
  taskPrompt: string
  runtime: "vector" | "claude-code" | "codex" | "cursor"
  provider: string
  model: string
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  isolatedPath: string
  isolation: "git-worktree" | "copy"
  gitBranch?: string
  baseCommit?: string
  agentSessionId?: string
  backgroundTaskId?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
  status: ParallelWorkspaceStatus
  progress: number
  lastAction: string
  createdAt: string
  lastActivityAt: string
  changedFilesCount: number
  riskLevel: "low" | "medium" | "high"
  estimatedCost: string
  actualCost?: string
  finalSummary: string
  mergeState: "none" | "merged" | "discarded"
  logs: string[]
  terminalOutput: string[]
  browserResults: string[]
  changedFiles: string[]
  diff: string
  checkpointPath?: string
  pullRequestUrl?: string
  baselineHashes?: Record<string, string>
  contextFiles?: string[]
  contextIndexedFiles?: number
  contextTokenEstimate?: number
  contextSummary?: string
  validationReport?: WorkspaceValidationReport
  validationPassed?: boolean
  repairAttempts?: number
  error?: string
}

export type CreateParallelWorkspaceInput = {
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  name?: string
  taskPrompt: string
  runtime?: "vector" | "claude-code" | "codex" | "cursor"
  provider?: string
  model?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
}

export type ParallelWorkspaceMergeSelection = {
  hunkIds?: string[]
  files?: string[]
}

export type SwarmRunStatus =
  | "planning"
  | "running"
  | "needs review"
  | "complete"
  | "failed"
  | "canceled"
  | "interrupted"
  | "merged"
  | "discarded"

export type SwarmTaskStatus =
  | "planned"
  | "blocked"
  | "creating"
  | "queued"
  | "running"
  | "merging"
  | "complete"
  | "failed"
  | "canceled"
  | "interrupted"

export type SwarmModelCandidate = {
  provider: string
  model: string
  label?: string
}

export type SwarmTaskRecord = {
  id: string
  title: string
  prompt: string
  role: "explore" | "implement" | "debug" | "test" | "review" | "security" | "docs"
  dependsOn: string[]
  fileHints: string[]
  provider: string
  model: string
  status: SwarmTaskStatus
  workspaceId?: string
  startedAt?: string
  completedAt?: string
  lastAction: string
  changedFilesCount: number
  riskLevel: "low" | "medium" | "high"
  summary: string
  error?: string
}

export type SwarmRunRecord = {
  id: string
  name: string
  objective: string
  sourcePath: string
  parentSessionId?: string
  strategy: "economy" | "balanced" | "quality"
  maxAgents: number
  maxConcurrency: number
  modelPool: SwarmModelCandidate[]
  plannerProvider: string
  plannerModel: string
  plannerSessionId?: string
  coordinatorWorkspaceId?: string
  status: SwarmRunStatus
  currentStep: string
  progress: number
  planSummary: string
  tasks: SwarmTaskRecord[]
  createdAt: string
  updatedAt: string
  completedAt?: string
  changedFiles: string[]
  diff: string
  riskLevel: "low" | "medium" | "high"
  summary: string
  logs: string[]
  error?: string
}

export type CreateSwarmRunInput = {
  sourcePath: string
  parentSessionId?: string
  name?: string
  objective: string
  primaryProvider: string
  primaryModel: string
  modelPool?: SwarmModelCandidate[]
  strategy?: "economy" | "balanced" | "quality"
  maxAgents?: number
  maxConcurrency?: number
}

export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "needs_input"
  | "complete"
  | "needs_review"
  | "failed"
  | "canceled"
  | "merged"
  | "discarded"
  | "interrupted"

export type BackgroundTaskRecord = {
  id: string
  kind: "parallel-workspace" | "browser-agent" | "terminal" | "agent" | "checkpoint"
  projectPath?: string
  workspaceId?: string
  workspaceName?: string
  name: string
  prompt: string
  provider: string
  model: string
  status: BackgroundTaskStatus
  progress: number
  currentStep: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  elapsedMs?: number
  changedFilesCount: number
  terminalActive: boolean
  browserActive: boolean
  costEstimate: string
  actualUsage?: string
  errorSummary?: string
  logs: string[]
  actions: {
    id: string
    at: string
    label: string
    status: "pending" | "running" | "success" | "warning" | "failed"
    detail?: string
  }[]
  mergeState?: "none" | "merged" | "discarded"
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  pathExists: (path: string) => Promise<boolean>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  getWindowID: () => Promise<string>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getMicrophonePermission: () => Promise<MicrophonePermissionState>
  requestMicrophonePermission: () => Promise<MicrophonePermissionState>
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  runBrowserAgent: (input: BrowserAgentInput) => Promise<BrowserAutomationRun>
  prepareAgentTask: (root: string, task: string) => Promise<AgentTaskPreparation>
  onBrowserAgentPageEvent: (cb: (event: BrowserAgentPageEvent) => void) => () => void
	  parallelWorkspaces: {
	    list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<ParallelWorkspaceRecord[]>
	    create: (input: CreateParallelWorkspaceInput) => Promise<ParallelWorkspaceRecord>
	    refresh: (id: string) => Promise<ParallelWorkspaceRecord>
	    run: (id: string, concurrency?: number) => Promise<ParallelWorkspaceRecord>
	    stop: (id: string) => Promise<ParallelWorkspaceRecord>
	    merge: (id: string, force?: boolean, commit?: { message: string }) => Promise<ParallelWorkspaceRecord>
	    mainDiff: (sourcePath: string) => Promise<string>
	    pullRequest: (id: string) => Promise<ParallelWorkspaceRecord>
	    mergeSelection: (
	      id: string,
	      selection: ParallelWorkspaceMergeSelection,
	      force?: boolean,
	    ) => Promise<ParallelWorkspaceRecord>
	    discard: (id: string) => Promise<ParallelWorkspaceRecord>
	    remove: (id: string) => Promise<ParallelWorkspaceRecord[]>
	  }
	  swarmOrchestrator: {
	    list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<SwarmRunRecord[]>
	    create: (input: CreateSwarmRunInput) => Promise<SwarmRunRecord>
	    resume: (id: string) => Promise<SwarmRunRecord>
	    stop: (id: string) => Promise<SwarmRunRecord>
	    merge: (id: string, force?: boolean) => Promise<SwarmRunRecord>
	    mergeSelection: (
	      id: string,
	      selection: ParallelWorkspaceMergeSelection,
	      force?: boolean,
	    ) => Promise<SwarmRunRecord>
	    discard: (id: string) => Promise<SwarmRunRecord>
	  }
	  backgroundTasks: {
	    list: (scope?: { projectPath?: string; taskId?: string }) => Promise<BackgroundTaskRecord[]>
	    cancel: (id: string) => Promise<BackgroundTaskRecord>
	    clearCompleted: (scope?: { projectPath?: string; taskId?: string }) => Promise<BackgroundTaskRecord[]>
	  }
  publish: {
    targets: () => Promise<PublishTarget[]>
    run: (input: PublishProjectInput) => Promise<PublishResult>
    subscribe: (cb: (event: PublishProgressEvent) => void) => () => void
  }
  cloud: {
    connections: {
      list: () => Promise<CloudProviderConnection[]>
      connect: (provider: CloudProviderId) => Promise<CloudProviderConnection>
      disconnect: (provider: CloudProviderId) => Promise<void>
    }
    providers: {
      resources: (provider: CloudProviderId) => Promise<CloudProviderResource[]>
      links: (projectPath: string, taskId?: string) => Promise<CloudProviderProjectLink[]>
      link: (
        projectPath: string,
        taskId: string | undefined,
        provider: "vercel" | "netlify",
        projectId: string,
      ) => Promise<CloudProviderProjectLink>
      unlink: (
        projectPath: string,
        taskId: string | undefined,
        provider: "vercel" | "netlify",
      ) => Promise<CloudProviderProjectLink[]>
      syncEnvironment: (
        projectPath: string,
        taskId: string | undefined,
        provider: "vercel" | "netlify",
      ) => Promise<CloudProviderSyncResult>
      addDomain: (
        projectPath: string,
        taskId: string | undefined,
        provider: "vercel" | "netlify",
        domain: string,
      ) => Promise<CloudDomain>
      verifyDomain: (
        projectPath: string,
        taskId: string | undefined,
        id: string,
      ) => Promise<CloudDomain>
      removeDomain: (
        projectPath: string,
        taskId: string | undefined,
        id: string,
      ) => Promise<CloudDomain[]>
    }
    deployments: {
      list: (projectPath: string, taskId?: string) => Promise<CloudDeployment[]>
      remove: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment[]>
      check: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
      checkAll: (projectPath: string, taskId?: string) => Promise<CloudDeployment[]>
      promote: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
      rollback: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
      logs: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudRuntimeLogResult>
      rerunChecks: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDeployment>
    }
    env: {
      list: (projectPath: string, taskId?: string) => Promise<CloudEnvVar[]>
      set: (projectPath: string, taskId: string | undefined, key: string, value: string) => Promise<CloudEnvVar[]>
      remove: (projectPath: string, taskId: string | undefined, key: string) => Promise<CloudEnvVar[]>
      apply: (projectPath: string, taskId?: string) => Promise<{ written: string }>
    }
    domains: {
      list: (projectPath: string, taskId?: string) => Promise<CloudDomain[]>
      add: (projectPath: string, taskId: string | undefined, input: { domain: string; slug?: string }) => Promise<CloudDomain>
      verify: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDomain>
      remove: (projectPath: string, taskId: string | undefined, id: string) => Promise<CloudDomain[]>
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
  github: {
    detect: () => Promise<GithubStatus>
    publish: (input: GithubPublishInput) => Promise<GithubPublishResult>
    auth: {
      status: () => Promise<GithubAuthStatus>
      start: () => Promise<GithubDeviceLoginStart>
      openVerification: () => Promise<void>
      complete: () => Promise<GithubDeviceLoginResult>
      cancel: () => Promise<void>
      logout: () => Promise<void>
    }
    repos: {
      list: () => Promise<GithubRepo[]>
      create: (input: GithubCreateRepoInput) => Promise<GithubRepo>
    }
    pushOauth: (input: GithubOauthPushInput) => Promise<GithubPublishResult>
  }
  gitlab: {
    auth: {
      status: () => Promise<GitlabAuthStatus>
      start: () => Promise<GitlabDeviceLoginStart>
      openVerification: () => Promise<void>
      complete: () => Promise<GitlabDeviceLoginResult>
      cancel: () => Promise<void>
      logout: () => Promise<void>
    }
    repos: {
      list: () => Promise<GitlabRepo[]>
      create: (input: GitlabCreateRepoInput) => Promise<GitlabRepo>
    }
    pushOauth: (input: GitlabOauthPushInput) => Promise<GitlabPublishResult>
  }
  scheduledAgents: {
    list: (scope?: { directory?: string; parentSessionId?: string }) => Promise<ScheduledAgentRecord[]>
    create: (input: CreateScheduledAgentInput) => Promise<ScheduledAgentRecord>
    cancel: (id: string) => Promise<ScheduledAgentRecord | undefined>
    remove: (id: string) => Promise<ScheduledAgentRecord[]>
  }
  externalAgents: {
    detect: () => Promise<ExternalAgentStatus[]>
    openInEditor: (input: OpenInEditorInput) => Promise<OpenInEditorResult>
    prepareWorkspace: (projectPath: string) => Promise<PrepareWorkspaceResult>
  }
	  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
}
