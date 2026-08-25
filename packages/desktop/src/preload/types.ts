import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { VectorLicenseStatus } from "@opencode-ai/app/license"
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
  CloudSupabaseServices,
} from "../main/cloud-connections"
import type { CloudAwsSnapshot, CloudAwsStatus } from "../main/cloud-aws"
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
import type { VoiceSpeechResult } from "../main/voice-synthesis"
import type { PullRequestCliStatus, PullRequestDetail, PullRequestSummary } from "../main/github-pr"
import type { LocalMemoryState } from "../main/local-memory"
import type { CustomInstructionsState } from "../main/custom-instructions"
import type { RuntimeName, RuntimeStatus } from "../main/runtime-bootstrap"
export type { RuntimeName, RuntimeStatus } from "../main/runtime-bootstrap"
import type { CiFailure, CiRepo, CiRun, CiUnavailable } from "../main/ci-watch"
export type {
  CiFailedStep,
  CiFailure,
  CiFailureKind,
  CiRepo,
  CiRun,
  CiUnavailable,
  CiUnavailableReason,
} from "../main/ci-watch"
import type { SpendEvent, SpendPolicy, SpendSummary } from "../main/spend-limits"
export type {
  SpendDayTotal,
  SpendEvent,
  SpendLimit,
  SpendLimitSet,
  SpendPolicy,
  SpendSource,
  SpendSummary,
  SpendWindowTotal,
} from "../main/spend-limits"
import type { FailureMemory } from "../main/failure-memory"
export type { FailureMemory, FailureRepair, FailureSignatureRecord } from "../main/failure-memory"
import type { AgentTeam, TeamCollaborationGraph, TeamMessage, TeamTopology } from "../main/agent-team-model"
export type { AgentTeam, TeamCollaborationGraph, TeamLink, TeamMessage, TeamTopology } from "../main/agent-team-model"
export type { LocalMemoryState } from "../main/local-memory"
export type { CustomInstructionsState } from "../main/custom-instructions"
export type { PullRequestCliStatus, PullRequestDetail, PullRequestSummary } from "../main/github-pr"
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
  CloudSupabaseBucket,
  CloudSupabaseFunction,
  CloudSupabaseServices,
} from "../main/cloud-connections"
export type { CloudAwsResource, CloudAwsService, CloudAwsSnapshot, CloudAwsStatus } from "../main/cloud-aws"
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

export type LicenseAPI = {
  status: () => Promise<VectorLicenseStatus>
  activate: (licenseKey: string) => Promise<VectorLicenseStatus>
  deactivate: () => Promise<VectorLicenseStatus>
  setCancellation: (cancel: boolean) => Promise<VectorLicenseStatus>
  openBillingPortal: () => Promise<string>
}

export type AgentTeamsAPI = {
  list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<AgentTeam[]>
  get: (id: string) => Promise<AgentTeam | undefined>
  create: (input: {
    name: string
    topology: TeamTopology
    sourcePath: string
    parentSessionId?: string
    sharedPath?: string
  }) => Promise<AgentTeam>
  addMember: (teamId: string, workspaceId: string) => Promise<AgentTeam | undefined>
  removeMember: (teamId: string, workspaceId: string) => Promise<AgentTeam | undefined>
  // Routing can refuse a message when the collaboration graph does not link the
  // two members, so this reports the outcome rather than a team snapshot.
  post: (input: {
    teamId: string
    fromWorkspaceId: string
    fromName: string
    toWorkspaceId?: string
    text: string
    memberNames?: Record<string, string>
  }) => Promise<
    { ok: true; team?: AgentTeam; recipients: string[] } | { ok: false; reason: string; allowedRecipients: string[] }
  >
  claim: (teamId: string, workspaceId: string) => Promise<TeamMessage[]>
  delete: (teamId: string) => Promise<void>
  // `explicit` distinguishes a graph the user actually configured from the
  // all-to-all default that is synthesised for a team without one — a caller
  // that cannot tell them apart will persist the default over the user's own
  // pairing. Undefined only when the team is gone.
  getGraph: (teamId: string) => Promise<{ explicit: boolean; graph: TeamCollaborationGraph } | undefined>
  // Validation failures come back as errors rather than throwing, so the caller
  // can show which links were rejected instead of losing the edit.
  setGraph: (
    teamId: string,
    graph: TeamCollaborationGraph | undefined,
  ) => Promise<{ ok: true; errors: string[]; team?: AgentTeam } | { ok: false; errors: string[] }>
}

export type RuntimeAPI = {
  ensure: (name: RuntimeName) => Promise<RuntimeStatus>
  preparePluginCommand: (command: string[]) => Promise<{ command: string[]; status?: RuntimeStatus }>
}

export type LocalMemoryAPI = {
  read: () => Promise<LocalMemoryState>
  write: (content: string) => Promise<LocalMemoryState>
  clear: () => Promise<LocalMemoryState>
}

// Edits the global AGENTS.md the engine already loads on every prompt, so these
// instructions apply to every new session without a second mechanism.
// Hand-mirrored from main/repo-rules-model.ts, the same convention every other
// type crossing this boundary follows.
export type RepoRule = {
  id: string
  description: string
  repositoryPath: string
  filePatterns: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type SaveRepoRuleInput = {
  id?: string
  description: string
  repositoryPath: string
  filePatterns: string[]
  enabled?: boolean
}

export type WorkItem = {
  id: string
  provider: "github" | "linear" | "jira"
  key: string
  title: string
  body: string
  url: string
  state: string
  status: "todo" | "in-progress" | "review" | "done"
  assignee?: string
  labels: string[]
  updatedAt: string
  comments: { author: string; text: string }[]
  brief: string
}

export type WorkItemsAPI = {
  list: (cwd: string) => Promise<{
    items: WorkItem[]
    problems: { provider: "github" | "linear" | "jira"; message: string }[]
  }>
  config: () => Promise<{ linear: boolean; jira: boolean; jiraSite?: string }>
  saveConfig: (next: {
    linear?: { token: string }
    jira?: { site: string; email: string; token: string; jql?: string }
  }) => Promise<{ linear: boolean; jira: boolean; jiraSite?: string }>
  clear: (provider: "linear" | "jira") => Promise<{ linear: boolean; jira: boolean; jiraSite?: string }>
}

export type RepoRulesAPI = {
  list: (repositoryPath?: string) => Promise<RepoRule[]>
  save: (input: SaveRepoRuleInput) => Promise<RepoRule>
  remove: (id: string) => Promise<RepoRule[]>
}

export type CustomInstructionsAPI = {
  read: () => Promise<CustomInstructionsState>
  write: (content: string) => Promise<CustomInstructionsState>
  clear: () => Promise<CustomInstructionsState>
}

export type PullRequestsAPI = {
  status: () => Promise<PullRequestCliStatus>
  list: (
    cwd: string,
    options?: { state?: "open" | "closed" | "merged" | "all"; limit?: number },
  ) => Promise<PullRequestSummary[]>
  view: (cwd: string, number: number) => Promise<PullRequestDetail>
  diff: (cwd: string, number: number) => Promise<string>
  create: (input: { cwd: string; title: string; body: string; base?: string; draft?: boolean }) => Promise<{ url: string }>
  review: (input: {
    cwd: string
    number: number
    body: string
    event: "comment" | "approve" | "request-changes"
  }) => Promise<{ posted: boolean }>
  merge: (input: { cwd: string; number: number; strategy: "merge" | "squash" | "rebase" }) => Promise<{ merged: boolean }>
}

// Nothing here rejects: `gh` missing, `gh` signed out, or a project that is not
// a GitHub repository all arrive as CiUnavailable, which names the reason and
// the one command that fixes it.
export type CiAPI = {
  status: (projectPath: string) => Promise<{ ok: true; repo: CiRepo } | CiUnavailable>
  runs: (
    projectPath: string,
    options?: { branch?: string; limit?: number },
  ) => Promise<{ ok: true; repo: CiRepo; runs: CiRun[] } | CiUnavailable>
  failure: (projectPath: string, runId: number) => Promise<{ ok: true; failure: CiFailure } | CiUnavailable>
  repair: (
    projectPath: string,
    runId: number,
  ) => Promise<{ ok: true; failure: CiFailure; prompt: string } | CiUnavailable>
}

export type SpendLimitsAPI = {
  limits: () => Promise<SpendPolicy>
  // Omitted limit sets keep their stored value, so a settings pane can save the
  // interactive caps without also rewriting the unattended ones.
  setLimits: (next: Partial<SpendPolicy>) => Promise<SpendPolicy>
  // With a projectPath the summary also carries that project's own day and
  // month totals alongside the account-wide ones.
  status: (projectPath?: string) => Promise<SpendSummary>
  recent: (limit?: number) => Promise<SpendEvent[]>
}

export type FailureMemoryAPI = {
  read: (projectPath: string) => Promise<FailureMemory>
  clear: (projectPath: string) => Promise<FailureMemory>
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

// Hand-mirrored from main/parallel-workspace-turns.ts, the same convention the
// record below already follows across this boundary.
export type ParallelWorkspaceTurn = {
  id: string
  role: "user" | "agent" | "vector"
  text: string
  at: string
  state: "running" | "done" | "failed" | "stopped"
  resumed?: boolean
  cost?: string
  streamTail?: string[]
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
  externalSessionId?: string
  turns?: ParallelWorkspaceTurn[]
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
  license: LicenseAPI
  reportBug: (input: { message: string; email?: string }) => Promise<{ delivered: boolean; error?: string }>
  askHelpAssistant: (input: {
    messages: { role: "user" | "assistant"; content: string }[]
    context: string
  }) => Promise<{ reply?: string; error?: string }>
  agentTeams: AgentTeamsAPI
  convertHeic: (bytes: Uint8Array) => Promise<{ data: Uint8Array; mime: string } | { error: string }>
  runtime: RuntimeAPI
  localMemory: LocalMemoryAPI
  customInstructions: CustomInstructionsAPI
  repoRules: RepoRulesAPI
  workItems: WorkItemsAPI
  pullRequests: PullRequestsAPI
  ci: CiAPI
  spendLimits: SpendLimitsAPI
  failureMemory: FailureMemoryAPI
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
  voice: {
    speak: (text: string) => Promise<VoiceSpeechResult>
    stop: () => Promise<void>
  }

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
    followUp: (id: string, text: string) => Promise<ParallelWorkspaceRecord>
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
    mergeSelection: (id: string, selection: ParallelWorkspaceMergeSelection, force?: boolean) => Promise<SwarmRunRecord>
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
      add: (
        projectPath: string,
        taskId: string | undefined,
        input: { domain: string; slug?: string },
      ) => Promise<CloudDomain>
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
    services: {
      supabase: (projectPath: string, taskId?: string) => Promise<CloudSupabaseServices>
    }
    aws: {
      status: (input?: { profile?: string; region?: string }) => Promise<CloudAwsStatus>
      resources: (input?: { profile?: string; region?: string }) => Promise<CloudAwsSnapshot>
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
  setPaused: (id: string, paused: boolean) => Promise<ScheduledAgentRecord | undefined>
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
