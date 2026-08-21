import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  Suspense,
  type ParentProps,
} from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { usePlanMode } from "@/context/plan-mode"
import { usePlatform } from "@/context/platform"
import { decode64 } from "@/utils/base64"
import { pathKey } from "@/utils/path-key"
import { taskScopeId, taskScopeSearch, type TaskScope } from "@/utils/task-scope"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { ModelSelectorPopoverV2, type ModelSelectorModelState } from "@/components/dialog-select-model"
import { DialogSelectMcp } from "@/components/dialog-select-mcp"
import { DialogSelectPlugins } from "@/components/dialog-select-plugins"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { installActivityEventBridge } from "@/services/activity-service"
import { SDKProvider } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { DialogReportBug } from "@/components/dialog-report-bug"
import { HelpPanel } from "@/features/help/help-panel"
import { AgentDashboard } from "@/features/agents/agent-dashboard"
import { useSettings } from "@/context/settings"
import type { TeamConversation } from "@/features/agents/agent-dashboard-model"
import { ExternalRuntimeSetupPanel } from "@/features/agents/external-runtime-setup"
import { externalRuntimeSetup, isExternalRuntime, type ExternalRuntime } from "@/features/agents/external-runtimes"
import { PullRequests } from "@/features/pull-requests/pull-requests"
import { extractVelReply } from "@/features/vel/vel-call"
import { isInternalProjectPath, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { sessionHref } from "@/utils/session-route"
import { DB_INTENT_EVENT } from "@/features/cloud/db-intent"
import { OnboardingProgress } from "@/features/onboarding/onboarding"
import { SpotlightTour } from "@/features/onboarding/spotlight-tour"
import { createSpotlightSteps } from "@/features/onboarding/spotlight-steps"
import { outcomesFromWorkspaceRecord, recordOutcome } from "@/features/economics/economics-repository"
import { categorizeTask } from "@/features/economics/task-categorizer"
import { measureUsage } from "@/features/economics/token-usage"
import { outcomeFromSession } from "@/features/economics/session-outcomes"
import {
  ONBOARDING_UPDATED_EVENT,
  readOnboardingFlags,
  setOnboardingFlag,
  successfulActivationFromSession,
} from "@/features/onboarding/onboarding-progress"
import { ParallelDiffReview } from "@/components/parallel-diff-review"
import { WorkspaceNavigation, type WorkspaceNavigationItem } from "@/components/workspace-navigation"
import { CanvasWorkspace } from "@/features/canvas/canvas"
import { useUpdaterAction } from "@/components/updater-action"
import { VelCall } from "@/features/vel/vel-call"
import { VEL_OPEN_EVENT } from "@/features/vel/vel-message"

const NAVIGATION_DEFAULT_WIDTH = 320
const NAVIGATION_MINIMUM_WIDTH = 228
const NAVIGATION_MAXIMUM_WIDTH = 460
const NAVIGATION_WIDTH_KEY = "vector.navigation-width.v1"
const LAST_ACTIVE_PROJECT_KEY = "vector.last-active-project-path.v1"
const RETIRED_WORK_STATE_KEY = "vector.work.state.v1"
const AGENT_TAB_ORDER_PREFIX = "vector.agent-tab-order.v1:"
const RESERVED_TOP_LEVEL_ROUTES = new Set(["code", "work", "parallel-workspaces", "cloud", "canvas"])
type ParallelAgentRuntime = "vector" | "claude-code" | "codex" | "cursor"

function readNavigationWidth() {
  const raw = globalThis.localStorage?.getItem(NAVIGATION_WIDTH_KEY)
  const saved = raw ? Number(raw) : Number.NaN
  if (!Number.isFinite(saved)) return NAVIGATION_DEFAULT_WIDTH
  return Math.min(NAVIGATION_MAXIMUM_WIDTH, Math.max(NAVIGATION_MINIMUM_WIDTH, saved))
}

type ExternalAgentStatus = {
  id: string
  name: string
  cli: string
  installed: boolean
  version?: string
  path?: string
}

function readAgentTabOrder(scopeID: string) {
  const raw = globalThis.localStorage?.getItem(`${AGENT_TAB_ORDER_PREFIX}${scopeID}`)
  if (!raw) return [] as string[]
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [] as string[]
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    return [] as string[]
  }
}

type ParallelWorkspaceStatus =
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

type WorkspaceValidationCheck = {
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

type WorkspaceValidationReport = {
  startedAt: string
  completedAt: string
  passed: boolean
  hadChecks: boolean
  checks: WorkspaceValidationCheck[]
  failureSummary: string
}

type ParallelWorkspaceRecord = {
  id: string
  name: string
  taskPrompt: string
  runtime: ParallelAgentRuntime
  provider: string
  model: string
  sourcePath: string
  parentSessionId?: string
  isolatedPath: string
  isolation: "git-worktree" | "copy"
  gitBranch?: string
  baseCommit?: string
  agentSessionId?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
  teamId?: string
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
  contextFiles?: string[]
  contextIndexedFiles?: number
  contextTokenEstimate?: number
  contextSummary?: string
  validationReport?: WorkspaceValidationReport
  validationPassed?: boolean
  repairAttempts?: number
  error?: string
}

type ParallelWorkspaceApi = {
  list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<ParallelWorkspaceRecord[]>
  create: (input: {
    sourcePath: string
    parentSessionId?: string
    name?: string
    taskPrompt: string
    runtime?: ParallelAgentRuntime
    provider?: string
    model?: string
    teamId?: string
    sharedPath?: string
    llmJudge?: boolean
  }) => Promise<ParallelWorkspaceRecord>
  refresh: (id: string) => Promise<ParallelWorkspaceRecord>
  run: (id: string, concurrency?: number) => Promise<ParallelWorkspaceRecord>
  stop: (id: string) => Promise<ParallelWorkspaceRecord>
  merge: (id: string, force?: boolean, commit?: { message: string }) => Promise<ParallelWorkspaceRecord>
  mainDiff: (sourcePath: string) => Promise<string>
  pullRequest: (id: string) => Promise<ParallelWorkspaceRecord>
  mergeSelection: (
    id: string,
    selection: { hunkIds?: string[]; files?: string[] },
    force?: boolean,
  ) => Promise<ParallelWorkspaceRecord>
  discard: (id: string) => Promise<ParallelWorkspaceRecord>
  remove: (id: string) => Promise<ParallelWorkspaceRecord[]>
}

type SwarmRunStatus =
  | "planning"
  | "running"
  | "needs review"
  | "complete"
  | "failed"
  | "canceled"
  | "interrupted"
  | "merged"
  | "discarded"

type SwarmTaskRecord = {
  id: string
  title: string
  prompt: string
  role: "explore" | "implement" | "debug" | "test" | "review" | "security" | "docs"
  dependsOn: string[]
  fileHints: string[]
  provider: string
  model: string
  status:
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
  workspaceId?: string
  startedAt?: string
  completedAt?: string
  lastAction: string
  changedFilesCount: number
  riskLevel: "low" | "medium" | "high"
  summary: string
  error?: string
}

type SwarmRunRecord = {
  id: string
  name: string
  objective: string
  sourcePath: string
  parentSessionId?: string
  strategy: "economy" | "balanced" | "quality"
  maxAgents: number
  maxConcurrency: number
  modelPool: { provider: string; model: string; label?: string }[]
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

// Mirrors packages/desktop/src/main/agent-team-model.ts. The app package cannot
// import it — desktop depends on app, not the reverse — so these declarations
// are duplicated and must stay byte-identical to the preload types. The last
// bug in this area was a hand-rolled shape that omitted getGraph/setGraph and
// therefore made a wired-up backend look unimplemented, so nothing here may be
// narrowed to "only what this file happens to call".
type TeamTopology = "isolated" | "collaborative" | "shared-main"

type TeamLink = {
  from: string
  to: string
  mutual?: boolean
}

type TeamCollaborationGraph = {
  links: TeamLink[]
}

type TeamMessage = {
  id: string
  teamId: string
  fromWorkspaceId: string
  fromName: string
  toWorkspaceId?: string
  text: string
  createdAt: string
  deliveredTo: string[]
}

type AgentTeam = {
  id: string
  name: string
  topology: TeamTopology
  sourcePath: string
  parentSessionId?: string
  sharedPath?: string
  memberIds: string[]
  // Absent means all-to-all: every member may message every other member.
  collaboration?: TeamCollaborationGraph
  createdAt: string
  messages: TeamMessage[]
}

// Mirrors AgentTeamsAPI in packages/desktop/src/preload/types.ts.
type AgentTeamsApi = {
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
  getGraph: (teamId: string) => Promise<TeamCollaborationGraph | undefined>
  setGraph: (teamId: string, graph: TeamCollaborationGraph | undefined) => Promise<AgentTeam | undefined>
}

// The graph is drawn before the agents it describes exist, so a member this
// launch is about to create is held under a placeholder id and swapped for the
// real workspace id once the record comes back.
const PENDING_MEMBER_PREFIX = "pending:"

const collaborationLinkKey = (from: string, to: string) => `${from}>${to}`

type SwarmOrchestratorApi = {
  list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<SwarmRunRecord[]>
  create: (input: {
    sourcePath: string
    parentSessionId?: string
    name?: string
    objective: string
    primaryProvider: string
    primaryModel: string
    modelPool?: { provider: string; model: string; label?: string }[]
    strategy?: "economy" | "balanced" | "quality"
    maxAgents?: number
    maxConcurrency?: number
  }) => Promise<SwarmRunRecord>
  resume: (id: string) => Promise<SwarmRunRecord>
  stop: (id: string) => Promise<SwarmRunRecord>
  merge: (id: string, force?: boolean) => Promise<SwarmRunRecord>
  mergeSelection: (
    id: string,
    selection: { hunkIds?: string[]; files?: string[] },
    force?: boolean,
  ) => Promise<SwarmRunRecord>
  discard: (id: string) => Promise<SwarmRunRecord>
}

type BackgroundTaskStatus =
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

type BackgroundTaskKind = "parallel-workspace" | "browser-agent" | "terminal" | "agent" | "checkpoint"

type BackgroundTaskAction = {
  id: string
  at: string
  label: string
  status: "pending" | "running" | "success" | "warning" | "failed"
  detail?: string
}

type BackgroundTaskRecord = {
  id: string
  kind: BackgroundTaskKind
  projectPath: string
  taskId?: string
  workspaceId?: string
  workspaceName?: string
  name: string
  prompt: string
  provider?: string
  model?: string
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
  costEstimate?: string
  actualUsage?: string
  errorSummary?: string
  logs: string[]
  actions: BackgroundTaskAction[]
  mergeState?: "none" | "merged" | "discarded"
}

type BackgroundTasksApi = {
  list: (scope?: { projectPath?: string; taskId?: string }) => Promise<BackgroundTaskRecord[]>
  cancel: (id: string) => Promise<BackgroundTaskRecord>
  clearCompleted: (scope?: { projectPath?: string; taskId?: string }) => Promise<BackgroundTaskRecord[]>
}

type DiffViewMode = "agent" | "main" | "split"

// Segmented control that switches the agent Review & Merge diff between the
// agent's isolated worktree, the user's main working tree, and a side-by-side
// view. Rendered above ParallelDiffReview in both the fullscreen and modal views.
function DiffModeToggle(props: { mode: DiffViewMode; onMode: (mode: DiffViewMode) => void }) {
  const options: { key: DiffViewMode; label: string }[] = [
    { key: "agent", label: "Agent tree" },
    { key: "main", label: "Main" },
    { key: "split", label: "Side-by-side" },
  ]
  return (
    <div class="inline-flex items-center gap-0.5 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.025] p-0.5">
      <For each={options}>
        {(option) => (
          <button
            type="button"
            class="rounded-[8px] px-2.5 py-1 text-[11.5px] font-medium transition"
            classList={{
              "bg-white/[0.1] text-white/88": props.mode === option.key,
              "text-white/50 hover:text-white/78": props.mode !== option.key,
            }}
            onClick={() => props.onMode(option.key)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const updaterAction = useUpdaterAction()
  const planMode = usePlanMode()
  const command = useCommand()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const [reportBugOpen, setReportBugOpen] = createSignal(false)
  const [helpPanelOpen, setHelpPanelOpen] = createSignal(false)
  const [agentDashboardOpen, setAgentDashboardOpen] = createSignal(false)
  const [teamConversations, setTeamConversations] = createSignal<TeamConversation[]>([])
  const settings = useSettings()
  const [parallelTopology, setParallelTopology] = createSignal<TeamTopology>("isolated")
  const [parallelJoinTeamId, setParallelJoinTeamId] = createSignal<string>()
  const [openTeams, setOpenTeams] = createSignal<AgentTeam[]>([])
  const [collaborationShape, setCollaborationShape] = createSignal<"all" | "coordinator" | "custom">("all")
  const [collaborationCoordinator, setCollaborationCoordinator] = createSignal<string>()
  const [collaborationLinks, setCollaborationLinks] = createSignal<string[]>([])

  const agentTeamsApi = () =>
    (globalThis.window as unknown as { api?: { agentTeams?: AgentTeamsApi } })?.api?.agentTeams

  const refreshOpenTeams = async () => {
    const api = agentTeamsApi()
    if (!api) return
    setOpenTeams(await api.list({ sourcePath: activeWorkspaceScope().sourcePath }).catch(() => []))
  }

  // Teams are read when the dashboard opens rather than on the workspace poll:
  // the transcript only matters while it is on screen, and the agent list has
  // its own refresh already.
  const refreshTeamConversations = async () => {
    const api = agentTeamsApi()
    if (!api) return
    const list = await api.list({ sourcePath: activeWorkspaceScope().sourcePath }).catch(() => [])
    setTeamConversations(list.map((team) => ({ teamId: team.id, teamName: team.name, messages: team.messages ?? [] })))
  }
  const [pullRequestsOpen, setPullRequestsOpen] = createSignal(false)
  const server = useServer()
  const tabs = useTabs()
  const layout = useLayout()
  const navigate = useNavigate()
  const location = useLocation()
  const [toolsOpen, setToolsOpen] = createSignal(false)
  const [engineeringRefreshBusy, setEngineeringRefreshBusy] = createSignal(false)
  const [sidePanelOpen, setSidePanelOpen] = createSignal(false)
  const [chatSearchOpen, setChatSearchOpen] = createSignal(false)
  const [chatSearchValue, setChatSearchValue] = createSignal("")
  const [navigationVisible, setNavigationVisible] = createSignal(true)
  const [navigationWidth, setNavigationWidth] = createSignal(readNavigationWidth())
  const [navigationResizing, setNavigationResizing] = createSignal(false)
  const [velOpen, setVelOpen] = createSignal(false)
  const [velScopeKey, setVelScopeKey] = createSignal("")
  const [workspaceTreeOpen, setWorkspaceTreeOpen] = createSignal(true)
  const [browserAgentOpen, setBrowserAgentOpen] = createSignal(false)
  const [parallelOpen, setParallelOpen] = createSignal(false)
  const [parallelRecords, setParallelRecords] = createSignal<ParallelWorkspaceRecord[]>([])
  const [parallelSelectedID, setParallelSelectedID] = createSignal<string>()
  const [swarmRuns, setSwarmRuns] = createSignal<SwarmRunRecord[]>([])
  const [swarmSelectedID, setSwarmSelectedID] = createSignal<string>()
  const [parallelLaunchMode, setParallelLaunchMode] = createSignal<"agent" | "swarm">("agent")
  const [swarmStrategy, setSwarmStrategy] = createSignal<"economy" | "balanced" | "quality">("balanced")
  const [swarmMaxAgents, setSwarmMaxAgents] = createSignal(8)
  const [swarmConcurrency, setSwarmConcurrency] = createSignal(4)
  const [parallelName, setParallelName] = createSignal("")
  const [parallelPrompt, setParallelPrompt] = createSignal("")
  const [parallelProvider, setParallelProvider] = createSignal("")
  const [parallelModel, setParallelModel] = createSignal("")
  const [parallelRuntime, setParallelRuntime] = createSignal<ParallelAgentRuntime>("vector")
  const [parallelCompareRuntimes, setParallelCompareRuntimes] = createSignal(false)
  const [externalAgentStatuses, setExternalAgentStatuses] = createSignal<ExternalAgentStatus[]>([])
  const [externalAgentsChecking, setExternalAgentsChecking] = createSignal(false)
  const [parallelFilter, setParallelFilter] = createSignal("")
  const [parallelBusy, setParallelBusy] = createSignal(false)
  const [parallelError, setParallelError] = createSignal("")
  const [parallelComposerOpen, setParallelComposerOpen] = createSignal(false)
  const byokProviders = useProviders()
  const byokModels = useModels()
  const parallelModelState: ModelSelectorModelState = {
    list: byokModels.list,
    visible: byokModels.visible,
    current: () =>
      byokModels.list().find((item) => item.provider.id === parallelProvider() && item.id === parallelModel()),
    set: (key) => {
      if (!key) return
      setParallelProvider(key.providerID)
      setParallelModel(key.modelID)
    },
  }
  const parallelModelOptions = createMemo(() =>
    byokProviders.connected().flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        providerID: provider.id,
        providerName: provider.name || provider.id,
        modelID: model.id,
        modelName: model.name || model.id,
      })),
    ),
  )
  createEffect(() => {
    const options = parallelModelOptions()
    if (options.length === 0) return
    const recent = byokModels.recent
      .list()
      .find((item) =>
        options.some((option) => option.providerID === item.providerID && option.modelID === item.modelID),
      )
    const selected = recent
      ? options.find((option) => option.providerID === recent.providerID && option.modelID === recent.modelID)
      : (options.find((option) => option.providerID === parallelProvider() && option.modelID === parallelModel()) ??
        options[0])
    if (!selected) return
    if (selected.providerID === parallelProvider() && selected.modelID === parallelModel()) return
    setParallelProvider(selected.providerID)
    setParallelModel(selected.modelID)
  })
  const detectExternalRuntimes = () => {
    const api = (
      globalThis.window?.api as
        | (typeof globalThis.window.api & {
            externalAgents?: { detect?: () => Promise<ExternalAgentStatus[]> }
          })
        | undefined
    )?.externalAgents
    if (!api?.detect) return
    setExternalAgentsChecking(true)
    void api
      .detect()
      .then(setExternalAgentStatuses)
      .catch(() => setExternalAgentStatuses([]))
      .finally(() => setExternalAgentsChecking(false))
  }
  createEffect(() => {
    if (!parallelComposerOpen() || parallelLaunchMode() !== "agent") return
    void refreshOpenTeams()
    if (externalAgentStatuses().length || externalAgentsChecking()) return
    const api = (
      globalThis.window?.api as
        | (typeof globalThis.window.api & {
            externalAgents?: { detect?: () => Promise<ExternalAgentStatus[]> }
          })
        | undefined
    )?.externalAgents
    if (!api?.detect) return
    setExternalAgentsChecking(true)
    void api
      .detect()
      .then(setExternalAgentStatuses)
      .catch(() => setExternalAgentStatuses([]))
      .finally(() => setExternalAgentsChecking(false))
  })
  const [parallelDetailTab, setParallelDetailTab] = createSignal<"session" | "review">("session")
  const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>("agent")
  const [mainDiffTick, setMainDiffTick] = createSignal(0)
  const [commitMessage, setCommitMessage] = createSignal("")
  const [commitMessageTouched, setCommitMessageTouched] = createSignal(false)
  const [agentReviewOpen, setAgentReviewOpen] = createSignal(false)
  const [orchestrationOpen, setOrchestrationOpen] = createSignal(false)
  const [pendingAgentOpenID, setPendingAgentOpenID] = createSignal<string>()
  const [backgroundTaskRecords, setBackgroundTaskRecords] = createSignal<BackgroundTaskRecord[]>([])
  globalThis.localStorage?.removeItem(RETIRED_WORK_STATE_KEY)
  const persistedLastProjectPath = globalThis.localStorage?.getItem(LAST_ACTIVE_PROJECT_KEY) ?? ""
  const [lastProjectPath, setLastProjectPath] = createSignal(
    isInternalProjectPath(persistedLastProjectPath) ? "" : persistedLastProjectPath,
  )
  if (isInternalProjectPath(persistedLastProjectPath)) {
    globalThis.localStorage?.removeItem(LAST_ACTIVE_PROJECT_KEY)
  }
  const [agentTabOrder, setAgentTabOrder] = createSignal<string[]>([])
  let chatSearchRef: HTMLInputElement | undefined
  let parallelPromptRef: HTMLTextAreaElement | undefined
  let stopNavigationResize: (() => void) | undefined
  setNavigate(navigate)

  createEffect(() => setV2Toast(true))
  createEffect(() => layout.sidebar.close())
  createEffect(() => globalThis.localStorage?.setItem(NAVIGATION_WIDTH_KEY, String(navigationWidth())))

  const resizeNavigation = (width: number) => {
    setNavigationWidth(Math.min(NAVIGATION_MAXIMUM_WIDTH, Math.max(NAVIGATION_MINIMUM_WIDTH, Math.round(width))))
  }

  const beginNavigationResize = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    stopNavigationResize?.()
    const startX = event.clientX
    const startWidth = navigationWidth()
    const move = (next: PointerEvent) => resizeNavigation(startWidth + next.clientX - startX)
    const stop = () => {
      globalThis.window?.removeEventListener("pointermove", move)
      globalThis.window?.removeEventListener("pointerup", stop)
      globalThis.window?.removeEventListener("pointercancel", stop)
      globalThis.window?.removeEventListener("blur", stop)
      globalThis.document?.documentElement.removeAttribute("data-vector-navigation-resizing")
      setNavigationResizing(false)
      globalThis.localStorage?.setItem(NAVIGATION_WIDTH_KEY, String(navigationWidth()))
      stopNavigationResize = undefined
    }
    setNavigationResizing(true)
    globalThis.document?.documentElement.setAttribute("data-vector-navigation-resizing", "true")
    globalThis.window?.addEventListener("pointermove", move)
    globalThis.window?.addEventListener("pointerup", stop)
    globalThis.window?.addEventListener("pointercancel", stop)
    globalThis.window?.addEventListener("blur", stop)
    stopNavigationResize = stop
  }

  onCleanup(() => stopNavigationResize?.())

  // The Browser Agent's live page is a native Electron WebContentsView that
  // composites on top of all DOM, so it paints over any modal dialog. Hide it
  // whenever a dialog is open and restore it when the stack clears. The
  // main-process setVisible handler ignores contextId, so any value is fine.
  createEffect(() => {
    const modalOpen = Boolean(dialog.active)
    const run = globalThis.window?.api?.runBrowserAgent
    if (!run) return
    void run({ contextId: "modal", command: "setVisible", visible: !modalOpen }).catch(() => undefined)
  })
  command.register("vector-navigation", () => [
    {
      id: "vector.navigation.toggle",
      title: navigationVisible() ? "Hide Vector sidebar" : "Show Vector sidebar",
      category: "Vector",
      onSelect: () => setNavigationVisible((visible) => !visible),
    },
  ])
  createEffect(() => {
    const root = document.documentElement
    root.dataset.vectorTheme = "dark"
  })

  createEffect(() => {
    if (!chatSearchOpen()) return
    queueMicrotask(() => chatSearchRef?.focus())
  })

  createEffect(() => {
    if (!parallelComposerOpen()) return
    queueMicrotask(() => parallelPromptRef?.focus())
  })

  const routeProjectPath = () => {
    const parts = location.pathname.split("/").filter(Boolean)
    if (!parts.length || parts[0] === "server" || RESERVED_TOP_LEVEL_ROUTES.has(parts[0])) return ""
    return decode64(parts[0]) ?? ""
  }
  const routeSessionDirectory = () => {
    const sessionID = /\/session\/([^/?#]+)/.exec(location.pathname)?.[1]
    if (!sessionID) return ""
    return serverSync().session.get(decodeURIComponent(sessionID))?.directory ?? ""
  }
  const routeContextProjectPath = () => new URLSearchParams(location.search).get("project") ?? ""
  const routeContextSessionID = () => new URLSearchParams(location.search).get("parentSession") ?? ""
  const currentSessionID = () => {
    if (browserAgentRoute() || parallelWorkspacesRoute()) return routeContextSessionID()
    return decodeURIComponent(/\/session\/([^/?#]+)/.exec(location.pathname)?.[1] ?? "")
  }
  const activeDraftID = () => new URLSearchParams(location.search).get("draftId") ?? undefined
  const activeTaskSessionID = () => routeContextSessionID() || currentSessionID() || undefined
  const recentProjectPath = () => layout.projects.list().find((project) => project.worktree)?.worktree ?? ""
  const projectPathCandidates = () => [
    ...new Set(
      [
        routeContextProjectPath(),
        routeProjectPath(),
        routeSessionDirectory(),
        recentProjectPath(),
        lastProjectPath(),
      ].filter((path): path is string => Boolean(path) && !isInternalProjectPath(path)),
    ),
  ]
  const activeProjectPath = () => projectPathCandidates()[0] ?? ""
  const resolveActiveProjectPath = async () => {
    const candidates = projectPathCandidates()
    const api = globalThis.window?.api as
      | (typeof globalThis.window.api & {
          pathExists?: (path: string) => Promise<boolean>
        })
      | undefined
    if (!api?.pathExists) return candidates[0] ?? ""

    for (const candidate of candidates) {
      if (!(await api.pathExists(candidate).catch(() => false))) continue
      if (candidate !== lastProjectPath()) {
        setLastProjectPath(candidate)
        globalThis.localStorage?.setItem(LAST_ACTIVE_PROJECT_KEY, candidate)
      }
      return candidate
    }

    if (lastProjectPath()) {
      setLastProjectPath("")
      globalThis.localStorage?.removeItem(LAST_ACTIVE_PROJECT_KEY)
    }
    return ""
  }

  const rememberProjectPath = (path: string) => {
    if (!path || isInternalProjectPath(path)) return
    if (path !== lastProjectPath()) setLastProjectPath(path)
    globalThis.localStorage?.setItem(LAST_ACTIVE_PROJECT_KEY, path)
  }

  const resolveTaskWorkspace = async () => {
    const requestedSessionID = routeContextSessionID() || currentSessionID()
    const lineage = requestedSessionID
      ? await serverSync()
          .session.lineage.resolve(requestedSessionID)
          .catch(() => undefined)
      : undefined
    const parentSessionId = lineage?.root.id ?? (requestedSessionID || undefined)
    const candidates = [
      routeContextProjectPath(),
      lineage?.root.directory,
      lineage?.session.directory,
      routeProjectPath(),
      routeSessionDirectory(),
      lastProjectPath(),
    ].filter((path): path is string => Boolean(path))
    const unique = [...new Set(candidates)]
    const api = globalThis.window?.api as
      | (typeof globalThis.window.api & {
          pathExists?: (path: string) => Promise<boolean>
        })
      | undefined
    if (!api?.pathExists) {
      const sourcePath = unique[0] ?? ""
      rememberProjectPath(sourcePath)
      return { sourcePath, parentSessionId }
    }
    for (const sourcePath of unique) {
      if (!(await api.pathExists(sourcePath).catch(() => false))) continue
      rememberProjectPath(sourcePath)
      return { sourcePath, parentSessionId }
    }
    return { sourcePath: "", parentSessionId }
  }

  createEffect(() => {
    const path = routeContextProjectPath() || routeProjectPath() || routeSessionDirectory()
    if (!path || isInternalProjectPath(path)) return
    setLastProjectPath(path)
    globalThis.localStorage?.setItem(LAST_ACTIVE_PROJECT_KEY, path)
  })

  const browserAgentRoute = () => location.pathname === "/browser-agent"
  const parallelWorkspacesRoute = () =>
    location.pathname === "/parallel-workspaces" || location.pathname.startsWith("/parallel-workspaces/")
  const cloudRoute = () => location.pathname === "/cloud"
  const canvasRoute = () => location.pathname === "/canvas"
  const activeTaskScope = (): TaskScope => ({
    projectPath: routeContextProjectPath() || activeProjectPath(),
    taskId: activeTaskSessionID(),
  })
  const activeWorkspaceScope = () => ({
    sourcePath: activeTaskScope().projectPath,
    parentSessionId: activeTaskScope().taskId,
  })
  const parallelWorkspaceIDFromRoute = () => {
    const parts = location.pathname.split("/").filter(Boolean)
    return parts[0] === "parallel-workspaces" && parts[1] !== "swarm" ? parts[1] : undefined
  }
  const swarmRunIDFromRoute = () => {
    const parts = location.pathname.split("/").filter(Boolean)
    return parts[0] === "parallel-workspaces" && parts[1] === "swarm" ? parts[2] : undefined
  }

  const [fullscreenReturnPath, setFullscreenReturnPath] = createSignal("/")

  createEffect(() => {
    const path = location.pathname
    // Fullscreen workspaces (cloud/canvas/parallel) must NOT be
    // recorded as the return target, or their own "Back" button would navigate
    // to the page you're already on. Cloud was missing here — that was the bug.
    if (browserAgentRoute() || parallelWorkspacesRoute() || canvasRoute() || cloudRoute()) return
    setFullscreenReturnPath(path + (location.search ?? ""))
  })

  const closeFullscreenWorkspace = () => {
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    setParallelComposerOpen(false)
    navigate(fullscreenReturnPath() || "/")
  }

  // ---- Canvas ↔ shell bridge ----------------------------------------------
  // Canvas hosts light surfaces itself; heavier ones (and voice actions) call
  // back into the shell's real open/create flows.

  // Terminal / Code editor / Review / Preview live inside a session view, which
  // the fullscreen Canvas route unmounts. Launching one from Canvas used to hit
  // the URL-based task gate and wrongly toast "Open a task first" even though a
  // task was open (Canvas was reached FROM it). Instead, return to that task —
  // fullscreenReturnPath holds the route Canvas was opened from — and fire the
  // command once the session view has re-registered it.
  const runInActiveTask = (feature: string, commandId: string) => {
    const target = fullscreenReturnPath()
    const targetIsTask = /\/session\/[^/?#]+/.test(target)
    if (!taskRoute() && !targetIsTask) {
      showToast({ title: "Open a project first", description: `${feature} runs inside an active Vector project.` })
      return
    }
    setSidePanelOpen(false)
    setToolsOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    if (!taskRoute() && targetIsTask) navigate(target)
    let tries = 0
    const fire = () => {
      if (sessionCommandRegistered(commandId)) {
        command.trigger(commandId)
        return
      }
      if (tries++ > 40) return
      setTimeout(fire, 50)
    }
    fire()
  }

  const eventTargetInsideFloatingSurface = (target: EventTarget | null) =>
    typeof HTMLElement !== "undefined" &&
    target instanceof HTMLElement &&
    Boolean(
      target.closest('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-slot="dialog"]'),
    )

  const eventTargetIsEditable = (target: EventTarget | null) =>
    typeof HTMLElement !== "undefined" &&
    target instanceof HTMLElement &&
    (target.isContentEditable || Boolean(target.closest("input, textarea, select")))

  const floatingSurfaceOpen = () =>
    typeof document !== "undefined" &&
    Boolean(
      document.querySelector(
        '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-slot="dialog"]',
      ),
    )

  createEffect(() => {
    const dispose = installActivityEventBridge(() => taskScopeId(activeTaskScope()))
    onCleanup(dispose)
  })

  // Composer-side delegation suggestion ("vector:delegate-parallel"): hand
  // the detected missions to the isolated-agent launcher, using the
  // same "---"-separated multi-mission convention as its own textarea.
  createEffect(() => {
    const handleDelegateParallel = (event: Event) => {
      const missions = (event as CustomEvent<{ missions?: string[] }>).detail?.missions
      if (!missions?.length) return
      setParallelPrompt(missions.join("\n---\n"))
      openParallelWorkspaces()
      setParallelComposerOpen(true)
    }
    globalThis.window?.addEventListener("vector:delegate-parallel", handleDelegateParallel)
    onCleanup(() => globalThis.window?.removeEventListener("vector:delegate-parallel", handleDelegateParallel))
  })

  const selectedParallelWorkspace = createMemo(() => {
    return parallelRecords().find((record) => record.id === parallelSelectedID()) ?? parallelRecords()[0]
  })

  const selectedSwarmRun = createMemo(() => swarmRuns().find((run) => run.id === swarmSelectedID()))

  const mainTaskSessionID = () => routeContextSessionID() || currentSessionID()
  const activeAgentWorkspace = createMemo(() => {
    const sessionWorkspace = parallelRecords().find((record) => record.agentSessionId === currentSessionID())
    if (sessionWorkspace) return sessionWorkspace
    if (!agentReviewOpen()) return undefined
    const selected = parallelRecords().find((record) => record.id === parallelSelectedID())
    return selected?.runtime === "vector" ? undefined : selected
  })
  const sidebarActiveAgentID = createMemo(() => {
    const sessionWorkspace = parallelRecords().find((record) => record.agentSessionId === currentSessionID())
    if (sessionWorkspace) return sessionWorkspace.id
    if (agentReviewOpen()) return parallelSelectedID()
    return undefined
  })
  createEffect(() => {
    const record = activeAgentWorkspace()
    if (!record) return
    if (record.mergeState === "none" && !["merged", "discarded"].includes(record.status)) return
    void openMainAgent()
  })
  let loadedAgentTabOrderScope = ""
  createEffect(() => {
    const scopeID = taskScopeId(activeTaskScope())
    if (scopeID === loadedAgentTabOrderScope) return
    loadedAgentTabOrderScope = scopeID
    setAgentTabOrder(readAgentTabOrder(scopeID))
  })

  const persistAgentTabOrder = (order: string[]) => {
    setAgentTabOrder(order)
    globalThis.localStorage?.setItem(
      `${AGENT_TAB_ORDER_PREFIX}${taskScopeId(activeTaskScope())}`,
      JSON.stringify(order),
    )
  }

  const reconcileAgentTabOrder = (records: ParallelWorkspaceRecord[]) => {
    const ids = records
      .filter((record) => record.swarmRole !== "coordinator" && record.mergeState === "none")
      .filter((record) => !["merged", "discarded"].includes(record.status))
      .map((record) => record.id)
    const known = new Set(ids)
    const next = [
      ...agentTabOrder().filter((id) => known.has(id)),
      ...ids.filter((id) => !agentTabOrder().includes(id)),
    ]
    if (next.join("\u0000") === agentTabOrder().join("\u0000")) return
    persistAgentTabOrder(next)
  }

  const moveAgentWorkspace = (sourceID: string, targetID: string) => {
    const current = agentTabRecords().map((record) => record.id)
    const sourceIndex = current.indexOf(sourceID)
    const targetIndex = current.indexOf(targetID)
    if (sourceIndex < 0 || targetIndex < 0) return
    const next = current.filter((id) => id !== sourceID)
    next.splice(targetIndex, 0, sourceID)
    persistAgentTabOrder(next)
  }

  const liveAgentStatus = (record: ParallelWorkspaceRecord) => {
    const sessionID = record.agentSessionId
    if (!sessionID) return record.status
    if ((serverSync().session.data.permission[sessionID]?.length ?? 0) > 0) return "waiting for approval"
    if ((serverSync().session.data.question[sessionID]?.length ?? 0) > 0) return "waiting for approval"
    if (serverSync().session.data.session_working(sessionID)) return "running"
    return record.status
  }

  const agentTabRecords = createMemo(() =>
    parallelRecords()
      .filter((record) => record.swarmRole !== "coordinator" && record.mergeState === "none")
      .filter((record) => !["merged", "discarded"].includes(record.status))
      .sort((a, b) => {
        const left = agentTabOrder().indexOf(a.id)
        const right = agentTabOrder().indexOf(b.id)
        if (left >= 0 && right >= 0) return left - right
        if (left >= 0) return -1
        if (right >= 0) return 1
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      }),
  )
  const mainAgentLabel = () => {
    const id = mainTaskSessionID()
    if (!id) return "Main agent"
    const title = serverSync().session.get(id)?.title?.trim()
    return title && title !== "New session" ? title : "Main agent"
  }
  const scopeForParallelRecord = (record: ParallelWorkspaceRecord) => {
    const run = record.swarmRunId ? swarmRuns().find((item) => item.id === record.swarmRunId) : undefined
    return {
      projectPath: run?.sourcePath ?? record.sourcePath,
      taskId: run?.parentSessionId ?? record.parentSessionId,
    }
  }
  const parallelRecordMatchesScope = (
    record: ParallelWorkspaceRecord,
    scope: { sourcePath: string; parentSessionId?: string },
  ) => {
    const recordScope = scopeForParallelRecord(record)
    if (scope.sourcePath && pathKey(recordScope.projectPath) !== pathKey(scope.sourcePath)) return false
    return recordScope.taskId === scope.parentSessionId
  }

  const parallelWorkspaceSessionHref = (record: ParallelWorkspaceRecord) => {
    const search = taskScopeSearch(scopeForParallelRecord(record))
    if (!record.agentSessionId) return ""
    return `${sessionHref(server.key, record.agentSessionId)}${search}`
  }

  createEffect(() => {
    const id = pendingAgentOpenID()
    if (!id) return
    const record = parallelRecords().find((item) => item.id === id)
    if (!record?.agentSessionId) return
    setPendingAgentOpenID(undefined)
    void openParallelWorkspace(record)
  })

  const formatParallelDate = (value: string) => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return "Unknown"
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date)
  }

  const parallelStatusTone = (status: ParallelWorkspaceStatus) => {
    if (status === "merged" || status === "complete") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
    if (status === "failed") return "border-red-400/25 bg-red-400/10 text-red-100"
    if (status === "needs review" || status === "testing") return "border-amber-300/25 bg-amber-300/10 text-amber-100"
    if (status === "discarded" || status === "stopped")
      return "border-[color:var(--vx-line)] bg-white/[0.04] text-white/60"
    return "border-[color:var(--vx-purple)]/35 bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]"
  }

  const swarmStatusTone = (status: SwarmRunStatus) => {
    if (status === "merged" || status === "complete") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
    if (status === "failed") return "border-red-400/25 bg-red-400/10 text-red-100"
    if (status === "needs review" || status === "interrupted")
      return "border-amber-300/25 bg-amber-300/10 text-amber-100"
    if (status === "discarded" || status === "canceled")
      return "border-[color:var(--vx-line)] bg-white/[0.04] text-white/60"
    return "border-[color:var(--vx-purple)]/35 bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]"
  }

  const swarmTaskMarker = (status: SwarmTaskRecord["status"]) => {
    if (status === "complete") return "bg-emerald-400"
    if (status === "failed" || status === "blocked") return "bg-rose-400"
    if (status === "canceled" || status === "interrupted") return "bg-amber-300"
    if (["creating", "queued", "running", "merging"].includes(status)) return "bg-[color:var(--vx-purple-bright)]"
    return "bg-white/25"
  }

  const isSwarmRunning = (run: SwarmRunRecord) => run.status === "planning" || run.status === "running"

  const workspaceBackgroundTask = (workspace: ParallelWorkspaceRecord) => {
    return backgroundTaskRecords().find((task) => task.workspaceId === workspace.id)
  }

  const parallelDiffStats = (record: ParallelWorkspaceRecord) => {
    const lines = record.diff ? record.diff.split("\n") : []
    return {
      added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    }
  }

  const isParallelWorkspaceRunning = (record: ParallelWorkspaceRecord) =>
    record.mergeState === "none" &&
    ["queued", "planning", "editing", "running commands", "testing"].includes(record.status)

  const comparableAgentResults = createMemo(() =>
    parallelRecords()
      .filter((record) => record.swarmRole !== "coordinator")
      .filter((record) => !isParallelWorkspaceRunning(record))
      .filter((record) => record.status !== "queued" && record.status !== "discarded")
      .sort((left, right) => new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime()),
  )

  const parallelWorkspaceCurrentStep = (record: ParallelWorkspaceRecord) =>
    workspaceBackgroundTask(record)?.currentStep ||
    record.lastAction ||
    (record.status === "queued" ? "Queued for isolated execution" : "Waiting for activity")

  const parallelStatusLabel = (value: string) => value.replace(/_/g, " ")

  const parallelWorkspaceGroups = createMemo(() => {
    const query = parallelFilter().trim().toLowerCase()
    const records = parallelRecords().filter((record) => {
      if (!query) return true
      return [record.name, record.taskPrompt, record.provider, record.model, record.gitBranch, record.lastAction]
        .map((value) => value || "")
        .join(" ")
        .toLowerCase()
        .includes(query)
    })
    const buckets = [
      {
        id: "done",
        label: "Done",
        marker: "bg-emerald-400",
        records: records.filter(
          (record) =>
            record.mergeState === "merged" ||
            record.mergeState === "discarded" ||
            record.status === "merged" ||
            record.status === "complete" ||
            record.status === "discarded",
        ),
      },
      {
        id: "review",
        label: "In Review",
        marker: "bg-amber-300",
        records: records.filter(
          (record) =>
            record.mergeState === "none" &&
            record.status !== "failed" &&
            (record.status === "needs review" ||
              record.status === "testing" ||
              record.status === "stopped" ||
              record.changedFilesCount > 0),
        ),
      },
      {
        id: "progress",
        label: "In Progress",
        marker: "bg-[color:var(--vx-purple)]",
        records: records.filter(
          (record) =>
            record.mergeState === "none" &&
            (record.status === "queued" ||
              record.status === "planning" ||
              record.status === "editing" ||
              record.status === "running commands"),
        ),
      },
      {
        id: "failed",
        label: "Failed",
        marker: "bg-red-400",
        records: records.filter((record) => record.mergeState === "none" && record.status === "failed"),
      },
    ]
    const seen = new Set<string>()
    return buckets.map((bucket) => ({
      ...bucket,
      records: bucket.records.filter((record) => {
        if (seen.has(record.id)) return false
        seen.add(record.id)
        return true
      }),
    }))
  })

  const parallelFilteredCount = createMemo(() =>
    parallelWorkspaceGroups().reduce((sum, group) => sum + group.records.length, 0),
  )
  const filteredSwarmRuns = createMemo(() => {
    const query = parallelFilter().trim().toLowerCase()
    if (!query) return swarmRuns()
    return swarmRuns().filter((run) =>
      [run.name, run.objective, run.currentStep, run.status, run.plannerModel].join(" ").toLowerCase().includes(query),
    )
  })

  const parallelApi = () =>
    (
      globalThis.window?.api as
        | (typeof globalThis.window.api & { parallelWorkspaces?: ParallelWorkspaceApi })
        | undefined
    )?.parallelWorkspaces

  const parallelRuntimeLabel = (runtime: ParallelAgentRuntime) =>
    runtime === "claude-code"
      ? "Claude Code"
      : runtime === "codex"
        ? "Codex"
        : runtime === "cursor"
          ? "Cursor Agent"
          : "Vector"

  const externalRuntimeStatus = (runtime: ParallelAgentRuntime) =>
    runtime === "vector" ? undefined : externalAgentStatuses().find((agent) => agent.id === runtime)

  const parallelRuntimeReady = () =>
    parallelRuntime() === "vector"
      ? parallelModelOptions().length > 0
      : Boolean(externalRuntimeStatus(parallelRuntime())?.installed)

  const readyComparisonRuntimes = () =>
    (["vector", "claude-code", "codex", "cursor"] as ParallelAgentRuntime[]).filter((runtime) =>
      runtime === "vector" ? parallelModelOptions().length > 0 : Boolean(externalRuntimeStatus(runtime)?.installed),
    )

  // Runtimes the picker keeps visible but cannot launch, with the reason. A
  // runtime that is simply hidden is why this feature read as broken.
  const blockedRuntimes = () =>
    (["claude-code", "codex", "cursor"] as ExternalRuntime[])
      .filter((runtime) => !externalRuntimeStatus(runtime)?.installed)
      .map((runtime) => ({ runtime, setup: externalRuntimeSetup(runtime) }))

  // Who the collaboration graph is drawn over: teammates already in the picked
  // team, plus the agents this launch is about to add. Names come from the
  // workspace records because a team stores ids only.
  const collaborationRoster = createMemo(() => {
    const joined = openTeams().find((team) => team.id === parallelJoinTeamId())
    const existing = (joined?.memberIds ?? []).map((id) => ({
      id,
      name: parallelRecords().find((record) => record.id === id)?.name || "Teammate",
      pending: false,
    }))
    const pending = (parallelCompareRuntimes() ? readyComparisonRuntimes() : [parallelRuntime()]).map(
      (runtime, index) => ({
        id: `${PENDING_MEMBER_PREFIX}${index}`,
        name: parallelCompareRuntimes()
          ? `${parallelName().trim() || "Comparison"} · ${parallelRuntimeLabel(runtime)}`
          : parallelName().trim() || "This agent",
        pending: true,
      }),
    )
    return [...existing, ...pending]
  })

  // The graph to store for a roster, or undefined for all-to-all. Undefined is
  // not an empty graph: an empty link list means nobody may message anybody,
  // while an absent graph is the everyone-talks default every existing team has.
  const collaborationGraphFor = (memberIds: readonly string[]): TeamCollaborationGraph | undefined => {
    if (collaborationShape() === "all") return undefined
    if (collaborationShape() === "coordinator") {
      const coordinator = collaborationCoordinator() ?? memberIds[0]
      if (!coordinator) return undefined
      // Mutual, so a worker can answer the coordinator without gaining the
      // right to chatter with the other workers.
      return {
        links: memberIds.filter((id) => id !== coordinator).map((id) => ({ from: coordinator, to: id, mutual: true })),
      }
    }
    return {
      links: memberIds.flatMap((from) =>
        memberIds
          .filter((to) => to !== from && collaborationLinks().includes(collaborationLinkKey(from, to)))
          .map((to) => ({ from, to })),
      ),
    }
  }

  // A stored graph is only recognisable as the coordinator shape when exactly
  // one member is mutually linked to every other; anything else is custom.
  const coordinatorInGraph = (graph: TeamCollaborationGraph, memberIds: readonly string[]) => {
    const candidate = graph.links[0]?.from
    if (!candidate || graph.links.length !== memberIds.length - 1) return undefined
    if (!graph.links.every((link) => link.from === candidate && link.mutual === true)) return undefined
    return candidate
  }

  // Joining a team adopts the pairing it already has, so the composer edits the
  // live shape instead of silently overwriting it on launch.
  createEffect(() => {
    const teamId = parallelJoinTeamId()
    const api = agentTeamsApi()
    if (!teamId || !api) return
    void api
      .getGraph(teamId)
      .then((graph) => {
        if (!graph) {
          setCollaborationShape("all")
          setCollaborationCoordinator(undefined)
          setCollaborationLinks([])
          return
        }
        // Read after the await so refreshing the team list does not re-run this
        // effect and discard pairing the user is in the middle of editing.
        const coordinator = coordinatorInGraph(graph, openTeams().find((team) => team.id === teamId)?.memberIds ?? [])
        setCollaborationCoordinator(coordinator)
        setCollaborationShape(coordinator ? "coordinator" : "custom")
        // A mutual link is one stored row standing for both directions, so it
        // becomes two checked cells. Collapsing it to the single forward cell
        // would show the team as more restricted than it is, and saving from
        // the custom matrix — which only ever emits directed rows — would then
        // silently revoke the reply permission the user never unchecked.
        setCollaborationLinks(
          graph.links.flatMap((link) =>
            link.mutual === true
              ? [collaborationLinkKey(link.from, link.to), collaborationLinkKey(link.to, link.from)]
              : [collaborationLinkKey(link.from, link.to)],
          ),
        )
      })
      .catch(() => undefined)
  })

  const swarmApi = () =>
    (
      globalThis.window?.api as
        | (typeof globalThis.window.api & { swarmOrchestrator?: SwarmOrchestratorApi })
        | undefined
    )?.swarmOrchestrator

  const backgroundTasksApi = () =>
    (globalThis.window?.api as (typeof globalThis.window.api & { backgroundTasks?: BackgroundTasksApi }) | undefined)
      ?.backgroundTasks

  const PARALLEL_CONNECTION_MESSAGE =
    "Isolated agents activate once Vector connects to this workspace. Worktrees, agent sessions, validation, and merges run through that connection."

  const reportDesktopOnlyParallel = () => {
    setParallelError(PARALLEL_CONNECTION_MESSAGE)
    showToast(PARALLEL_CONNECTION_MESSAGE)
    return PARALLEL_CONNECTION_MESSAGE
  }

  // Main working-tree diff for the "Main" and "Side-by-side" review modes. Only
  // fetches when a non-agent mode is active; keyed on the open record + a manual
  // refresh tick. Read-only — mainDiff never mutates the project.
  const [mainWorkingTreeDiffResource] = createResource(
    () => {
      if (diffViewMode() === "agent") return undefined
      const record = selectedParallelWorkspace()
      if (!record) return undefined
      return { id: record.id, sourcePath: record.sourcePath, tick: mainDiffTick() }
    },
    async (key) => {
      const api = parallelApi()
      if (!api?.mainDiff) return ""
      return api.mainDiff(key.sourcePath).catch(() => "")
    },
  )

  const defaultCommitMessage = createMemo(() => {
    const record = selectedParallelWorkspace()
    if (!record) return ""
    const firstLine = (value?: string) =>
      value
        ?.split("\n")
        .map((line) => line.trim())
        .find(Boolean)
    const base = firstLine(record.finalSummary) || firstLine(record.taskPrompt) || record.name
    return `Vector: ${base}`.slice(0, 120)
  })
  const effectiveCommitMessage = () => (commitMessageTouched() ? commitMessage() : defaultCommitMessage())

  // Reset the review-local UI (diff mode + commit-message draft) whenever the
  // open agent changes, so a message typed for one agent never leaks into another.
  createEffect((previousID: string | undefined) => {
    const id = selectedParallelWorkspace()?.id
    if (id !== previousID) {
      setDiffViewMode("agent")
      setCommitMessage("")
      setCommitMessageTouched(false)
    }
    return id
  })

  // Shared diff area for both the fullscreen and modal review views: a mode
  // toggle plus the agent-tree (selective merge), read-only main, or side-by-side
  // rendering. Takes the record accessor so live diffs stay reactive.
  const renderDiffReview = (recordAccessor: () => ParallelWorkspaceRecord) => {
    const mainEmptyFallback = (
      <div class="rounded-2xl border border-[color:var(--vx-line)] bg-[#1d1d1f] px-5 py-8 text-center text-sm text-white/45">
        {mainWorkingTreeDiffResource.loading ? "Loading main working tree…" : "Main working tree is clean."}
      </div>
    )
    return (
      <div>
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <DiffModeToggle mode={diffViewMode()} onMode={setDiffViewMode} />
          <Show when={diffViewMode() !== "agent"}>
            <button
              type="button"
              class="rounded-[8px] border border-[color:var(--vx-line)] px-2.5 py-1 text-[11px] text-white/55 transition hover:bg-white/[0.05] hover:text-white/80"
              onClick={() => setMainDiffTick((tick) => tick + 1)}
            >
              Refresh main
            </button>
          </Show>
        </div>
        <Show when={diffViewMode() === "agent"}>
          <ParallelDiffReview
            diff={recordAccessor().diff}
            disabled={recordAccessor().mergeState !== "none"}
            onMergeSelection={(selection) => mergeParallelWorkspaceSelection(recordAccessor(), selection)}
          />
        </Show>
        <Show when={diffViewMode() === "main"}>
          <Show when={(mainWorkingTreeDiffResource() ?? "").trim()} fallback={mainEmptyFallback}>
            <ParallelDiffReview
              diff={mainWorkingTreeDiffResource() ?? ""}
              readOnly
              label="Main working tree"
              onMergeSelection={() => {}}
            />
          </Show>
        </Show>
        <Show when={diffViewMode() === "split"}>
          <div class="grid gap-3 lg:grid-cols-2">
            <ParallelDiffReview
              diff={recordAccessor().diff}
              readOnly
              label="Agent worktree"
              onMergeSelection={() => {}}
            />
            <Show when={(mainWorkingTreeDiffResource() ?? "").trim()} fallback={mainEmptyFallback}>
              <ParallelDiffReview
                diff={mainWorkingTreeDiffResource() ?? ""}
                readOnly
                label="Main working tree"
                onMergeSelection={() => {}}
              />
            </Show>
          </div>
        </Show>
      </div>
    )
  }

  const logParallelTimeline = (
    title: string,
    status: "pending" | "running" | "success" | "warning" | "failed",
    summary: string,
    files: string[] = [],
  ) => {
    globalThis.window?.dispatchEvent(
      new CustomEvent("vector:engineering-event", {
        detail: {
          type: status === "failed" ? "error" : "ai",
          status,
          title,
          summary,
          files,
          source: "Agent orchestration",
        },
      }),
    )
  }

  const loadBackgroundTasks = async (scope = activeTaskScope()) => {
    const api = backgroundTasksApi()
    if (!api) return
    const projectPath = scope.projectPath || (await resolveActiveProjectPath())
    const records = await api
      .list({ projectPath: projectPath || undefined, taskId: scope.taskId })
      .catch(() => [] as BackgroundTaskRecord[])
    if (taskScopeId(activeTaskScope()) !== taskScopeId({ ...scope, projectPath })) return
    setBackgroundTaskRecords(records)
  }

  const loadSwarmRuns = async (scope = activeWorkspaceScope()) => {
    const api = swarmApi()
    if (!api) return [] as SwarmRunRecord[]
    const records = await api.list(scope).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return [] as SwarmRunRecord[]
    })
    const current = activeWorkspaceScope()
    if (current.sourcePath !== scope.sourcePath || current.parentSessionId !== scope.parentSessionId) {
      return [] as SwarmRunRecord[]
    }
    setSwarmRuns(records)
    const routeID = swarmRunIDFromRoute()
    if (routeID && records.some((run) => run.id === routeID)) {
      setSwarmSelectedID(routeID)
      setParallelSelectedID(undefined)
      return records
    }
    if (swarmSelectedID() && !records.some((run) => run.id === swarmSelectedID())) setSwarmSelectedID(undefined)
    if (!parallelSelectedID() && !swarmSelectedID() && !parallelRecords().length) setSwarmSelectedID(records[0]?.id)
    return records
  }

  // Feed the Model Economics Engine with verified outcomes: any terminal
  // workspace record that ran validation becomes a ModelOutcome. recordOutcome
  // dedups on the record id, so re-running over the full list is idempotent.
  const TERMINAL_WORKSPACE_STATUSES: ParallelWorkspaceStatus[] = [
    "complete",
    "failed",
    "needs review",
    "stopped",
    "merged",
    "discarded",
  ]
  // Callers re-run over the full workspace list every poll, so remember which
  // records were already measured. Without this the engine would refetch every
  // finished agent's whole message history every 1.5 seconds.
  const measuredEconomicsIds = new Set<string>()

  // Real spend comes from the provider's own reported usage on the agent
  // session's assistant messages. A workspace with no reachable session simply
  // records no usage rather than a fabricated zero.
  const measureWorkspaceUsage = async (record: ParallelWorkspaceRecord) => {
    if (!record.agentSessionId) return undefined
    const history = await serverSDK()
      .createClient({ directory: record.isolatedPath })
      .session.messages({ sessionID: record.agentSessionId })
      .catch(() => undefined)
    if (!Array.isArray(history?.data)) return undefined
    return measureUsage(history.data.map((entry) => entry.info))
  }

  const recordEconomicsOutcomes = (records: ParallelWorkspaceRecord[]) => {
    for (const record of records) {
      if (!record.validationReport && record.validationPassed === undefined) continue
      if (!TERMINAL_WORKSPACE_STATUSES.includes(record.status)) continue
      if (measuredEconomicsIds.has(record.id)) continue
      measuredEconomicsIds.add(record.id)
      void measureWorkspaceUsage(record).then((measured) =>
        recordOutcome(outcomesFromWorkspaceRecord(record, categorizeTask(record.taskPrompt), measured)),
      )
    }
  }

  const loadParallelWorkspaces = async (scope = activeWorkspaceScope()) => {
    const api = parallelApi()
    if (!api) {
      setParallelError(PARALLEL_CONNECTION_MESSAGE)
      return
    }
    setParallelError("")
    const records = await api.list(scope).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return [] as ParallelWorkspaceRecord[]
    })
    const runs = await loadSwarmRuns(scope)
    const workerIDs = [
      ...new Set(
        runs.flatMap((run) => run.tasks.map((task) => task.workspaceId).filter((id): id is string => Boolean(id))),
      ),
    ]
    const workers = await Promise.all(
      workerIDs
        .filter((id) => !records.some((record) => record.id === id))
        .map((id) => api.refresh(id).catch(() => undefined)),
    )
    const allRecords = [
      ...records,
      ...workers.filter((record): record is ParallelWorkspaceRecord => Boolean(record)),
    ].filter((record) => parallelRecordMatchesScope(record, scope))
    const current = activeWorkspaceScope()
    if (current.sourcePath !== scope.sourcePath || current.parentSessionId !== scope.parentSessionId) return
    setParallelRecords(allRecords)
    for (const record of allRecords) server.projects.close(record.isolatedPath)
    if (isInternalProjectPath(lastProjectPath()) && scope.sourcePath) rememberProjectPath(scope.sourcePath)
    recordEconomicsOutcomes(allRecords)
    reconcileAgentTabOrder(allRecords)
    if (!swarmSelectedID() && !allRecords.some((record) => record.id === parallelSelectedID())) {
      setParallelSelectedID(allRecords[0]?.id)
    }
    void loadBackgroundTasks({ projectPath: scope.sourcePath, taskId: scope.parentSessionId })
  }

  let loadedEngineeringScope = ""
  createEffect(() => {
    const scope = activeWorkspaceScope()
    const key = taskScopeId({ projectPath: scope.sourcePath, taskId: scope.parentSessionId })
    if (key === loadedEngineeringScope) return
    loadedEngineeringScope = key
    setParallelRecords([])
    setParallelSelectedID(undefined)
    setSwarmRuns([])
    setSwarmSelectedID(undefined)
    setBackgroundTaskRecords([])
    setPendingAgentOpenID(undefined)
    setAgentReviewOpen(false)
    setOrchestrationOpen(false)
    void loadParallelWorkspaces(scope)
  })

  const openParallelWorkspaces = () => {
    const target = fullscreenReturnPath()
    if (!taskRoute() && !/\/session\/[^/?#]+/.test(target)) {
      showToast({
        title: "Open a project first",
        description: "Agent workspaces belong to the project you are working on.",
      })
      return
    }
    setToolsOpen(false)
    setSidePanelOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    setParallelLaunchMode("agent")
    setParallelCompareRuntimes(false)
    setParallelComposerOpen(true)
    setOrchestrationOpen(false)
    setAgentReviewOpen(false)
    const scope = activeWorkspaceScope()
    if (!taskRoute() && /\/session\/[^/?#]+/.test(target)) navigate(target)
    void loadParallelWorkspaces(scope)
  }

  const refreshParallelWorkspace = async (id: string) => {
    const api = parallelApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const scope = activeWorkspaceScope()
    const record = await api.refresh(id).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return undefined
    })
    if (!record || !parallelRecordMatchesScope(record, scope)) return
    const current = activeWorkspaceScope()
    if (
      taskScopeId({ projectPath: current.sourcePath, taskId: current.parentSessionId }) !==
      taskScopeId({ projectPath: scope.sourcePath, taskId: scope.parentSessionId })
    )
      return
    setParallelRecords((records) => records.map((item) => (item.id === id ? record : item)))
    recordEconomicsOutcomes([record])
  }

  // Only live work occupies launch slots: running/queued agents and results
  // that still need review. Merged, discarded, failed, stopped, and
  // no-change records are history and can be removed from the list.
  const availableWorkspaceSlots = () => {
    const existingWorkspaceCount = parallelRecords().filter(
      (record) =>
        record.swarmRole !== "coordinator" &&
        record.mergeState === "none" &&
        !["failed", "stopped", "complete"].includes(record.status),
    ).length
    return Math.max(0, 16 - existingWorkspaceCount)
  }

  const createParallelWorkspace = async () => {
    const api = parallelApi()
    const scope = await resolveTaskWorkspace()
    const sourcePath = scope.sourcePath
    const taskPrompt = parallelPrompt().trim()
    const availableSlots = availableWorkspaceSlots()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    if (!scope.parentSessionId) {
      setParallelError(
        "Open a task session before launching an isolated agent. Agent workspaces belong only to that task.",
      )
      return
    }
    if (!sourcePath) {
      setParallelError("No active project path is loaded. Open a project first, then launch an isolated agent.")
      return
    }
    if (availableSlots === 0) {
      setParallelError(
        "Vector can run up to 16 active isolated agents. Merge, discard, or remove a finished workspace before launching another.",
      )
      return
    }
    if (!taskPrompt) {
      setParallelError("Describe the project work this isolated agent should handle.")
      return
    }
    const runtimes = parallelCompareRuntimes() ? readyComparisonRuntimes() : [parallelRuntime()]
    if (parallelCompareRuntimes() && runtimes.length < 2) {
      setParallelError("Connect Vector or install at least two coding-agent runtimes before starting a comparison.")
      return
    }
    if (runtimes.length > availableSlots) {
      setParallelError(`This comparison needs ${runtimes.length} agent slots, but only ${availableSlots} remain.`)
      return
    }
    if (runtimes.includes("vector") && parallelModelOptions().length === 0) {
      setParallelError("Connect an AI provider first — parallel agents run on your own keys.")
      openProviderSettings()
      return
    }
    const missingRuntime = runtimes.find(
      (runtime) => runtime !== "vector" && !externalRuntimeStatus(runtime)?.installed,
    )
    if (missingRuntime) {
      setParallelError(
        `${parallelRuntimeLabel(missingRuntime)} is not installed or signed in on this computer. Vector only launches real, detected runtimes.`,
      )
      return
    }
    setParallelBusy(true)
    setParallelError("")

    // Snapshot the roster the user drew the graph over before any await. The
    // pending ids are positional against `runtimes`, and `collaborationRoster`
    // recomputes from `readyComparisonRuntimes()` — so a runtime-detection poll
    // landing mid-launch would renumber the placeholders and pair the wrong
    // agents. Reading it once, here, keeps the two lists in lockstep.
    const drawnRosterIds = collaborationRoster().map((member) => member.id)

    // A "work together" launch either joins the team the user picked or creates
    // a new one. The team exists before any member so every member can be
    // attached to it as it is created. "shared-main" points the shared checkout
    // at the project itself, which is what makes agents edit main directly.
    const teamsApi = agentTeamsApi()
    const team = await (async () => {
      if (parallelTopology() === "isolated" || !teamsApi) return undefined
      const existing = openTeams().find((item) => item.id === parallelJoinTeamId())
      if (existing) return existing
      return teamsApi
        .create({
          name: parallelName().trim() || "Agent team",
          topology: parallelTopology(),
          sourcePath,
          parentSessionId: scope.parentSessionId,
          sharedPath: parallelTopology() === "shared-main" ? sourcePath : undefined,
        })
        .catch(() => undefined)
    })()

    const records = await runtimes.reduce(async (pending, runtime) => {
      const current = await pending
      if (!current) return undefined
      const record = await api
        .create({
          sourcePath,
          parentSessionId: scope.parentSessionId,
          name: parallelCompareRuntimes()
            ? `${parallelName().trim() || "Comparison"} · ${parallelRuntimeLabel(runtime)}`
            : parallelName(),
          taskPrompt,
          runtime,
          provider: runtime === "vector" ? parallelProvider() : undefined,
          model: runtime === "vector" ? parallelModel() : undefined,
          teamId: team?.id,
          // The verified-completion setting is global, so an isolated agent runs
          // under the same policy as a prompt typed into the composer.
          llmJudge: settings.general.llmJudge(),
          // The first member provisions the tree; everyone after it joins that
          // same checkout, which is what lets teammates see each other's edits.
          sharedPath: team ? (team.sharedPath ?? current[0]?.isolatedPath) : undefined,
        })
        .catch((error: unknown) => {
          setParallelError(error instanceof Error ? error.message : String(error))
          return undefined
        })
      if (record && team && teamsApi) await teamsApi.addMember(team.id, record.id).catch(() => undefined)
      return record ? [...current, record] : undefined
    }, Promise.resolve<ParallelWorkspaceRecord[] | undefined>([]))

    // Pairing is stored only after every member exists, because the composer
    // draws it over agents that had no workspace id yet. "Everyone" is the
    // absence of a graph, so it is written only to clear one a joined team
    // already had — a brand-new team keeps storing nothing at all.
    if (records?.length && team && teamsApi) {
      // Placeholder ids are positional: the Nth pending roster entry is the Nth
      // record this launch created, in the same runtime order.
      const memberIds = [...new Set([...team.memberIds, ...records.map((record) => record.id)])]
      const drawn = collaborationGraphFor(drawnRosterIds)
      const graph = drawn && {
        links: drawn.links.flatMap((link) => {
          const from = link.from.startsWith(PENDING_MEMBER_PREFIX)
            ? records[Number(link.from.slice(PENDING_MEMBER_PREFIX.length))]?.id
            : link.from
          const to = link.to.startsWith(PENDING_MEMBER_PREFIX)
            ? records[Number(link.to.slice(PENDING_MEMBER_PREFIX.length))]?.id
            : link.to
          if (!from || !to || !memberIds.includes(from) || !memberIds.includes(to)) return []
          return [{ from, to, mutual: link.mutual }]
        }),
      }
      if (graph || parallelJoinTeamId()) await teamsApi.setGraph(team.id, graph).catch(() => undefined)
    }

    setParallelBusy(false)
    if (!records?.length) return
    setParallelRecords((current) => {
      const ids = new Set(records.map((record) => record.id))
      const next = [...records, ...current.filter((item) => !ids.has(item.id))]
      reconcileAgentTabOrder(next)
      return next
    })
    setParallelSelectedID(records[0]!.id)
    if (records.length === 1 && records[0]!.runtime === "vector") setPendingAgentOpenID(records[0]!.id)
    if (records.length === 1 && records[0]!.runtime !== "vector") setAgentReviewOpen(true)
    setParallelDetailTab("session")
    setParallelName("")
    setParallelPrompt("")
    setParallelComposerOpen(false)
    logParallelTimeline(
      records.length > 1 ? "Cross-runtime comparison created" : "Isolated agent created",
      "success",
      records.length > 1
        ? `${records.length} isolated runtimes are working on the same mission.`
        : `${records[0]!.name} created at ${records[0]!.isolatedPath}`,
    )
    await Promise.all(records.map((record) => runParallelWorkspace(record.id)))
    void loadBackgroundTasks()
  }

  const createSwarm = async () => {
    const api = swarmApi()
    const scope = await resolveTaskWorkspace()
    const sourcePath = scope.sourcePath
    const objective = parallelPrompt().trim()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    if (!scope.parentSessionId) {
      setParallelError("Open a task session before launching a swarm. Every agent run must belong to one task.")
      return
    }
    if (!sourcePath) {
      setParallelError("No active project path is loaded. Open a project before launching a swarm.")
      return
    }
    if (!objective) {
      setParallelError(
        "Describe one outcome. Vector will decompose the work, assign dependencies, and coordinate the agents.",
      )
      return
    }
    if (!parallelProvider() || !parallelModel() || parallelModelOptions().length === 0) {
      setParallelError("Connect an AI provider first — the swarm routes work across your connected models.")
      openProviderSettings()
      return
    }
    setParallelBusy(true)
    setParallelError("")
    const run = await api
      .create({
        sourcePath,
        parentSessionId: scope.parentSessionId,
        name: parallelName(),
        objective,
        primaryProvider: parallelProvider(),
        primaryModel: parallelModel(),
        modelPool: parallelModelOptions().map((option) => ({
          provider: option.providerID,
          model: option.modelID,
          label: `${option.providerName} ${option.modelName}`,
        })),
        strategy: swarmStrategy(),
        maxAgents: swarmMaxAgents(),
        maxConcurrency: swarmConcurrency(),
      })
      .catch((error: unknown) => {
        setParallelError(error instanceof Error ? error.message : String(error))
        return undefined
      })
    setParallelBusy(false)
    if (!run) return
    setSwarmRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
    setSwarmSelectedID(run.id)
    setParallelSelectedID(undefined)
    setParallelName("")
    setParallelPrompt("")
    setParallelComposerOpen(false)
    setOrchestrationOpen(true)
    logParallelTimeline(
      "Multi-agent run launched",
      "running",
      `${run.name} is decomposing the objective and assigning models.`,
    )
  }

  const submitParallelLaunch = () => (parallelLaunchMode() === "swarm" ? createSwarm() : createParallelWorkspace())

  const openParallelWorkspace = async (record: ParallelWorkspaceRecord) => {
    setToolsOpen(false)
    setSidePanelOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    setParallelComposerOpen(false)
    setParallelSelectedID(record.id)
    setSwarmSelectedID(undefined)
    setParallelDetailTab("session")
    setAgentReviewOpen(false)
    setOrchestrationOpen(false)
    if (record.mergeState !== "none" || ["merged", "discarded"].includes(record.status)) {
      showToast({
        title: "Agent workspace is closed",
        description: "Its changes were already merged or discarded, so the isolated folder is no longer available.",
      })
      await openMainAgent()
      return
    }
    if (record.runtime !== "vector") {
      setAgentReviewOpen(true)
      void refreshParallelWorkspace(record.id)
      return
    }
    const href = parallelWorkspaceSessionHref(record)
    if (href) {
      const api = globalThis.window?.api as
        | (typeof globalThis.window.api & {
            pathExists?: (path: string) => Promise<boolean>
          })
        | undefined
      if (api?.pathExists && !(await api.pathExists(record.isolatedPath).catch(() => false))) {
        setParallelRecords((records) => records.filter((item) => item.id !== record.id))
        reconcileAgentTabOrder(parallelRecords().filter((item) => item.id !== record.id))
        showToast({
          title: "Agent workspace is unavailable",
          description: "Vector removed this stale workspace because its isolated folder no longer exists.",
        })
        await openMainAgent()
        return
      }
      server.projects.close(record.isolatedPath)
      const resolved = await serverSync()
        .session.lineage.resolve(record.agentSessionId!)
        .catch(() => undefined)
      if (!resolved) {
        showToast({
          title: "Agent session is reconnecting",
          description: "The isolated folder is safe. Wait a moment, then open the workspace again.",
        })
        void refreshParallelWorkspace(record.id)
        return
      }
      navigate(href)
      return
    }
    setPendingAgentOpenID(record.id)
    showToast({
      title: "Agent is starting",
      description: "Vector will open its workspace as soon as the isolated session is ready.",
    })
    void refreshParallelWorkspace(record.id)
  }

  const openSwarmRun = (run: SwarmRunRecord) => {
    setToolsOpen(false)
    setSidePanelOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    setParallelComposerOpen(false)
    setParallelSelectedID(undefined)
    setSwarmSelectedID(run.id)
    setAgentReviewOpen(false)
    setOrchestrationOpen(true)
  }

  const openMainAgent = async () => {
    const sessionID = mainTaskSessionID()
    if (!sessionID) {
      showToast({
        title: "Main agent unavailable",
        description: "Open the original project session before switching agents.",
      })
      return
    }
    setAgentReviewOpen(false)
    setOrchestrationOpen(false)
    const resolved = await serverSync()
      .session.lineage.resolve(sessionID)
      .catch(() => undefined)
    const projectPath = resolved?.root.directory || routeContextProjectPath() || (await resolveActiveProjectPath())
    if (projectPath) {
      server.projects.open(projectPath)
      server.projects.touch(projectPath)
      rememberProjectPath(projectPath)
    }
    const search = taskScopeSearch({ projectPath, taskId: resolved?.root.id ?? sessionID })
    navigate(`${sessionHref(server.key, sessionID)}${search}`)
  }

  const openAgentByID = (id: string) => {
    const record = parallelRecords().find((item) => item.id === id)
    if (!record) return
    void openParallelWorkspace(record)
  }

  const openAgentReviewByID = (id: string) => {
    const record = parallelRecords().find((item) => item.id === id)
    if (!record) return
    setParallelSelectedID(record.id)
    setSwarmSelectedID(undefined)
    setParallelComposerOpen(false)
    setOrchestrationOpen(false)
    setAgentReviewOpen(true)
    void refreshParallelWorkspace(record.id)
  }

  const openOrchestration = () => {
    setParallelComposerOpen(false)
    setAgentReviewOpen(false)
    setOrchestrationOpen(true)
    const current = swarmRuns().find((run) => isSwarmRunning(run) || run.status === "needs review") ?? swarmRuns()[0]
    setSwarmSelectedID(current?.id)
  }

  const runParallelWorkspace = async (id: string) => {
    const api = parallelApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const record = await api.run(id, 16).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return undefined
    })
    if (!record) return
    setParallelRecords((records) => records.map((item) => (item.id === id ? record : item)))
    logParallelTimeline("Isolated agent prepared", "running", record.lastAction, record.changedFiles)
    void loadBackgroundTasks()
  }

  // Destructive/expensive controls confirm inline: the first click arms the
  // button for a few seconds, the second click executes. This replaces the
  // native window.confirm dialogs that clashed with the app's design language.
  const [armedAction, setArmedAction] = createSignal("")
  let armedActionTimer: ReturnType<typeof setTimeout> | undefined
  const confirmTwice = (key: string, action: () => void) => {
    if (armedAction() === key) {
      if (armedActionTimer) clearTimeout(armedActionTimer)
      setArmedAction("")
      action()
      return
    }
    setArmedAction(key)
    if (armedActionTimer) clearTimeout(armedActionTimer)
    armedActionTimer = setTimeout(() => setArmedAction(""), 3500)
  }

  const workspaceNavigationItems = createMemo<WorkspaceNavigationItem[]>(() =>
    agentTabRecords().map((record) => {
      const status = liveAgentStatus(record)
      const stats = parallelDiffStats(record)
      return {
        id: record.id,
        name: record.name,
        status,
        // The row's secondary line is the only place a workspace shows what it
        // is and how much it has touched, so the changed-file count and the
        // shared-workspace marker ride along with the runtime label until
        // WorkspaceNavigationItem grows fields of its own.
        runtime: [
          parallelRuntimeLabel(record.runtime),
          record.changedFilesCount ? `${record.changedFilesCount} files` : "",
          record.teamId ? "shared" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        added: stats.added,
        removed: stats.removed,
        active: sidebarActiveAgentID() === record.id,
        running: isParallelWorkspaceRunning(record),
        reviewable: record.changedFilesCount > 0 || ["needs review", "complete"].includes(record.status),
        removable:
          !isParallelWorkspaceRunning(record) &&
          !(
            record.mergeState === "none" &&
            ["needs review", "complete"].includes(record.status) &&
            record.changedFilesCount > 0
          ),
        removeArmed: armedAction() === `remove-${record.id}`,
      }
    }),
  )

  const stopParallelWorkspace = async (id: string) => {
    const api = parallelApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const record = await api.stop(id).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return undefined
    })
    if (!record) return
    setParallelRecords((records) => records.map((item) => (item.id === id ? record : item)))
    logParallelTimeline("Agent stopped", "warning", record.lastAction)
    void loadBackgroundTasks()
  }

  const openWorkspacePullRequest = async (record: ParallelWorkspaceRecord) => {
    const api = parallelApi()
    if (!api?.pullRequest) {
      showToast({
        variant: "error",
        title: "GitHub unavailable",
        description: "Update Vector before opening a workspace pull request.",
      })
      return
    }
    setParallelBusy(true)
    const updated = await api.pullRequest(record.id).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setParallelError(message)
      showToast({ variant: "error", title: "Pull request blocked", description: message })
      void refreshParallelWorkspace(record.id)
      return undefined
    })
    setParallelBusy(false)
    if (!updated) return
    setParallelRecords((records) => records.map((item) => (item.id === updated.id ? updated : item)))
    showToast({
      title: "Pull request ready",
      description: updated.pullRequestUrl || "The workspace branch is ready on GitHub.",
    })
    logParallelTimeline(
      "Workspace pull request opened",
      "success",
      updated.pullRequestUrl || updated.lastAction,
      updated.changedFiles,
    )
  }

  const mergeParallelWorkspace = async (
    record: ParallelWorkspaceRecord,
    force = false,
    commit?: { message: string },
  ) => {
    const api = parallelApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const committing = Boolean(commit?.message?.trim())
    setParallelBusy(true)
    showToast({
      title: committing ? "Committing workspace" : "Merging workspace",
      description: "Vector is validating the isolated changes before updating main.",
    })
    const current = await api.refresh(record.id).catch(() => record)
    if (!current.changedFilesCount) {
      setParallelBusy(false)
      const message = "There are no isolated changes to merge."
      setParallelError(message)
      showToast({ title: "Nothing to merge", description: message })
      return
    }
    const merged = await api.merge(current.id, force, commit).catch((error: unknown) => {
      const message = error instanceof Error && error.message ? error.message : String(error)
      setParallelError(message)
      showToast({ variant: "error", title: committing ? "Commit blocked" : "Merge blocked", description: message })
      void refreshParallelWorkspace(current.id)
      return undefined
    })
    setParallelBusy(false)
    if (!merged) return
    setParallelRecords((records) => records.map((item) => (item.id === merged.id ? merged : item)))
    if (merged.status !== "merged") {
      showToast({
        variant: "error",
        title: committing ? "Commit blocked" : "Merge blocked",
        description: merged.error || merged.finalSummary || "Vector could not merge this isolated workspace.",
      })
    } else if (committing) {
      showToast({
        variant: merged.error ? "error" : "default",
        title: merged.error ? "Merged, commit failed" : "Committed to main",
        description: merged.error || merged.finalSummary || merged.lastAction,
      })
    }
    logParallelTimeline(
      merged.status === "merged"
        ? committing
          ? merged.error
            ? "Agent changes merged; commit failed"
            : "Agent changes committed to main"
          : "Agent changes merged"
        : "Agent merge blocked",
      merged.status === "merged" && !merged.error ? "success" : merged.status === "merged" ? "warning" : "failed",
      merged.error || merged.finalSummary || merged.lastAction,
      merged.changedFiles,
    )
    void loadBackgroundTasks()
  }

  const mergeParallelWorkspaceSelection = async (
    record: ParallelWorkspaceRecord,
    selection: { hunkIds: string[]; files: string[] },
  ) => {
    const api = parallelApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const count = selection.hunkIds.length + selection.files.length
    if (!count) return
    const merged = await api.mergeSelection(record.id, selection).catch((error: unknown) => {
      const message = error instanceof Error && error.message ? error.message : String(error)
      setParallelError(message)
      showToast({ variant: "error", title: "Selective merge blocked", description: message })
      void refreshParallelWorkspace(record.id)
      return undefined
    })
    if (!merged) return
    setParallelRecords((records) => records.map((item) => (item.id === merged.id ? merged : item)))
    if (merged.error) {
      showToast({ variant: "error", title: "Selective merge blocked", description: merged.error })
      return
    }
    showToast({
      title: merged.status === "merged" ? "Review merged" : "Approved changes merged",
      description: merged.finalSummary || merged.lastAction,
    })
    logParallelTimeline(
      "Selective review merged",
      "success",
      merged.finalSummary || merged.lastAction,
      merged.changedFiles,
    )
    void loadBackgroundTasks()
  }

  const discardParallelWorkspace = async (record: ParallelWorkspaceRecord) => {
    const api = parallelApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const discarded = await api.discard(record.id).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return undefined
    })
    if (!discarded) return
    setParallelRecords((records) => records.map((item) => (item.id === discarded.id ? discarded : item)))
    logParallelTimeline("Agent workspace discarded", "warning", discarded.lastAction)
    void loadBackgroundTasks()
  }

  const removeParallelWorkspace = async (record: ParallelWorkspaceRecord) => {
    const api = parallelApi()
    if (!api?.remove) {
      reportDesktopOnlyParallel()
      return
    }
    const removed = await api.remove(record.id).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setParallelError(message)
      showToast({ variant: "error", title: "Cannot remove workspace", description: message })
      return undefined
    })
    if (!removed) return
    if (parallelSelectedID() === record.id) setParallelSelectedID(undefined)
    await loadParallelWorkspaces()
    void loadBackgroundTasks()
  }

  const replaceSwarmRun = (run: SwarmRunRecord) => {
    setSwarmRuns((records) => records.map((item) => (item.id === run.id ? run : item)))
  }

  const stopSwarm = async (id: string) => {
    const api = swarmApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const run = await api.stop(id).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return undefined
    })
    if (!run) return
    replaceSwarmRun(run)
    logParallelTimeline("Agent swarm stopped", "warning", run.currentStep)
  }

  const resumeSwarm = async (id: string) => {
    const api = swarmApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const run = await api.resume(id).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return undefined
    })
    if (!run) return
    replaceSwarmRun(run)
    logParallelTimeline("Agent swarm resumed", "running", run.currentStep)
  }

  const mergeSwarm = async (id: string) => {
    const api = swarmApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const run = await api.merge(id).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setParallelError(message)
      showToast({ variant: "error", title: "Swarm merge blocked", description: message })
      return undefined
    })
    if (!run) return
    replaceSwarmRun(run)
    showToast({
      variant: run.status === "merged" ? undefined : "error",
      title: run.status === "merged" ? "Swarm merged" : "Swarm merge blocked",
      description: run.error || run.summary,
    })
    logParallelTimeline(
      run.status === "merged" ? "Agent swarm merged" : "Agent swarm merge blocked",
      run.status === "merged" ? "success" : "failed",
      run.error || run.summary,
      run.changedFiles,
    )
  }

  const mergeSwarmSelection = async (id: string, selection: { hunkIds: string[]; files: string[] }) => {
    const api = swarmApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const run = await api.mergeSelection(id, selection).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setParallelError(message)
      showToast({ variant: "error", title: "Selective merge blocked", description: message })
      return undefined
    })
    if (!run) return
    replaceSwarmRun(run)
    showToast({
      title: run.status === "merged" ? "Swarm merged" : "Approved changes merged",
      description: run.currentStep,
    })
  }

  const discardSwarm = async (id: string) => {
    const api = swarmApi()
    if (!api) {
      reportDesktopOnlyParallel()
      return
    }
    const run = await api.discard(id).catch((error: unknown) => {
      setParallelError(error instanceof Error ? error.message : String(error))
      return undefined
    })
    if (!run) return
    replaceSwarmRun(run)
    logParallelTimeline("Agent swarm discarded", "warning", run.currentStep)
  }

  const openTerminalPanel = () => {
    if (!requireTaskRoute("Terminal")) return
    if (!sessionCommandRegistered("terminal.toggle")) {
      showToast({ title: "Terminal is not ready", description: "Open a project first, then try Terminal again." })
      return
    }
    setSidePanelOpen(false)
    setToolsOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    command.trigger("terminal.toggle")
  }

  const startTask = () => {
    if (!sessionCommandRegistered("tab.new")) {
      showToast({
        title: "Open a project first",
        description: "Start becomes available after Vector has a project workspace.",
      })
      return
    }
    setSidePanelOpen(false)
    setToolsOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    command.trigger("tab.new")
  }

  const openCodespace = () => {
    if (!requireSidePanelRoute("Code editor")) return
    setSidePanelOpen(false)
    setToolsOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    command.trigger("vector.codespace.open")
  }

  const openPreviewPanel = () => {
    if (!requireSidePanelRoute("Browser")) return
    setSidePanelOpen(false)
    setToolsOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    command.trigger("vector.preview.open")
  }

  const openReviewChanges = () => {
    if (!requireSidePanelRoute("Review changes")) return
    setSidePanelOpen(false)
    setToolsOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    command.trigger("review.open")
  }

  const openMcpDialog = async () => {
    const directory = await resolveActiveProjectPath()
    if (!directory) {
      showToast({
        title: "Open a project first",
        description: "MCP servers are scoped to a project so their tools cannot access unrelated files.",
      })
      return
    }
    setSidePanelOpen(false)
    setToolsOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    // NewLayout is server-scoped but intentionally not directory-scoped. MCP
    // status and configuration are directory-owned, so mount the dialog in the
    // same SDK context used by a real project session.
    dialog.show(() => (
      <SDKProvider directory={directory}>
        <DialogSelectMcp />
      </SDKProvider>
    ))
  }

  const openPluginsDialog = async () => {
    const directory = await resolveActiveProjectPath()
    if (!directory) {
      showToast({
        title: "Open a project first",
        description: "Plugins install as project-scoped MCP servers so their tools cannot access unrelated files.",
      })
      return
    }
    setSidePanelOpen(false)
    setToolsOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    // Same directory-scoped SDK context as MCP: plugin installs are MCP
    // config writes owned by the active project.
    dialog.show(() => (
      <SDKProvider directory={directory}>
        <DialogSelectPlugins />
      </SDKProvider>
    ))
  }

  // Ordinary sessions feed the economics engine too. Learning only from
  // validated parallel runs left it with too few samples to ever recommend
  // anything, which is why the feature looked dead.
  const recordedSessionOutcomes = new Set<string>()
  const stopSessionOutcomes = serverSDK().event.listen((event) => {
    if (event.details.type !== "session.idle") return
    const sessionID = (event.details as { id?: string }).id
    const directory = (event as { name?: string }).name
    if (!sessionID || !directory) return
    const outcomeRecorded = recordedSessionOutcomes.has(sessionID)
    if (outcomeRecorded && readOnboardingFlags().taskCompleted) return
    if (!outcomeRecorded) recordedSessionOutcomes.add(sessionID)
    void (async () => {
      const client = serverSDK().createClient({ directory })
      const history = await client.session.messages({ sessionID }).catch(() => undefined)
      if (!Array.isArray(history?.data)) {
        if (!outcomeRecorded) recordedSessionOutcomes.delete(sessionID)
        return
      }
      if (successfulActivationFromSession(history.data)) {
        setOnboardingFlag("providerVerified")
        setOnboardingFlag("taskCompleted")
      }
      if (outcomeRecorded) return
      const parts: Record<string, unknown[]> = {}
      for (const entry of history.data) {
        const id = (entry.info as { id?: string } | undefined)?.id
        if (id) parts[id] = (entry as { parts?: unknown[] }).parts ?? []
      }
      const outcome = outcomeFromSession({
        sessionID,
        projectId: directory,
        messages: history.data as never,
        parts: parts as never,
      })
      if (outcome) await recordOutcome(outcome)
    })()
  })
  onCleanup(stopSessionOutcomes)

  const taskRoute = () => /\/session\/[^/?#]+/.test(location.pathname)
  const taskDraftRoute = () => location.pathname === "/new-session" && Boolean(activeDraftID())
  const taskConversationRoute = () => taskRoute() || taskDraftRoute()
  const activeVelScopeKey = () => {
    const sessionID = activeTaskScope().taskId
    if (sessionID) return `session:${sessionID}`
    const draftID = activeDraftID()
    return draftID ? `draft:${draftID}` : ""
  }
  const openVelCall = () => {
    const scope = activeVelScopeKey()
    if (!taskConversationRoute() || !scope) {
      showToast({
        title: "Open a session first",
        description: "Vel is available inside the chat for the selected Vector session.",
      })
      return
    }
    setVelScopeKey(scope)
    setVelOpen(true)
  }
  const handleVelOpen = () => openVelCall()
  globalThis.window?.addEventListener(VEL_OPEN_EVENT, handleVelOpen)
  onCleanup(() => globalThis.window?.removeEventListener(VEL_OPEN_EVENT, handleVelOpen))
  const macDesktop = () => platform.platform === "desktop" && platform.os === "macos"

  // Landing-page-style ambient light: a soft purple halo trails the pointer.
  createEffect(() => {
    const media = globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)")
    if (media?.matches) return
    let frame = 0
    const move = (event: PointerEvent) => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const root = document.querySelector("[data-vector-shell]") as HTMLElement | null
        root?.style.setProperty("--vector-pointer-x", `${event.clientX}px`)
        root?.style.setProperty("--vector-pointer-y", `${event.clientY}px`)
      })
    }
    globalThis.window?.addEventListener("pointermove", move, { passive: true })
    onCleanup(() => {
      if (frame) cancelAnimationFrame(frame)
      globalThis.window?.removeEventListener("pointermove", move)
    })
  })

  const sessionCommandRegistered = (id: string) => command.options.some((option) => option.id === id)

  const sidePanelAvailable = () =>
    typeof globalThis.window === "undefined" || globalThis.window.matchMedia("(min-width: 768px)").matches

  const requireTaskRoute = (feature: string) => {
    if (taskRoute()) return true
    showToast({
      title: "Open a project first",
      description: `${feature} is available inside an active Vector project.`,
    })
    return false
  }

  // Every surface except Overview is about a specific project, so the rest of
  // the sidebar unlocks only once you've actually opened a task or feature —
  // i.e. you're anywhere but the bare Overview. Keeps the first-run shell
  // minimal: one clear next step (New task / Open project) instead of a wall of
  // controls that all toast "open a task first". A persisted last-project does
  // NOT count — you have to open something in this view.
  const navUnlocked = () =>
    !["/", "/code", "/work", "/cloud"].includes(location.pathname) ||
    toolsOpen() ||
    parallelOpen() ||
    browserAgentOpen() ||
    sidePanelOpen()

  const requireSidePanelRoute = (feature: string) => {
    if (!requireTaskRoute(feature)) return false
    if (sidePanelAvailable()) return true
    showToast({
      title: "Make the window wider",
      description: `${feature} opens in Vector's side panel, which needs at least 768px of width.`,
    })
    return false
  }

  // ---- First-run onboarding ------------------------------------------------
  const [onboardingOpen, setOnboardingOpen] = createSignal(false)
  const [onboardingFlags, setOnboardingFlags] = createSignal(readOnboardingFlags())
  const refreshOnboardingFlags = () => setOnboardingFlags(readOnboardingFlags())
  globalThis.window?.addEventListener(ONBOARDING_UPDATED_EVENT, refreshOnboardingFlags)
  onCleanup(() => globalThis.window?.removeEventListener(ONBOARDING_UPDATED_EVENT, refreshOnboardingFlags))

  const onboardingProviderDone = () => Boolean(onboardingFlags().providerVerified)
  const onboardingProjectDone = () => Boolean(activeProjectPath())
  const onboardingSteps = () => [
    {
      id: "provider",
      title: "Verify a model provider",
      detail: onboardingProviderDone()
        ? "Vector completed a real model response with your selected provider."
        : parallelModelOptions().length > 0
          ? "Connected. Complete the safe first task below to verify the model end to end."
          : "Bring your own key — OpenAI, Anthropic, Google, or the free starter model.",
      done: onboardingProviderDone(),
      cta: "Connect",
      onGo: () => {
        setOnboardingOpen(false)
        openProviderSettings()
      },
    },
    {
      id: "project",
      title: "Create or open a project",
      detail: "Choose the codebase Vector should work inside.",
      done: onboardingProjectDone(),
      cta: "Open",
      onGo: () => {
        setOnboardingOpen(false)
        navigate("/code")
        showToast({
          title: "Open a project",
          description: "Choose a local project, then give Vector one concrete outcome.",
        })
      },
    },
    {
      id: "task",
      title: "Complete one safe first task",
      detail: "Ask Vector to inspect the repository and summarize its architecture without changing files.",
      done: Boolean(onboardingFlags().taskCompleted),
      cta: "Start",
      onGo: () => {
        setOnboardingOpen(false)
        startTask()
        showToast({
          title: "Try a read-only first task",
          description: "Ask Vector to inspect this repository and summarize its architecture without changing files.",
        })
      },
    },
  ]
  const onboardingDoneCount = () => onboardingSteps().filter((step) => step.done).length

  // The first-run tour walks the REAL app: each step spotlights the actual
  // control it teaches, and prepare hooks below put the right surface on
  // screen — Home, a draft workspace with the sidebar, Cloud, then Settings.
  const [tourOpen, setTourOpen] = createSignal(false)
  const [tourStep, setTourStep] = createSignal(0)

  // The settings dialog opens through a lazy import; remember the in-flight
  // open so closing (skip/finish mid-step) waits for it instead of leaving a
  // stray dialog behind, and so Back/Next never stacks a second one.
  const tourSettings = { pending: undefined as Promise<void> | undefined }
  const openTourSettings = () => {
    if (tourSettings.pending) return
    tourSettings.pending = import("@/components/settings-v2/dialog-settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }
  const closeTourSettings = () => {
    const pending = tourSettings.pending
    if (!pending) return
    tourSettings.pending = undefined
    void pending.then(() => dialog.close())
  }

  const ensureTourWorkspace = () => {
    if (taskRoute() || taskDraftRoute()) return
    // Reuse an existing draft instead of minting one per visit — the tour can
    // cross this boundary many times as the user goes Back and forth.
    const draft = tabs.store.find((tab) => tab.type === "draft")
    if (draft && draft.type === "draft") {
      navigate(`/new-session?draftId=${draft.draftID}`)
      return
    }
    startTask()
  }

  const spotlightSteps = createSpotlightSteps({
    goHome: () => {
      if (location.pathname !== "/") navigate("/")
    },
    ensureWorkspace: ensureTourWorkspace,
    showSidebar: () => {
      setNavigationVisible(true)
      setWorkspaceTreeOpen(true)
    },
    goCloud: () => {
      closeTourSettings()
      if (location.pathname !== "/cloud") navigate("/cloud")
    },
    openSettingsDialog: openTourSettings,
    closeSettingsDialog: closeTourSettings,
  })

  const finishTour = () => {
    setTourOpen(false)
    closeTourSettings()
    setOnboardingFlag("tour")
    navigate("/")
    // Hand off to the progress timeline so first steps are visible right away.
    setOnboardingOpen(true)
  }

  const skipTour = () => {
    setTourOpen(false)
    closeTourSettings()
    setOnboardingFlag("tour")
    setOnboardingFlag("dismissed")
    navigate("/")
  }

  const replayTour = () => {
    setOnboardingOpen(false)
    setTourStep(0)
    navigate("/")
    setTourOpen(true)
  }

  onMount(() => {
    const flags = readOnboardingFlags()
    if (flags.tour || flags.dismissed || flags.taskCompleted) return
    // Activation is short and dismissible. The exhaustive spotlight tour is
    // still available from Getting started, but never takes over first launch.
    setTimeout(() => setOnboardingOpen(true), 600)
  })

  createEffect(() => {
    if (!velOpen()) return
    const scope = activeVelScopeKey()
    if (taskConversationRoute() && scope && scope === velScopeKey()) return
    setVelOpen(false)
    setVelScopeKey("")
  })

  const closeOnboarding = () => {
    setOnboardingOpen(false)
    setOnboardingFlag("dismissed")
  }

  // ---- Cloud Services: "set up a database" proposal ------------------------
  // When the agent is asked to do auth / accounts / data, submit.ts emits
  // DB_INTENT_EVENT. We surface a one-click proposal to wire Supabase into the
  // active project — proposal only; the real connect flow runs in the Cloud
  // Database panel, which opens focused via cloudInitialSection.
  const [dbProposal, setDbProposal] = createSignal<({ reason: string } & TaskScope) | undefined>()
  const [dbProposalSuppressed, setDbProposalSuppressed] = createSignal<TaskScope | undefined>()
  const scopeMatches = (candidate: TaskScope | undefined, active = activeTaskScope()) => {
    if (!candidate) return false
    if (candidate.projectPath !== active.projectPath) return false
    // The first prompt emits before the router has assigned its durable task
    // ID. Let that one project-scoped proposal follow the prompt into the new
    // session, but never let a known task ID cross into another task.
    return !candidate.taskId || candidate.taskId === active.taskId
  }
  const activeDbProposal = () => {
    const proposal = dbProposal()
    return scopeMatches(proposal) ? proposal : undefined
  }

  createEffect(() => {
    const onIntent = (event: Event) => {
      // No taskRoute() gate: the FIRST prompt of a new session emits before the
      // router lands on /session/:id, so a route check here would swallow the
      // most common case (fresh task: "add auth"). The banner itself renders on
      // whatever surface the user ends up on and stays dismissible.
      if (scopeMatches(dbProposalSuppressed()) || activeDbProposal()) return
      const detail = (event as CustomEvent<{ reason?: string }>).detail
      setDbProposal({ reason: detail?.reason ?? "database", ...activeTaskScope() })
    }
    globalThis.window?.addEventListener(DB_INTENT_EVENT, onIntent)
    onCleanup(() => globalThis.window?.removeEventListener(DB_INTENT_EVENT, onIntent))
  })

  const openCloudDatabaseSetup = () => {
    const scope = activeTaskScope()
    setDbProposal(undefined)
    setDbProposalSuppressed(scope)
    setToolsOpen(false)
    setSidePanelOpen(false)
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    if (scope.projectPath) layout.home.setSelection({ server: server.key, directory: scope.projectPath })
    navigate("/")
    showToast({
      title: "Cloud Services is on Home",
      description: "Open Cloud Services there to configure this repository's database.",
    })
  }

  const dismissDbProposal = () => {
    setDbProposal(undefined)
    setDbProposalSuppressed(activeTaskScope())
  }

  const openProviderSettings = () => {
    void import("@/components/settings-v2/dialog-settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings section="providers" />)
    })
  }

  const openSettings = () => {
    void import("@/components/settings-v2/dialog-settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  const activeParallelCount = createMemo(
    () => parallelRecords().filter((record) => isParallelWorkspaceRunning(record)).length,
  )
  const reviewParallelCount = createMemo(
    () => parallelRecords().filter((record) => record.status === "needs review").length,
  )
  const activeBackgroundTasks = createMemo(() =>
    backgroundTaskRecords().filter((task) => ["queued", "running", "waiting", "needs_input"].includes(task.status)),
  )
  const projectDisplayName = () => {
    const path = activeTaskScope().projectPath
    if (!path) return "No project loaded"
    return path.split(/[\\/]/).filter(Boolean).at(-1) || path
  }
  const refreshEngineeringConsole = async () => {
    setEngineeringRefreshBusy(true)
    const path = await resolveActiveProjectPath()
    await Promise.all([loadParallelWorkspaces(), loadBackgroundTasks()])
    setEngineeringRefreshBusy(false)
    showToast(
      path
        ? { title: "Engineering Console refreshed", description: `Connected to ${projectDisplayName()}.` }
        : { title: "No active project", description: "Open a project to enable project-scoped engineering tools." },
    )
  }

  let lastPath = ""
  createEffect(() => {
    const path = location.pathname
    // The focused-section request is one-shot: clear it whenever we're not on
    // Cloud so a normal Cloud open always lands on Overview.
    if (path !== lastPath) {
      lastPath = path
      setToolsOpen(false)
      setSidePanelOpen(false)
      setChatSearchOpen(false)
    }
    if (browserAgentRoute()) {
      setBrowserAgentOpen(false)
      navigate(fullscreenReturnPath() || "/")
      return
    }
    if (parallelWorkspacesRoute()) {
      setParallelOpen(false)
      setBrowserAgentOpen(false)
      const parentSessionID = routeContextSessionID()
      navigate(parentSessionID ? sessionHref(server.key, parentSessionID) : fullscreenReturnPath() || "/", {
        replace: true,
      })
      return
    }
    if (cloudRoute()) {
      setBrowserAgentOpen(false)
      setParallelOpen(false)
      setParallelComposerOpen(false)
      return
    }
    setBrowserAgentOpen(false)
    setParallelOpen(false)
    setParallelComposerOpen(false)
    if (taskRoute()) return
    setToolsOpen(false)
    setSidePanelOpen(false)
    setChatSearchOpen(false)
  })

  createEffect(() => {
    if (!taskRoute() && !parallelComposerOpen() && !agentReviewOpen() && !orchestrationOpen()) return
    const timer = globalThis.setInterval(() => {
      void loadParallelWorkspaces()
    }, 1_500)
    onCleanup(() => globalThis.clearInterval(timer))
  })

  const searchChat = (value = chatSearchValue(), backwards = false) => {
    const query = value.trim()
    if (!query) return
    const find = (globalThis.window as unknown as { find?: (...args: unknown[]) => boolean }).find
    if (!find) {
      showToast({ title: "Search is unavailable", description: "This runtime does not expose chat search." })
      return
    }
    const found = find.call(globalThis.window, query, false, backwards, true, false, false, false)
    if (!found) showToast({ title: "No chat matches", description: `No result found for "${query}".` })
  }

  const handleGlobalKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      // Chat search only exists on task routes; elsewhere pages own mod+f.
      if (!taskRoute()) return
      event.preventDefault()
      setChatSearchOpen(true)
      return
    }
    if (event.key === "Escape" && chatSearchOpen()) {
      event.preventDefault()
      setChatSearchOpen(false)
      setChatSearchValue("")
      return
    }
    if (event.key === "Escape" && (eventTargetInsideFloatingSurface(event.target) || floatingSurfaceOpen())) {
      return
    }
    const fullscreenWorkspaceOpen =
      browserAgentOpen() ||
      browserAgentRoute() ||
      parallelOpen() ||
      parallelWorkspacesRoute() ||
      cloudRoute() ||
      canvasRoute()
    if (event.key === "Escape" && (toolsOpen() || sidePanelOpen() || fullscreenWorkspaceOpen)) {
      // First Escape inside a form field only leaves the field so drafts
      // (mission text, browser prompts, URLs) survive; a second Escape closes.
      if (eventTargetIsEditable(event.target)) {
        event.preventDefault()
        ;(event.target as HTMLElement).blur()
        return
      }
      event.preventDefault()
      if (fullscreenWorkspaceOpen) {
        closeFullscreenWorkspace()
        return
      }
      setToolsOpen(false)
      setSidePanelOpen(false)
      setBrowserAgentOpen(false)
      setParallelOpen(false)
      setParallelComposerOpen(false)
      return
    }
    if (!event.shiftKey || event.key !== "Tab") return
    // Shift+Tab toggles plan mode from the composer or the page background,
    // but reverse tab navigation must keep working in dialogs, menus, and
    // form fields outside the composer.
    const target = event.target
    if (target instanceof HTMLElement) {
      if (target.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-slot="dialog"]')) return
      const inField = target.closest("input, select, textarea, [contenteditable]")
      const inInteractive = target.closest(
        'button, a[href], [tabindex], [role="button"], [role="tab"], [role="option"]',
      )
      const inComposer = target.closest(
        '[data-component="prompt-input"], [data-component="session-composer"], [data-component="session-new-composer"]',
      )
      // Reverse tab navigation must keep working on buttons/links/fields;
      // plan mode only toggles from the composer or the page background.
      if ((inField || inInteractive) && !inComposer) return
    }
    event.preventDefault()
    planMode.toggle()
  }

  globalThis.window?.addEventListener("keydown", handleGlobalKeyDown, { capture: true })
  onCleanup(() => globalThis.window?.removeEventListener("keydown", handleGlobalKeyDown, { capture: true }))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      data-vector-shell
      class="relative bg-[#1d1d1f] flex-1 min-h-0 min-w-0 flex flex-col select-none text-[#f4f4f5] [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "--vector-navigation-width": `${navigationWidth()}px`,
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div data-vector-pointer-glow aria-hidden="true" />
      <Titlebar update={update} />
      <main
        data-vector-main-stage
        class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict"
        classList={{ "transition-[padding] duration-200": !navigationResizing() }}
        style={{
          "padding-left": navUnlocked() && navigationVisible() ? "var(--vector-navigation-effective-width)" : "0px",
          background: "var(--vector-workspace-bg, #1d1d1f)",
        }}
      >
        <div class="min-h-0 w-full flex-1">
          <Show when={!parallelWorkspacesRoute()}>
            <Suspense>{props.children}</Suspense>
          </Show>
        </div>
      </main>

      <Show when={activeDbProposal() && !cloudRoute()}>
        <div class="fixed bottom-5 left-1/2 z-[120] flex max-w-[560px] -translate-x-1/2 items-center gap-3 rounded-2xl border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-sidebar)_92%,transparent)] px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
          <span
            class="grid size-9 shrink-0 place-items-center rounded-xl"
            style={{ background: "var(--vx-gradient, #9374ec)" }}
          >
            <svg viewBox="0 0 16 16" class="size-4 text-white" aria-hidden="true">
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
            </svg>
          </span>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-semibold text-white">This looks like it needs a database</div>
            <p class="text-[11.5px] text-white/55">
              Vector can connect Supabase to {projectDisplayName()} — auth, users and data wired into your project.
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-white/15"
            onClick={openCloudDatabaseSetup}
          >
            Go to Home →
          </button>
          <button
            type="button"
            class="shrink-0 rounded-lg px-2 py-1.5 text-[12px] text-white/45 transition hover:text-white/80"
            onClick={dismissDbProposal}
          >
            Dismiss
          </button>
        </div>
      </Show>

      <Show when={canvasRoute()}>
        <CanvasWorkspace
          onClose={closeFullscreenWorkspace}
          macPad={macDesktop()}
          models={parallelModelOptions()}
          resolveProjectPath={resolveActiveProjectPath}
          onManageProviders={openProviderSettings}
          taskId={() => activeTaskScope().taskId}
          projectId={() => taskScopeId(activeTaskScope())}
        />
      </Show>

      <Show when={taskConversationRoute() && (activeTaskScope().taskId || activeDraftID())}>
        <VelCall
          open={velOpen()}
          onClose={() => {
            setVelOpen(false)
            setVelScopeKey("")
          }}
          directory={resolveActiveProjectPath}
          sessionId={() => {
            const sessionID = activeTaskScope().taskId
            return sessionID && serverSync().session.get(sessionID) ? sessionID : undefined
          }}
          onSessionCreated={(created) => {
            setVelScopeKey(`session:${created.id}`)
            serverSync().session.remember(created)
            const draftID = activeDraftID()
            if (draftID) {
              try {
                const draft = tabs.draft(draftID)
                tabs.promoteDraft(draftID, { server: draft.server, sessionId: created.id })
                return
              } catch {
                // The draft may already have been promoted by a simultaneous typed send.
              }
            }
            navigate(sessionHref(server.key, created.id), { replace: true })
          }}
          model={() => {
            const active = serverSync().session.get(activeTaskScope().taskId ?? "")
            if (active?.model?.providerID && active.model.id) {
              return { providerID: active.model.providerID, modelID: active.model.id }
            }
            const providerID = parallelProvider()
            const modelID = parallelModel()
            return providerID && modelID ? { providerID, modelID } : undefined
          }}
          agent={() => serverSync().session.get(activeTaskScope().taskId ?? "")?.agent || "build"}
          contextLabel={projectDisplayName}
        />
      </Show>

      <SpotlightTour
        open={tourOpen()}
        steps={spotlightSteps}
        step={tourStep()}
        onStep={setTourStep}
        onFinish={finishTour}
        onSkip={skipTour}
      />
      <OnboardingProgress
        open={onboardingOpen()}
        steps={onboardingSteps()}
        onReplayTour={replayTour}
        onClose={closeOnboarding}
      />

      <Show when={parallelComposerOpen()}>
        <div
          class="fixed inset-0 z-[165] flex items-center justify-center bg-black/55 p-5 backdrop-blur-[3px]"
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return
            setParallelComposerOpen(false)
          }}
        >
          <form
            class="w-full max-w-[560px] overflow-hidden rounded-[18px] border border-[color:var(--vx-line)] bg-[#242428] shadow-[0_32px_110px_rgba(0,0,0,0.62)]"
            onSubmit={(event) => {
              event.preventDefault()
              void submitParallelLaunch()
            }}
          >
            <header class="flex items-start gap-3 border-b border-[color:var(--vx-line)] px-5 py-4">
              <span class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[11px] bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]">
                <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                  <path
                    d="M4.1 5.15h7.8v6.2H4.1zM6 5.15V3.7h4v1.45M6.2 8h.01M9.8 8h.01M6.45 9.8h3.1"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.15"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
              <div class="min-w-0 flex-1">
                <h2 class="text-[15px] font-semibold text-white">
                  {parallelLaunchMode() === "swarm" ? "Coordinate agents" : "New isolated agent"}
                </h2>
                <p class="mt-1 text-[12px] leading-5 text-white/48">
                  {parallelLaunchMode() === "swarm"
                    ? "Vector plans dependencies, assigns specialists, validates their work, and prepares one aggregate review."
                    : "A separate Vector session works in its own git worktree or managed project copy."}
                </p>
              </div>
              <button
                type="button"
                class="grid size-8 place-items-center rounded-[9px] text-white/42 transition hover:bg-white/[0.07] hover:text-white"
                onClick={() => setParallelComposerOpen(false)}
                aria-label="Close agent launcher"
                title="Close"
              >
                <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                  <path
                    d="m4.5 4.5 7 7m0-7-7 7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.35"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </header>

            <div class="space-y-3 px-5 py-4">
              <div class="grid grid-cols-2 rounded-[11px] border border-[color:var(--vx-line)] bg-black/20 p-1">
                <button
                  type="button"
                  class="rounded-[8px] px-3 py-2 text-[12px] font-medium transition"
                  classList={{
                    "bg-white/[0.09] text-white": parallelLaunchMode() === "agent",
                    "text-white/42 hover:text-white/72": parallelLaunchMode() !== "agent",
                  }}
                  onClick={() => setParallelLaunchMode("agent")}
                >
                  One agent
                </button>
                <button
                  type="button"
                  class="rounded-[8px] px-3 py-2 text-[12px] font-medium transition"
                  classList={{
                    "bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]":
                      parallelLaunchMode() === "swarm",
                    "text-white/42 hover:text-white/72": parallelLaunchMode() !== "swarm",
                  }}
                  onClick={() => {
                    setParallelLaunchMode("swarm")
                    setParallelCompareRuntimes(false)
                  }}
                >
                  Coordinated run
                </button>
              </div>

              <Show when={parallelLaunchMode() === "agent"}>
                <div class="mb-3">
                  <div class="mb-1.5 flex items-center justify-between px-1">
                    <span class="text-[10px] font-semibold uppercase tracking-[0.09em] text-white/35">
                      Alone or together
                    </span>
                    <span class="text-[10px] text-white/30">Alone is safest; together is faster</span>
                  </div>
                  <div class="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      class="rounded-[10px] border px-2.5 py-2 text-left transition"
                      classList={{
                        "border-[color:var(--vx-purple)]/55 bg-[color:var(--vx-purple-soft)] text-white":
                          parallelTopology() === "isolated",
                        "border-[color:var(--vx-line)] bg-white/[0.025] text-white/58 hover:bg-white/[0.05]":
                          parallelTopology() !== "isolated",
                      }}
                      onClick={() => {
                        setParallelTopology("isolated")
                        setParallelJoinTeamId(undefined)
                        setCollaborationShape("all")
                        setCollaborationCoordinator(undefined)
                        setCollaborationLinks([])
                      }}
                    >
                      <span class="block text-[11px] font-semibold">Work alone</span>
                      <span class="mt-0.5 block text-[9.5px] leading-3 opacity-70">
                        Its own git branch and files. Agents never see each other's edits and cannot message each other.
                      </span>
                    </button>
                    <button
                      type="button"
                      class="rounded-[10px] border px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45"
                      classList={{
                        "border-[color:var(--vx-purple)]/55 bg-[color:var(--vx-purple-soft)] text-white":
                          parallelTopology() !== "isolated",
                        "border-[color:var(--vx-line)] bg-white/[0.025] text-white/58 hover:bg-white/[0.05]":
                          parallelTopology() === "isolated",
                      }}
                      disabled={!agentTeamsApi()}
                      title={agentTeamsApi() ? undefined : "Teamwork activates once Vector connects to this workspace."}
                      onClick={() => setParallelTopology("collaborative")}
                    >
                      <span class="block text-[11px] font-semibold">Work together</span>
                      <span class="mt-0.5 block text-[9.5px] leading-3 opacity-70">
                        One shared checkout. Agents see each other's edits and can message each other while working.
                      </span>
                    </button>
                  </div>
                  <Show when={!agentTeamsApi()}>
                    <p class="mt-1.5 px-1 text-[10px] leading-4 text-white/40">
                      Teamwork activates once Vector connects to this workspace. Until then every agent runs alone in
                      its own worktree.
                    </p>
                  </Show>
                  {/* Only a new team chooses where it works: joining one adopts the
                      checkout that team already provisioned. */}
                  <Show when={parallelTopology() !== "isolated" && !parallelJoinTeamId()}>
                    <div class="mt-1.5 grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        class="rounded-[10px] border px-2.5 py-2 text-left transition"
                        classList={{
                          "border-[color:var(--vx-purple)]/55 bg-[color:var(--vx-purple-soft)] text-white":
                            parallelTopology() === "collaborative",
                          "border-[color:var(--vx-line)] bg-white/[0.025] text-white/58 hover:bg-white/[0.05]":
                            parallelTopology() !== "collaborative",
                        }}
                        onClick={() => setParallelTopology("collaborative")}
                      >
                        <span class="block text-[11px] font-semibold">Shared worktree</span>
                        <span class="mt-0.5 block text-[9.5px] leading-3 opacity-70">
                          One branch off HEAD that the whole team edits. Your project stays untouched until you merge.
                        </span>
                      </button>
                      <button
                        type="button"
                        class="rounded-[10px] border px-2.5 py-2 text-left transition"
                        classList={{
                          "border-amber-300/45 bg-amber-300/[0.07] text-amber-100":
                            parallelTopology() === "shared-main",
                          "border-[color:var(--vx-line)] bg-white/[0.025] text-white/58 hover:bg-white/[0.05]":
                            parallelTopology() !== "shared-main",
                        }}
                        onClick={() => setParallelTopology("shared-main")}
                      >
                        <span class="block text-[11px] font-semibold">Directly on main</span>
                        <span class="mt-0.5 block text-[9.5px] leading-3 opacity-70">
                          Agents edit your real project files. Nothing to merge — the changes are already there.
                        </span>
                      </button>
                    </div>
                    <Show when={parallelTopology() === "shared-main"}>
                      <p class="mt-1.5 rounded-[10px] border border-amber-300/20 bg-amber-300/[0.055] px-2.5 py-2 text-[10px] leading-4 text-amber-100/78">
                        No worktree and no isolation: every edit lands in your working tree as it happens. Commit or
                        stash what you care about first — review with git before you commit.
                      </p>
                    </Show>
                  </Show>
                  <Show when={parallelTopology() !== "isolated"}>
                    <div class="mt-1.5 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.02] px-2.5 py-2">
                      <Show
                        when={openTeams().length}
                        fallback={
                          <p class="text-[10px] leading-4 text-white/45">
                            A new team is created for this agent. Launch another agent into it to have them work
                            together.
                          </p>
                        }
                      >
                        <div class="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-white/35">
                          Team
                        </div>
                        <div class="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            class="rounded-[7px] border px-2 py-1 text-[10.5px] transition"
                            classList={{
                              "border-[color:var(--vx-purple)]/55 text-white": !parallelJoinTeamId(),
                              "border-[color:var(--vx-line)] text-white/55": Boolean(parallelJoinTeamId()),
                            }}
                            onClick={() => {
                              setParallelJoinTeamId(undefined)
                              setCollaborationShape("all")
                              setCollaborationCoordinator(undefined)
                              setCollaborationLinks([])
                            }}
                          >
                            New team
                          </button>
                          <For each={openTeams()}>
                            {(item) => (
                              <button
                                type="button"
                                class="rounded-[7px] border px-2 py-1 text-[10.5px] transition"
                                classList={{
                                  "border-[color:var(--vx-purple)]/55 text-white": parallelJoinTeamId() === item.id,
                                  "border-[color:var(--vx-line)] text-white/55": parallelJoinTeamId() !== item.id,
                                }}
                                onClick={() => {
                                  setParallelJoinTeamId(item.id)
                                  setParallelTopology(item.topology)
                                }}
                              >
                                {item.name} · {item.memberIds.length}
                              </button>
                            )}
                          </For>
                        </div>
                        <Show when={openTeams().find((item) => item.id === parallelJoinTeamId())}>
                          {(joined) => (
                            <p class="mt-1.5 text-[10px] leading-4 text-white/45">
                              {joined().topology === "shared-main"
                                ? "This team edits your project files directly — there is nothing to merge afterwards."
                                : "This agent joins the team's existing shared checkout and sees the edits already in it."}
                            </p>
                          )}
                        </Show>
                      </Show>
                    </div>
                    <div class="mt-1.5 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.02] px-2.5 py-2">
                      <div class="mb-1.5 flex items-center justify-between">
                        <span class="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-white/35">
                          Who can message whom
                        </span>
                        <span class="text-[9.5px] text-white/28">
                          {collaborationRoster().length === 1 ? "1 agent" : `${collaborationRoster().length} agents`}
                        </span>
                      </div>
                      <Show
                        when={collaborationRoster().length > 1}
                        fallback={
                          <p class="text-[10px] leading-4 text-white/45">
                            Pairing appears once this team has a second agent — a solo member has no one to message.
                          </p>
                        }
                      >
                        <div class="grid grid-cols-3 gap-1">
                          <button
                            type="button"
                            class="rounded-[7px] border px-2 py-1.5 text-[10.5px] transition"
                            classList={{
                              "border-[color:var(--vx-purple)]/55 text-white": collaborationShape() === "all",
                              "border-[color:var(--vx-line)] text-white/50 hover:text-white/75":
                                collaborationShape() !== "all",
                            }}
                            onClick={() => setCollaborationShape("all")}
                          >
                            Everyone
                          </button>
                          <button
                            type="button"
                            class="rounded-[7px] border px-2 py-1.5 text-[10.5px] transition"
                            classList={{
                              "border-[color:var(--vx-purple)]/55 text-white": collaborationShape() === "coordinator",
                              "border-[color:var(--vx-line)] text-white/50 hover:text-white/75":
                                collaborationShape() !== "coordinator",
                            }}
                            onClick={() => {
                              setCollaborationShape("coordinator")
                              if (collaborationCoordinator()) return
                              setCollaborationCoordinator(collaborationRoster()[0]?.id)
                            }}
                          >
                            Coordinator
                          </button>
                          <button
                            type="button"
                            class="rounded-[7px] border px-2 py-1.5 text-[10.5px] transition"
                            classList={{
                              "border-[color:var(--vx-purple)]/55 text-white": collaborationShape() === "custom",
                              "border-[color:var(--vx-line)] text-white/50 hover:text-white/75":
                                collaborationShape() !== "custom",
                            }}
                            onClick={() => {
                              setCollaborationShape("custom")
                              // Seeded all-to-all so unchecking one pair edits the
                              // team's current behaviour instead of muting it.
                              if (collaborationLinks().length) return
                              setCollaborationLinks(
                                collaborationRoster().flatMap((from) =>
                                  collaborationRoster()
                                    .filter((to) => to.id !== from.id)
                                    .map((to) => collaborationLinkKey(from.id, to.id)),
                                ),
                              )
                            }}
                          >
                            Custom
                          </button>
                        </div>

                        <Show when={collaborationShape() === "all"}>
                          <p class="mt-1.5 text-[10px] leading-4 text-white/45">
                            Every agent may message every other agent. This is the default and is stored as no
                            restriction at all.
                          </p>
                        </Show>

                        <Show when={collaborationShape() === "coordinator"}>
                          <div class="mt-1.5 flex flex-wrap gap-1.5">
                            <For each={collaborationRoster()}>
                              {(member) => (
                                <button
                                  type="button"
                                  class="max-w-full truncate rounded-[7px] border px-2 py-1 text-[10.5px] transition"
                                  classList={{
                                    "border-[color:var(--vx-purple)]/55 text-white":
                                      collaborationCoordinator() === member.id,
                                    "border-[color:var(--vx-line)] text-white/50":
                                      collaborationCoordinator() !== member.id,
                                  }}
                                  onClick={() => setCollaborationCoordinator(member.id)}
                                >
                                  {member.name}
                                </button>
                              )}
                            </For>
                          </div>
                          <p class="mt-1.5 text-[10px] leading-4 text-white/45">
                            {collaborationRoster().find((member) => member.id === collaborationCoordinator())?.name ||
                              collaborationRoster()[0]?.name}{" "}
                            may message every teammate and each of them may reply to it. Workers cannot message each
                            other.
                          </p>
                        </Show>

                        <Show when={collaborationShape() === "custom"}>
                          <div class="mt-1.5 overflow-x-auto [scrollbar-width:thin]">
                            <table class="w-full border-separate border-spacing-0 text-[9.5px]">
                              <thead>
                                <tr>
                                  <th class="px-1 py-1 text-left font-medium text-white/30">may message →</th>
                                  <For each={collaborationRoster()}>
                                    {(member) => (
                                      <th class="px-1 py-1 font-medium text-white/35">
                                        <span class="mx-auto block max-w-[56px] truncate">{member.name}</span>
                                      </th>
                                    )}
                                  </For>
                                </tr>
                              </thead>
                              <tbody>
                                <For each={collaborationRoster()}>
                                  {(from) => (
                                    <tr>
                                      <td class="max-w-[120px] truncate px-1 py-1 text-[10px] text-white/55">
                                        {from.name}
                                      </td>
                                      <For each={collaborationRoster()}>
                                        {(to) => (
                                          <td class="px-1 py-1 text-center">
                                            <Show
                                              when={from.id !== to.id}
                                              fallback={<span class="text-white/15">—</span>}
                                            >
                                              <input
                                                type="checkbox"
                                                class="size-3 accent-[color:var(--vx-purple)]"
                                                aria-label={`${from.name} may message ${to.name}`}
                                                checked={collaborationLinks().includes(
                                                  collaborationLinkKey(from.id, to.id),
                                                )}
                                                onChange={(event) => {
                                                  const key = collaborationLinkKey(from.id, to.id)
                                                  const allowed = event.currentTarget.checked
                                                  setCollaborationLinks((links) =>
                                                    allowed
                                                      ? [...links.filter((item) => item !== key), key]
                                                      : links.filter((item) => item !== key),
                                                  )
                                                }}
                                              />
                                            </Show>
                                          </td>
                                        )}
                                      </For>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                          <p class="mt-1.5 text-[10px] leading-4 text-white/45">
                            A row may message the columns it has checked. An unchecked pair gets a written refusal
                            naming who it may reach instead, so nothing is dropped silently.
                          </p>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </div>
                <div>
                  <div class="mb-1.5 flex items-center justify-between px-1">
                    <span class="text-[10px] font-semibold uppercase tracking-[0.09em] text-white/35">
                      Agent runtime
                    </span>
                    <span class="text-[10px] text-white/30">Uses the runtime already installed on this computer</span>
                  </div>
                  <div class="grid grid-cols-4 gap-1.5">
                    <For each={["vector", "claude-code", "codex", "cursor"] as ParallelAgentRuntime[]}>
                      {(runtime) => {
                        const status = () => externalRuntimeStatus(runtime)
                        const ready = () =>
                          runtime === "vector" ? parallelModelOptions().length > 0 : Boolean(status()?.installed)
                        // Every runtime stays on screen even when it cannot run.
                        // A hidden option reads as a broken feature; a visible
                        // one that names its blocker reads as a setup step.
                        const reason = () => {
                          if (runtime === "vector") return ready() ? "Ready on your keys" : "No provider connected"
                          if (!globalThis.window?.api) return "Desktop only"
                          if (externalAgentsChecking() && !status()) return "Checking…"
                          if (ready()) return status()?.version || "Installed"
                          return "Not installed"
                        }
                        // Deliberately not aria-disabled: picking an undetected
                        // runtime is how its install and sign-in steps appear,
                        // so the tile is fully actionable. Announcing it as
                        // unavailable would hide the only route to setting it
                        // up, and the status line inside the tile already
                        // carries the reason into the accessible name.
                        return (
                          <button
                            type="button"
                            class="min-w-0 rounded-[10px] border px-2 py-2 text-left transition"
                            classList={{
                              "border-[color:var(--vx-purple)]/55 bg-[color:var(--vx-purple-soft)] text-white":
                                parallelRuntime() === runtime,
                              "border-[color:var(--vx-line)] bg-white/[0.025] text-white/58 hover:bg-white/[0.05]":
                                parallelRuntime() !== runtime,
                              "opacity-55": !ready() && parallelRuntime() !== runtime,
                            }}
                            title={
                              ready()
                                ? undefined
                                : runtime === "vector"
                                  ? "Connect an AI provider — Vector agents run on your own keys."
                                  : `${parallelRuntimeLabel(runtime)} is not detected. Install it with: ${externalRuntimeSetup(runtime)?.installCommand ?? ""}`
                            }
                            onClick={() => {
                              setParallelRuntime(runtime)
                              setParallelCompareRuntimes(false)
                              setParallelError("")
                            }}
                          >
                            <span class="block truncate text-[11px] font-semibold">
                              {parallelRuntimeLabel(runtime)}
                            </span>
                            <span class="mt-1 flex items-center gap-1 text-[9.5px] text-white/38">
                              <span
                                class={`size-1.5 shrink-0 rounded-full ${ready() ? "bg-emerald-400" : externalAgentsChecking() && runtime !== "vector" ? "animate-pulse bg-amber-300" : "bg-white/20"}`}
                              />
                              <span class="truncate">{reason()}</span>
                            </span>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                  <Show
                    when={isExternalRuntime(parallelRuntime()) && !externalRuntimeStatus(parallelRuntime())?.installed}
                  >
                    <ExternalRuntimeSetupPanel
                      runtime={parallelRuntime() as ExternalRuntime}
                      checking={externalAgentsChecking()}
                      onRecheck={detectExternalRuntimes}
                    />
                  </Show>
                  <Show when={globalThis.window?.api && blockedRuntimes().length}>
                    <div class="mt-2 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.02] px-2.5 py-2">
                      <div class="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-white/35">
                        Not available on this computer
                      </div>
                      <For each={blockedRuntimes()}>
                        {(entry) => (
                          <div class="flex min-w-0 items-baseline gap-2 py-0.5">
                            <span class="w-[74px] shrink-0 truncate text-[10px] text-white/50">
                              {parallelRuntimeLabel(entry.runtime)}
                            </span>
                            <code class="min-w-0 flex-1 truncate font-mono text-[9.5px] text-white/38">
                              {entry.setup?.installCommand}
                            </code>
                          </div>
                        )}
                      </For>
                      <p class="mt-1 text-[9.5px] leading-4 text-white/30">
                        Select one above for its full install and sign-in steps. Vector runs your own CLI and never
                        falls back to a runtime you did not pick.
                      </p>
                    </div>
                  </Show>
                  <Show when={!globalThis.window?.api}>
                    <p class="mt-2 px-1 text-[10px] leading-4 text-white/40">
                      Claude Code, Codex, and Cursor Agent activate once Vector connects to this workspace — the browser
                      build cannot see the CLIs installed on your computer.
                    </p>
                  </Show>
                  <button
                    type="button"
                    class="mt-2 flex w-full items-center justify-between rounded-[10px] border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45"
                    classList={{
                      "border-[color:var(--vx-purple)]/50 bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]":
                        parallelCompareRuntimes(),
                      "border-[color:var(--vx-line)] bg-white/[0.02] text-white/52 hover:bg-white/[0.045]":
                        !parallelCompareRuntimes(),
                    }}
                    disabled={readyComparisonRuntimes().length < 2}
                    onClick={() => {
                      setParallelCompareRuntimes((enabled) => !enabled)
                      setParallelError("")
                    }}
                  >
                    <span>
                      <span class="block text-[11px] font-semibold">Compare ready runtimes</span>
                      <span class="mt-0.5 block text-[9.5px] text-current opacity-65">
                        {readyComparisonRuntimes().length < 2
                          ? `Needs two detected runtimes; ${readyComparisonRuntimes().length} found`
                          : `Run the same mission in ${readyComparisonRuntimes().length} isolated workspaces`}
                      </span>
                    </span>
                    <span class="text-[10px] font-semibold">{parallelCompareRuntimes() ? "ON" : "OFF"}</span>
                  </button>
                  <Show when={parallelCompareRuntimes()}>
                    <p class="mt-1.5 px-1 text-[10px] leading-4 text-amber-100/62">
                      Comparison runs consume each selected runtime's normal usage. Vector compares verified evidence
                      and never merges automatically.
                      <Show when={blockedRuntimes().length}>
                        {" "}
                        {blockedRuntimes()
                          .map((entry) => parallelRuntimeLabel(entry.runtime))
                          .join(", ")}{" "}
                        {blockedRuntimes().length > 1 ? "are" : "is"} excluded — not detected on this computer.
                      </Show>
                    </p>
                  </Show>
                </div>
              </Show>

              <input
                class="vx-input-quiet h-10 w-full rounded-[11px] border px-3 text-[13px] text-white outline-none placeholder:text-white/35"
                placeholder={parallelLaunchMode() === "swarm" ? "Run name (optional)" : "Workspace name"}
                value={parallelName()}
                onInput={(event) => setParallelName(event.currentTarget.value)}
              />
              <textarea
                ref={parallelPromptRef}
                class="vx-input-quiet min-h-[124px] w-full resize-none rounded-[12px] border px-3 py-3 text-[13px] leading-5 text-white outline-none placeholder:text-white/35"
                placeholder={
                  parallelLaunchMode() === "swarm"
                    ? "Describe the complete outcome. Vector will split it into dependent specialist work."
                    : "What should this agent build, fix, test, or investigate?"
                }
                value={parallelPrompt()}
                onInput={(event) => setParallelPrompt(event.currentTarget.value)}
              />

              <Show
                when={
                  parallelLaunchMode() === "agent" &&
                  !parallelCompareRuntimes() &&
                  parallelRuntime() === "vector" &&
                  parallelModelOptions().length === 0
                }
              >
                <button
                  type="button"
                  class="flex h-10 w-full items-center justify-between rounded-[11px] border border-[color:var(--vx-purple)]/35 bg-[color:var(--vx-purple-soft)] px-3 text-[12px] text-[color:var(--vx-purple-bright)]"
                  onClick={openProviderSettings}
                >
                  <span>Connect a model provider to launch agents</span>
                  <span>Open settings</span>
                </button>
              </Show>
              <Show
                when={
                  parallelLaunchMode() === "agent" &&
                  !parallelCompareRuntimes() &&
                  parallelRuntime() !== "vector" &&
                  !parallelRuntimeReady()
                }
              >
                <div class="rounded-[10px] border border-amber-300/20 bg-amber-300/[0.055] px-3 py-2 text-[11px] leading-5 text-amber-100/75">
                  {parallelRuntimeLabel(parallelRuntime())} must be installed and signed in before Vector can run it.
                  Missing runtimes stay disabled instead of silently falling back.
                </div>
              </Show>

              <Show when={parallelLaunchMode() === "swarm"}>
                <div class="grid grid-cols-3 gap-2">
                  <label class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2">
                    <span class="block text-[10px] uppercase tracking-[0.08em] text-white/35">Routing</span>
                    <select
                      class="mt-1 w-full bg-transparent text-[12px] text-white/78 outline-none"
                      value={swarmStrategy()}
                      onChange={(event) => {
                        const value = event.currentTarget.value
                        if (value === "economy" || value === "balanced" || value === "quality") setSwarmStrategy(value)
                      }}
                    >
                      <option value="economy">Economy</option>
                      <option value="balanced">Balanced</option>
                      <option value="quality">Quality</option>
                    </select>
                  </label>
                  <label class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2">
                    <span class="block text-[10px] uppercase tracking-[0.08em] text-white/35">Max agents</span>
                    <input
                      type="number"
                      min="2"
                      max="16"
                      class="mt-1 w-full bg-transparent text-[12px] text-white/78 outline-none"
                      value={Math.min(16, swarmMaxAgents())}
                      onInput={(event) =>
                        setSwarmMaxAgents(Math.max(2, Math.min(16, Number(event.currentTarget.value) || 2)))
                      }
                    />
                  </label>
                  <label class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2">
                    <span class="block text-[10px] uppercase tracking-[0.08em] text-white/35">At once</span>
                    <input
                      type="number"
                      min="1"
                      max="16"
                      class="mt-1 w-full bg-transparent text-[12px] text-white/78 outline-none"
                      value={Math.min(16, swarmConcurrency())}
                      onInput={(event) =>
                        setSwarmConcurrency(Math.max(1, Math.min(16, Number(event.currentTarget.value) || 1)))
                      }
                    />
                  </label>
                </div>
                <p class="rounded-[10px] border border-amber-300/15 bg-amber-300/[0.045] px-3 py-2 text-[11px] leading-5 text-amber-100/68">
                  Concurrent agents share your configured provider keys and can multiply usage. Your main project
                  remains untouched until you approve the final diff.
                </p>
              </Show>

              <Show when={parallelError()}>
                <div class="rounded-[10px] border border-rose-400/25 bg-rose-400/[0.08] px-3 py-2 text-[12px] leading-5 text-rose-200">
                  {parallelError()}
                </div>
              </Show>
            </div>

            <footer class="flex items-center justify-between border-t border-[color:var(--vx-line)] px-5 py-3.5">
              <span class="text-[11px] text-white/38">
                {parallelLaunchMode() === "swarm"
                  ? `Up to ${Math.min(16, swarmMaxAgents())} isolated specialists`
                  : `${availableWorkspaceSlots()} of 16 agent slots available`}
              </span>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="h-9 rounded-[10px] px-3 text-[12px] text-white/52 transition hover:bg-white/[0.06] hover:text-white"
                  onClick={() => setParallelComposerOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="h-9 rounded-[10px] bg-[color:var(--vx-purple)] px-4 text-[12px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={
                    parallelBusy() ||
                    !parallelPrompt().trim() ||
                    (parallelLaunchMode() === "agent"
                      ? parallelCompareRuntimes()
                        ? readyComparisonRuntimes().length < 2
                        : !parallelRuntimeReady()
                      : parallelModelOptions().length === 0)
                  }
                >
                  {parallelBusy()
                    ? "Preparing..."
                    : parallelLaunchMode() === "swarm"
                      ? "Start coordinated run"
                      : parallelCompareRuntimes()
                        ? `Launch ${readyComparisonRuntimes().length} comparisons`
                        : "Launch agent"}
                </button>
              </div>
            </footer>
          </form>
        </div>
      </Show>

      <Show when={agentReviewOpen() && selectedParallelWorkspace()}>
        {(selected) => {
          const record = () => selected()
          const stats = () => parallelDiffStats(record())
          return (
            <div
              class="fixed inset-0 z-[160] flex justify-end bg-black/38 backdrop-blur-[2px]"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setAgentReviewOpen(false)
              }}
            >
              <section class="flex h-full w-[min(900px,92vw)] flex-col border-l border-[color:var(--vx-line)] bg-[#202023] shadow-[-28px_0_90px_rgba(0,0,0,0.48)]">
                <header class="flex shrink-0 items-start gap-3 border-b border-[color:var(--vx-line)] px-5 py-4">
                  <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-2">
                      <h2 class="truncate text-[15px] font-semibold text-white">Review {record().name}</h2>
                      <span
                        class={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${parallelStatusTone(record().status)}`}
                      >
                        {parallelStatusLabel(record().status)}
                      </span>
                    </div>
                    <p class="mt-1 truncate text-[11.5px] text-white/42">
                      {parallelRuntimeLabel(record().runtime)} ·{" "}
                      {record().isolation === "git-worktree" ? record().gitBranch : "Managed isolated copy"} ·{" "}
                      {record().model}
                    </p>
                  </div>
                  <button
                    type="button"
                    class="grid size-8 place-items-center rounded-[9px] text-white/42 transition hover:bg-white/[0.07] hover:text-white"
                    onClick={() => setAgentReviewOpen(false)}
                    aria-label="Close review"
                    title="Close"
                  >
                    <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                      <path
                        d="m4.5 4.5 7 7m0-7-7 7"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.35"
                        stroke-linecap="round"
                      />
                    </svg>
                  </button>
                </header>

                <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  <div class="mb-4 grid grid-cols-4 gap-2">
                    <div class="rounded-[11px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2.5">
                      <span class="block text-[10px] text-white/35">Files</span>
                      <strong class="mt-1 block text-[14px] text-white/86">{record().changedFilesCount}</strong>
                    </div>
                    <div class="rounded-[11px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2.5">
                      <span class="block text-[10px] text-white/35">Added</span>
                      <strong class="mt-1 block text-[14px] text-emerald-300">+{stats().added}</strong>
                    </div>
                    <div class="rounded-[11px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2.5">
                      <span class="block text-[10px] text-white/35">Removed</span>
                      <strong class="mt-1 block text-[14px] text-rose-300">-{stats().removed}</strong>
                    </div>
                    <div class="rounded-[11px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2.5">
                      <span class="block text-[10px] text-white/35">Risk</span>
                      <strong class="mt-1 block text-[14px] capitalize text-white/86">{record().riskLevel}</strong>
                    </div>
                  </div>

                  <Show when={comparableAgentResults().length > 1}>
                    <div class="mb-4 rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.018] p-3">
                      <div class="mb-2.5 flex items-center justify-between px-1">
                        <div>
                          <div class="text-[11px] font-semibold text-white/76">Compare agent outputs</div>
                          <div class="mt-0.5 text-[10.5px] text-white/36">
                            Measured checks, risk, diff size, and reported runtime cost. Vector does not invent a
                            quality score.
                          </div>
                        </div>
                        <span class="rounded-full border border-[color:var(--vx-line)] px-2 py-1 text-[10px] text-white/38">
                          {comparableAgentResults().length} results
                        </span>
                      </div>
                      <div class="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
                        <For each={comparableAgentResults()}>
                          {(candidate) => {
                            const candidateStats = () => parallelDiffStats(candidate)
                            const elapsed = () =>
                              Math.max(
                                0,
                                Math.round(
                                  (new Date(candidate.lastActivityAt).getTime() -
                                    new Date(candidate.createdAt).getTime()) /
                                    1000,
                                ),
                              )
                            return (
                              <button
                                type="button"
                                class="w-[210px] shrink-0 rounded-[10px] border p-3 text-left transition hover:bg-white/[0.05]"
                                classList={{
                                  "border-[color:var(--vx-purple)]/55 bg-[color:var(--vx-purple-soft)]":
                                    candidate.id === record().id,
                                  "border-[color:var(--vx-line)] bg-black/15": candidate.id !== record().id,
                                }}
                                onClick={() => {
                                  setParallelSelectedID(candidate.id)
                                  void refreshParallelWorkspace(candidate.id)
                                }}
                              >
                                <div class="flex items-center justify-between gap-2">
                                  <span class="truncate text-[11.5px] font-semibold text-white/78">
                                    {parallelRuntimeLabel(candidate.runtime)}
                                  </span>
                                  <span
                                    class={`size-1.5 shrink-0 rounded-full ${candidate.validationPassed === true ? "bg-emerald-400" : candidate.validationPassed === false ? "bg-rose-400" : "bg-white/25"}`}
                                  />
                                </div>
                                <div class="mt-1 truncate text-[10.5px] text-white/42">{candidate.name}</div>
                                <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-white/38">
                                  <span>{candidate.changedFilesCount} files</span>
                                  <span>{elapsed()}s</span>
                                  <span class="text-emerald-300/75">+{candidateStats().added}</span>
                                  <span class="text-rose-300/75">-{candidateStats().removed}</span>
                                  <span class="capitalize">{candidate.riskLevel} risk</span>
                                  <span>{candidate.actualCost || candidate.estimatedCost}</span>
                                </div>
                              </button>
                            )
                          }}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={record().error}>
                    <div class="mb-4 rounded-[11px] border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2.5 text-[12px] leading-5 text-rose-200">
                      {record().error}
                    </div>
                  </Show>
                  <Show when={record().finalSummary}>
                    <div class="mb-4 rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.025] px-4 py-3">
                      <div class="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/35">
                        Agent summary
                      </div>
                      <p class="mt-1.5 text-[12.5px] leading-5 text-white/68">{record().finalSummary}</p>
                    </div>
                  </Show>
                  <Show when={record().validationReport}>
                    {(validation) => (
                      <div class="mb-4 rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.025] px-4 py-3">
                        <div class="flex items-center justify-between">
                          <span class="text-[11px] font-semibold text-white/72">Validation</span>
                          <span
                            class={validation().passed ? "text-[11px] text-emerald-300" : "text-[11px] text-rose-300"}
                          >
                            {validation().passed ? "Passed" : "Needs attention"}
                          </span>
                        </div>
                        <div class="mt-2 space-y-1.5">
                          <For each={validation().checks}>
                            {(check) => (
                              <div class="flex items-center gap-2 text-[11px]">
                                <span
                                  class={
                                    check.status === "passed"
                                      ? "size-1.5 rounded-full bg-emerald-400"
                                      : check.status === "failed"
                                        ? "size-1.5 rounded-full bg-rose-400"
                                        : "size-1.5 rounded-full bg-white/25"
                                  }
                                />
                                <span class="min-w-0 flex-1 truncate text-white/55">{check.label}</span>
                                <code class="truncate text-white/28">{check.command}</code>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </Show>

                  <Show when={record().logs.length || record().terminalOutput.length}>
                    <details
                      class="mb-4 overflow-hidden rounded-[12px] border border-[color:var(--vx-line)] bg-black/20"
                      open={record().runtime !== "vector" && isParallelWorkspaceRunning(record())}
                    >
                      <summary class="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[11px] font-semibold text-white/70">
                        <span>Live agent activity</span>
                        <span class="font-normal text-white/35">
                          {record().logs.length + record().terminalOutput.length} events
                        </span>
                      </summary>
                      <div class="max-h-[260px] overflow-auto border-t border-[color:var(--vx-line)] px-4 py-3 font-mono text-[10.5px] leading-5 text-white/52">
                        <For each={[...record().logs.slice(0, 40), ...record().terminalOutput.slice(0, 80)]}>
                          {(line) => (
                            <div class="whitespace-pre-wrap break-words border-b border-white/[0.025] py-0.5 last:border-0">
                              {line}
                            </div>
                          )}
                        </For>
                      </div>
                    </details>
                  </Show>

                  {renderDiffReview(record)}
                </div>

                <footer class="flex shrink-0 items-center gap-2 border-t border-[color:var(--vx-line)] px-5 py-3.5">
                  <button
                    type="button"
                    class="h-9 rounded-[10px] border border-[color:var(--vx-line)] px-3 text-[12px] text-white/58 transition hover:bg-white/[0.05] hover:text-white"
                    onClick={() =>
                      record().runtime === "vector"
                        ? openParallelWorkspace(record())
                        : void refreshParallelWorkspace(record().id)
                    }
                  >
                    {record().runtime === "vector" ? "Open agent" : "Refresh activity"}
                  </button>
                  <Show when={isParallelWorkspaceRunning(record())}>
                    <button
                      type="button"
                      class="h-9 rounded-[10px] border border-rose-400/25 px-3 text-[12px] text-rose-200 transition hover:bg-rose-400/[0.08]"
                      onClick={() => void stopParallelWorkspace(record().id)}
                    >
                      Stop
                    </button>
                  </Show>
                  <Show when={record().pullRequestUrl}>
                    <a
                      href={record().pullRequestUrl}
                      target="_blank"
                      rel="noreferrer"
                      class="inline-flex h-9 items-center rounded-[10px] border border-[color:var(--vx-line)] px-3 text-[12px] text-white/65 transition hover:bg-white/[0.05] hover:text-white"
                    >
                      View PR
                    </a>
                  </Show>
                  <div class="flex-1" />
                  <Show when={record().mergeState === "none" && !isParallelWorkspaceRunning(record())}>
                    <Show when={record().isolation === "git-worktree" && !record().pullRequestUrl}>
                      <button
                        type="button"
                        class="h-9 rounded-[10px] border border-[color:var(--vx-line)] px-3 text-[12px] text-white/58 transition hover:bg-white/[0.05] hover:text-white disabled:opacity-40"
                        disabled={!record().changedFilesCount || parallelBusy()}
                        onClick={() => confirmTwice(`pr-${record().id}`, () => void openWorkspacePullRequest(record()))}
                      >
                        {armedAction() === `pr-${record().id}` ? "Confirm GitHub PR" : "Open PR"}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="h-9 rounded-[10px] px-3 text-[12px] text-white/48 transition hover:bg-white/[0.05] hover:text-rose-200"
                      onClick={() =>
                        confirmTwice(`discard-${record().id}`, () => void discardParallelWorkspace(record()))
                      }
                    >
                      {armedAction() === `discard-${record().id}` ? "Confirm discard" : "Discard"}
                    </button>
                    <button
                      data-vector-merge-action
                      type="button"
                      class="h-9 rounded-[10px] bg-emerald-300 px-4 text-[12px] font-semibold text-[#08110c] transition hover:bg-emerald-200 disabled:opacity-40"
                      disabled={!record().changedFilesCount || parallelBusy()}
                      onClick={() => confirmTwice(`merge-${record().id}`, () => void mergeParallelWorkspace(record()))}
                    >
                      {parallelBusy()
                        ? "Merging…"
                        : armedAction() === `merge-${record().id}`
                          ? "Confirm merge"
                          : "Merge all"}
                    </button>
                  </Show>
                </footer>
              </section>
            </div>
          )
        }}
      </Show>

      <Show when={orchestrationOpen()}>
        <div
          class="fixed inset-0 z-[158] flex justify-end bg-black/38 backdrop-blur-[2px]"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setOrchestrationOpen(false)
          }}
        >
          <section class="flex h-full w-[min(920px,94vw)] flex-col border-l border-[color:var(--vx-line)] bg-[#202023] shadow-[-28px_0_90px_rgba(0,0,0,0.48)]">
            <header class="flex shrink-0 items-start gap-3 border-b border-[color:var(--vx-line)] px-5 py-4">
              <div class="min-w-0 flex-1">
                <h2 class="text-[15px] font-semibold text-white">Multi-agent orchestration</h2>
                <p class="mt-1 text-[12px] text-white/46">
                  Vector decomposes one objective, schedules dependencies, and integrates validated results in an
                  isolated staging worktree.
                </p>
              </div>
              <button
                type="button"
                class="h-8 rounded-[9px] bg-[color:var(--vx-purple)] px-3 text-[11.5px] font-semibold text-white transition hover:brightness-110"
                onClick={() => {
                  setParallelLaunchMode("swarm")
                  setOrchestrationOpen(false)
                  setParallelComposerOpen(true)
                }}
              >
                New coordinated run
              </button>
              <button
                type="button"
                class="grid size-8 place-items-center rounded-[9px] text-white/42 transition hover:bg-white/[0.07] hover:text-white"
                onClick={() => setOrchestrationOpen(false)}
                aria-label="Close orchestration"
                title="Close"
              >
                <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                  <path
                    d="m4.5 4.5 7 7m0-7-7 7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.35"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </header>
            <div class="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)]">
              <aside class="min-h-0 overflow-y-auto border-r border-[color:var(--vx-line)] p-3">
                <Show when={agentTabRecords().length}>
                  <div class="mb-4">
                    <div class="mb-1.5 px-2 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-white/30">
                      Agent workspaces
                    </div>
                    <div class="space-y-1">
                      <For each={agentTabRecords()}>
                        {(record) => {
                          const stats = () => parallelDiffStats(record)
                          return (
                            <div class="group/agentrow rounded-[10px] transition hover:bg-white/[0.05]">
                              <button
                                type="button"
                                class="w-full rounded-[10px] px-3 py-2.5 text-left"
                                onClick={() => openAgentByID(record.id)}
                              >
                                <div class="flex items-center gap-2">
                                  <span
                                    class={`size-1.5 shrink-0 rounded-full ${["running", "queued", "planning", "editing", "running commands", "testing"].includes(liveAgentStatus(record)) ? "animate-pulse bg-[color:var(--vx-purple-bright)]" : liveAgentStatus(record) === "waiting for approval" ? "bg-amber-300" : record.status === "failed" ? "bg-rose-400" : record.status === "needs review" || record.status === "complete" ? "bg-amber-300" : "bg-emerald-400"}`}
                                  />
                                  <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-white/76">
                                    {record.name}
                                  </span>
                                  <span class="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
                                    <span class="text-emerald-400/80">+{stats().added}</span>
                                    <span class="text-rose-400/80">-{stats().removed}</span>
                                  </span>
                                </div>
                                <div class="mt-1 flex items-center gap-1.5 pl-3.5 text-[10.5px] text-white/38">
                                  <span class="shrink-0">{parallelRuntimeLabel(record.runtime)}</span>
                                  <span class="text-white/18">·</span>
                                  <span class="shrink-0 tabular-nums">{record.changedFilesCount} files</span>
                                  <Show when={record.teamId}>
                                    <span class="text-white/18">·</span>
                                    <span class="shrink-0">shared</span>
                                  </Show>
                                </div>
                                <div class="mt-0.5 truncate pl-3.5 text-[10.5px] text-white/30">
                                  {parallelWorkspaceCurrentStep(record)}
                                </div>
                              </button>
                              <Show when={record.changedFilesCount > 0 && record.mergeState === "none"}>
                                <div class="hidden px-3 pb-2 pl-[26px] group-hover/agentrow:block">
                                  <button
                                    type="button"
                                    class="rounded-[7px] border border-[color:var(--vx-line)] px-2 py-1 text-[10px] font-medium text-white/62 transition hover:bg-white/[0.07] hover:text-white"
                                    onClick={() => {
                                      setOrchestrationOpen(false)
                                      openAgentReviewByID(record.id)
                                    }}
                                  >
                                    Review &amp; merge
                                  </button>
                                </div>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                  <div class="mb-2 border-t border-[color:var(--vx-line)] pt-3 px-2 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-white/30">
                    Coordinated runs
                  </div>
                </Show>
                <Show
                  when={swarmRuns().length}
                  fallback={
                    <div class="px-3 py-8 text-center text-[12px] leading-5 text-white/38">
                      No coordinated runs yet.
                      <br />
                      Start one objective and Vector will assign the work.
                    </div>
                  }
                >
                  <div class="space-y-1">
                    <For each={swarmRuns()}>
                      {(run) => (
                        <button
                          type="button"
                          class="w-full rounded-[10px] px-3 py-2.5 text-left transition hover:bg-white/[0.05]"
                          classList={{ "bg-white/[0.07]": swarmSelectedID() === run.id }}
                          onClick={() => openSwarmRun(run)}
                        >
                          <div class="flex items-center gap-2">
                            <span
                              class={`size-1.5 shrink-0 rounded-full ${isSwarmRunning(run) ? "animate-pulse bg-[color:var(--vx-purple-bright)]" : run.status === "failed" ? "bg-rose-400" : run.status === "needs review" ? "bg-amber-300" : "bg-emerald-400"}`}
                            />
                            <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-white/76">
                              {run.name}
                            </span>
                            <span class="text-[10px] text-white/30">{run.progress}%</span>
                          </div>
                          <div class="mt-1 truncate pl-3.5 text-[10.5px] text-white/38">{run.currentStep}</div>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </aside>
              <main class="min-h-0 overflow-y-auto p-5">
                <Show
                  when={selectedSwarmRun()}
                  fallback={
                    <div class="grid h-full place-items-center text-center text-[12px] leading-5 text-white/38">
                      Select a run to inspect its agents, dependencies, and merge result.
                    </div>
                  }
                >
                  {(selected) => {
                    const run = () => selected()
                    return (
                      <div class="space-y-4">
                        <div>
                          <div class="flex items-center gap-2">
                            <h3 class="text-[16px] font-semibold text-white">{run().name}</h3>
                            <span
                              class={`rounded-full border px-2 py-0.5 text-[10.5px] ${swarmStatusTone(run().status)}`}
                            >
                              {parallelStatusLabel(run().status)}
                            </span>
                          </div>
                          <p class="mt-2 text-[12.5px] leading-5 text-white/62">{run().objective}</p>
                          <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                            <div
                              class="h-full rounded-full bg-[linear-gradient(90deg,var(--vx-purple),#c7a6ff)] transition-[width] duration-500"
                              style={{ width: `${run().progress}%` }}
                            />
                          </div>
                        </div>
                        <div class="space-y-2">
                          <For each={run().tasks}>
                            {(task) => (
                              <div class="rounded-[11px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-3">
                                <div class="flex items-center gap-2">
                                  <span class={`size-1.5 shrink-0 rounded-full ${swarmTaskMarker(task.status)}`} />
                                  <strong class="min-w-0 flex-1 truncate text-[12px] font-medium text-white/78">
                                    {task.title}
                                  </strong>
                                  <span class="rounded-full bg-white/[0.045] px-2 py-0.5 text-[9.5px] uppercase text-white/38">
                                    {task.role}
                                  </span>
                                </div>
                                <p class="mt-1.5 pl-3.5 text-[11px] leading-5 text-white/42">{task.lastAction}</p>
                                <Show when={task.workspaceId}>
                                  <button
                                    type="button"
                                    class="mt-2 ml-3.5 text-[10.5px] text-[color:var(--vx-purple-bright)] hover:text-white"
                                    onClick={() => openAgentByID(task.workspaceId!)}
                                  >
                                    Open workspace →
                                  </button>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                        <Show when={run().diff && run().status === "needs review"}>
                          <ParallelDiffReview
                            diff={run().diff}
                            onMergeSelection={(selection) => mergeSwarmSelection(run().id, selection)}
                          />
                        </Show>
                        <div class="flex items-center gap-2 border-t border-[color:var(--vx-line)] pt-4">
                          <Show when={isSwarmRunning(run())}>
                            <button
                              type="button"
                              class="h-9 rounded-[10px] border border-rose-400/25 px-3 text-[12px] text-rose-200"
                              onClick={() => void stopSwarm(run().id)}
                            >
                              Stop run
                            </button>
                          </Show>
                          <Show when={["failed", "canceled", "interrupted"].includes(run().status)}>
                            <button
                              type="button"
                              class="h-9 rounded-[10px] border border-[color:var(--vx-line)] px-3 text-[12px] text-white/62"
                              onClick={() => void resumeSwarm(run().id)}
                            >
                              Resume
                            </button>
                          </Show>
                          <div class="flex-1" />
                          <Show when={run().status === "needs review"}>
                            <button
                              type="button"
                              class="h-9 rounded-[10px] px-3 text-[12px] text-white/48 hover:text-rose-200"
                              onClick={() =>
                                confirmTwice(`discard-swarm-${run().id}`, () => void discardSwarm(run().id))
                              }
                            >
                              {armedAction() === `discard-swarm-${run().id}` ? "Confirm discard" : "Discard"}
                            </button>
                            <button
                              type="button"
                              class="h-9 rounded-[10px] bg-emerald-300 px-4 text-[12px] font-semibold text-[#08110c]"
                              onClick={() => confirmTwice(`merge-swarm-${run().id}`, () => void mergeSwarm(run().id))}
                            >
                              {armedAction() === `merge-swarm-${run().id}` ? "Confirm merge" : "Merge result"}
                            </button>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </Show>
              </main>
            </div>
          </section>
        </div>
      </Show>

      <Show when={false && (parallelOpen() || parallelWorkspacesRoute())}>
        <section
          data-vector-workspace="parallel-workspaces"
          class="vector-fullscreen-workspace fixed inset-0 z-[130] flex min-h-0 overflow-hidden bg-[color-mix(in_srgb,var(--vx-canvas)_92%,transparent)] text-[#f5f3ff]"
        >
          <aside class="flex min-h-0 w-[328px] shrink-0 flex-col overflow-hidden border-r border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-sidebar)_88%,transparent)] backdrop-blur-2xl">
            <div
              class="flex h-[64px] shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] px-4"
              style={{ "padding-left": macDesktop() ? "84px" : undefined }}
            >
              <button
                type="button"
                class="grid size-9 place-items-center rounded-[10px] text-white/65 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06] hover:text-white"
                title="Back to Vector"
                aria-label="Back to Vector"
                onClick={closeFullscreenWorkspace}
              >
                <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                  <path
                    d="M9.75 3.75 5.5 8l4.25 4.25"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.45"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <img src="/vector-logo.png" alt="" class="size-8 rounded-[10px] object-cover" draggable={false} />
              <div class="min-w-0">
                <div class="truncate text-[13px] font-semibold text-white">Agent Workspace</div>
                <div class="truncate text-[10.5px] text-white/45">Isolated agents and automatic swarms</div>
              </div>
              <div class="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  class="grid size-8 place-items-center rounded-[9px] text-white/55 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06] hover:text-white"
                  title="Refresh workspaces"
                  aria-label="Refresh workspaces"
                  onClick={() => void loadParallelWorkspaces()}
                >
                  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                    <path
                      d="M12.4 7.15A4.5 4.5 0 0 0 4.8 4.2L3.5 5.5M3.6 8.85a4.5 4.5 0 0 0 7.6 2.95l1.3-1.3M3.5 2.9v2.6h2.6M12.5 13.1v-2.6H9.9"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.25"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  class="grid size-8 place-items-center rounded-[9px] text-white/70 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06] hover:text-white"
                  title="Launch parallel work"
                  aria-label="Launch parallel work"
                  onClick={() => setParallelComposerOpen(true)}
                >
                  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                    <path
                      d="M8 3.25v9.5M3.25 8h9.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.35"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <label class="vx-input-quiet mb-3 flex h-9 items-center gap-2 rounded-full border px-3.5 text-white/50 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] focus-within:text-white/65">
                <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                  <path
                    d="M7.25 12.25a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm3.6-1.4 2.9 2.9"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                  />
                </svg>
                <input
                  class="vx-input-ghost min-w-0 flex-1 text-[12.5px] text-white outline-none placeholder:text-white/45"
                  placeholder="Search agent chats"
                  value={parallelFilter()}
                  onInput={(event) => setParallelFilter(event.currentTarget.value)}
                />
              </label>

              <Show when={parallelError() && !parallelComposerOpen()}>
                <div class="mb-3 rounded-[12px] border border-rose-400/25 bg-rose-400/[0.08] px-3 py-2 text-[12px] leading-5 text-rose-200">
                  {parallelError()}
                </div>
              </Show>

              <Show when={parallelComposerOpen()}>
                <form
                  class="mb-4 rounded-[16px] border border-[color:var(--vx-line)] bg-white/[0.03] p-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitParallelLaunch()
                  }}
                >
                  <div class="mb-3 flex items-center justify-between">
                    <div>
                      <div class="font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[color:var(--vx-purple-bright)]/80">
                        {parallelLaunchMode() === "swarm" ? "Automatic swarm" : "New agent chat"}
                      </div>
                      <div class="mt-1 text-[12px] text-white/55">
                        {parallelLaunchMode() === "swarm"
                          ? "One objective. Vector plans and coordinates the work."
                          : "Same Vector experience, isolated files."}
                      </div>
                    </div>
                    <button
                      type="button"
                      class="grid size-7 place-items-center rounded-[9px] text-white/50 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06] hover:text-white"
                      onClick={() => setParallelComposerOpen(false)}
                      title="Close launcher"
                      aria-label="Close launcher"
                    >
                      <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                        <path
                          d="m4.5 4.5 7 7M11.5 4.5l-7 7"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.35"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </div>
                  <div class="space-y-2">
                    <div class="grid grid-cols-2 rounded-[11px] border border-[color:var(--vx-line)] bg-black/20 p-1">
                      <button
                        type="button"
                        class="rounded-[8px] px-3 py-2 text-[12px] font-medium transition-colors duration-200"
                        classList={{
                          "bg-white/[0.09] text-white": parallelLaunchMode() === "agent",
                          "text-white/48 hover:text-white/75": parallelLaunchMode() !== "agent",
                        }}
                        onClick={() => setParallelLaunchMode("agent")}
                      >
                        Single agent
                      </button>
                      <button
                        type="button"
                        class="rounded-[8px] px-3 py-2 text-[12px] font-medium transition-colors duration-200"
                        classList={{
                          "bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]":
                            parallelLaunchMode() === "swarm",
                          "text-white/48 hover:text-white/75": parallelLaunchMode() !== "swarm",
                        }}
                        onClick={() => setParallelLaunchMode("swarm")}
                      >
                        Agent swarm
                      </button>
                    </div>
                    <input
                      class="vx-input-quiet h-10 w-full rounded-[10px] border px-3 text-[13px] text-white outline-none placeholder:text-white/40"
                      placeholder={parallelLaunchMode() === "swarm" ? "Swarm name (optional)" : "Chat name"}
                      value={parallelName()}
                      onInput={(event) => setParallelName(event.currentTarget.value)}
                    />
                    <textarea
                      ref={parallelPromptRef}
                      class="vx-input-quiet min-h-[110px] w-full resize-none rounded-[12px] border px-3 py-3 text-[13px] leading-5 text-white outline-none placeholder:text-white/40"
                      placeholder={
                        parallelLaunchMode() === "swarm"
                          ? "Describe the outcome. Vector will decompose, assign, validate, and integrate the work."
                          : "What should this agent build, fix, or investigate?"
                      }
                      value={parallelPrompt()}
                      onInput={(event) => setParallelPrompt(event.currentTarget.value)}
                    />
                    <Show
                      when={parallelModelOptions().length > 0}
                      fallback={
                        <button
                          type="button"
                          class="flex h-11 w-full items-center justify-between rounded-[10px] border border-[color:var(--vx-purple)]/40 bg-[color:var(--vx-purple-soft)] px-3 text-[13px] font-medium text-[color:var(--vx-purple-bright)] transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-[rgba(147,116,236,0.2)]"
                          onClick={openProviderSettings}
                        >
                          <span>No AI provider connected yet</span>
                          <span class="text-[12px] text-[color:var(--vx-purple-bright)]">Connect a provider →</span>
                        </button>
                      }
                    >
                      <ModelSelectorPopoverV2 model={parallelModelState}>
                        <button
                          type="button"
                          class="flex h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.03] px-3 text-[13px] text-white transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:border-[color:var(--vx-purple)]/50 hover:bg-white/[0.05]"
                        >
                          <span class="min-w-0 truncate text-left">
                            {(() => {
                              const current = parallelModelState.current()
                              return current ? current.name : "Choose model"
                            })()}
                          </span>
                          <span class="flex shrink-0 items-center gap-1.5 text-white/40">
                            <span class="text-[11px]">{parallelModelState.current()?.provider.name ?? ""}</span>
                            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                              <path
                                d="m4.5 6.5 3.5 3.5 3.5-3.5"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.35"
                                stroke-linecap="round"
                              />
                            </svg>
                          </span>
                        </button>
                      </ModelSelectorPopoverV2>
                    </Show>
                    <Show when={parallelLaunchMode() === "swarm"}>
                      <div class="grid grid-cols-2 gap-2">
                        <label class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2">
                          <span class="block text-[10.5px] font-medium uppercase tracking-[0.08em] text-white/38">
                            Routing
                          </span>
                          <select
                            class="mt-1 w-full bg-transparent text-[12.5px] text-white/78 outline-none"
                            value={swarmStrategy()}
                            onChange={(event) => {
                              const value = event.currentTarget.value
                              if (value === "economy" || value === "balanced" || value === "quality")
                                setSwarmStrategy(value)
                            }}
                          >
                            <option value="economy">Economy</option>
                            <option value="balanced">Balanced</option>
                            <option value="quality">Quality</option>
                          </select>
                        </label>
                        <label class="rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2">
                          <span class="block text-[10.5px] font-medium uppercase tracking-[0.08em] text-white/38">
                            Max work items
                          </span>
                          <input
                            type="number"
                            min="2"
                            max="32"
                            class="mt-1 w-full bg-transparent text-[12.5px] text-white/78 outline-none"
                            value={swarmMaxAgents()}
                            onInput={(event) =>
                              setSwarmMaxAgents(Math.max(2, Math.min(32, Number(event.currentTarget.value) || 2)))
                            }
                          />
                        </label>
                        <label class="col-span-2 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.025] px-3 py-2">
                          <span class="flex items-center justify-between text-[10.5px] font-medium uppercase tracking-[0.08em] text-white/38">
                            <span>Concurrent workers</span>
                            <span class="text-[color:var(--vx-purple-bright)]">{swarmConcurrency()}</span>
                          </span>
                          <input
                            type="range"
                            min="1"
                            max={Math.min(16, swarmMaxAgents())}
                            class="mt-2 w-full accent-[color:var(--vx-purple)]"
                            value={Math.min(swarmConcurrency(), swarmMaxAgents())}
                            onInput={(event) =>
                              setSwarmConcurrency(Math.max(1, Math.min(16, Number(event.currentTarget.value) || 1)))
                            }
                          />
                        </label>
                      </div>
                      <div class="rounded-[10px] border border-amber-300/15 bg-amber-300/[0.05] px-3 py-2 text-[11.5px] leading-5 text-amber-100/70">
                        Parallel agents can multiply BYOK usage. Vector routes simpler work to lighter connected models
                        and reserves stronger models for complex or high-risk work.
                      </div>
                    </Show>
                    <div class="px-1 text-[11.5px] leading-5 text-white/45">
                      {parallelLaunchMode() === "swarm"
                        ? "Workers merge validated results into a hidden staging workspace. Your main files remain unchanged until you approve the aggregate diff."
                        : "This agent receives its own isolated copy of the current project. Your main files stay unchanged until you review and merge."}
                    </div>
                    <Show when={parallelError()}>
                      <div class="rounded-[10px] border border-rose-400/25 bg-rose-400/[0.08] px-3 py-2 text-[12px] leading-5 text-rose-200">
                        {parallelError()}
                      </div>
                    </Show>
                    <button
                      type="submit"
                      class="vx-pill flex h-10 w-full items-center justify-center bg-[linear-gradient(180deg,#efe6ff,#cdb2ff)] text-sm font-semibold text-[#0b0712] shadow-[0_10px_36px_rgba(124,92,230,0.32),inset_0_1px_0_rgba(255,255,255,0.6)] transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:-translate-y-px hover:shadow-[0_14px_46px_rgba(124,92,230,0.38),0_5px_24px_rgba(170,145,243,0.18),inset_0_1px_0_rgba(255,255,255,0.6)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={parallelBusy()}
                    >
                      {parallelBusy()
                        ? parallelLaunchMode() === "swarm"
                          ? "Launching swarm..."
                          : "Creating agent chat..."
                        : parallelLaunchMode() === "swarm"
                          ? "Launch automatic swarm"
                          : "Create chat with agent"}
                    </button>
                  </div>
                </form>
              </Show>
              <Show when={filteredSwarmRuns().length}>
                <div class="mb-4">
                  <div class="mb-1.5 flex items-center gap-2 px-1">
                    <span class="relative grid size-2 place-items-center">
                      <span class="absolute size-2 animate-ping rounded-full bg-[color:var(--vx-purple-bright)]/30" />
                      <span class="relative size-2 rounded-full bg-[color:var(--vx-purple-bright)]" />
                    </span>
                    <span class="text-[12.5px] font-semibold text-white/75">Automatic Swarms</span>
                    <span class="text-[11px] text-white/40">{filteredSwarmRuns().length}</span>
                  </div>
                  <div class="space-y-1">
                    <For each={filteredSwarmRuns()}>
                      {(run) => (
                        <button
                          type="button"
                          class="w-full rounded-[11px] border border-transparent px-3 py-2.5 text-left transition-colors duration-200 hover:border-[color:var(--vx-line)] hover:bg-white/[0.045]"
                          classList={{ "border-[color:var(--vx-line)] bg-white/[0.07]": swarmSelectedID() === run.id }}
                          onClick={() => openSwarmRun(run)}
                        >
                          <span class="flex items-center gap-2">
                            <span class="relative grid size-5 shrink-0 place-items-center rounded-[7px] bg-[color:var(--vx-purple-soft)] text-[color:var(--vx-purple-bright)]">
                              <Show when={isSwarmRunning(run)}>
                                <span class="absolute size-2 animate-ping rounded-full bg-[color:var(--vx-purple-bright)]/50" />
                              </Show>
                              <svg viewBox="0 0 16 16" class="relative size-3" aria-hidden="true">
                                <circle cx="4" cy="4" r="1.5" fill="currentColor" />
                                <circle cx="12" cy="4" r="1.5" fill="currentColor" />
                                <circle cx="8" cy="12" r="1.5" fill="currentColor" />
                                <path
                                  d="M5.4 4.7 7.2 10.5M10.6 4.7 8.8 10.5M5.5 4h5"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="1"
                                />
                              </svg>
                            </span>
                            <span class="min-w-0 flex-1">
                              <span class="block truncate text-[13px] font-medium text-white/82">{run.name}</span>
                              <span class="mt-0.5 block truncate text-[11px] text-white/48">{run.currentStep}</span>
                            </span>
                            <span class="shrink-0 text-[10.5px] font-semibold text-white/38">{run.progress}%</span>
                          </span>
                          <span class="mt-2 block h-1 overflow-hidden rounded-full bg-white/[0.06]">
                            <span
                              class="block h-full rounded-full bg-[color:var(--vx-purple)] transition-[width] duration-500"
                              style={{ width: `${run.progress}%` }}
                            />
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
              <Show
                when={parallelRecords().length > 0}
                fallback={
                  <Show when={!swarmRuns().length}>
                    <button
                      type="button"
                      class="mt-2 w-full rounded-[14px] border border-dashed border-[color:var(--vx-line)] px-4 py-5 text-left transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:border-[color:var(--vx-purple)]/40 hover:bg-[rgba(147,116,236,0.06)]"
                      onClick={() => setParallelComposerOpen(true)}
                    >
                      <span class="block text-[13px] font-semibold text-white/75">No parallel work yet.</span>
                      <span class="mt-1 block text-[12px] leading-5 text-white/55">
                        Launch one isolated agent or give Vector an objective to orchestrate automatically.
                      </span>
                    </button>
                  </Show>
                }
              >
                <Show when={parallelFilteredCount() === 0}>
                  <div class="mt-2 rounded-[14px] border border-dashed border-[color:var(--vx-line)] px-4 py-5 text-left">
                    <span class="block text-[13px] font-semibold text-white/75">
                      No workspaces match "{parallelFilter()}"
                    </span>
                    <span class="mt-1 block text-[12px] leading-5 text-white/55">
                      Try a different search, or clear it to see everything.
                    </span>
                    <button
                      type="button"
                      class="mt-3 rounded-full border border-[color:var(--vx-line)] px-3 py-1.5 text-[12px] font-medium text-white/70 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06] hover:text-white"
                      onClick={() => setParallelFilter("")}
                    >
                      Clear search
                    </button>
                  </div>
                </Show>
                <For each={parallelWorkspaceGroups()}>
                  {(group) => (
                    <Show when={group.records.length}>
                      <div class="mb-4">
                        <div class="mb-1.5 flex items-center gap-2 px-1">
                          <span class={`size-2 rounded-full ${group.marker}`} />
                          <span class="text-[12.5px] font-semibold text-white/75">
                            {group.id === "review"
                              ? "In Review"
                              : group.id === "progress"
                                ? "In Progress"
                                : group.label}
                          </span>
                          <span class="text-[11px] text-white/40">{group.records.length}</span>
                        </div>
                        <div class="space-y-0.5">
                          <For each={group.records}>
                            {(record) => {
                              const stats = parallelDiffStats(record)
                              const removable = () =>
                                !isParallelWorkspaceRunning(record) &&
                                (record.mergeState !== "none" ||
                                  ["failed", "stopped"].includes(record.status) ||
                                  (record.status === "complete" && !record.changedFilesCount))
                              return (
                                <div
                                  class="group/wsrow relative rounded-[10px] transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.05]"
                                  classList={{ "bg-white/[0.07]": parallelSelectedID() === record.id }}
                                >
                                  <button
                                    type="button"
                                    class="grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2 text-left text-[13px]"
                                    onClick={() => openParallelWorkspace(record)}
                                  >
                                    <span class="relative grid size-[18px] place-items-center rounded-[6px] bg-white/[0.06] text-white/70">
                                      {isParallelWorkspaceRunning(record) ? (
                                        <span class="absolute size-2 animate-ping rounded-full bg-[color:var(--vx-purple-bright)]/50" />
                                      ) : null}
                                      <svg viewBox="0 0 16 16" class="relative size-2.5" aria-hidden="true">
                                        <path
                                          d="M4.25 3.25v6.4a2.1 2.1 0 0 0 2.1 2.1h2.4M4.25 3.25a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2Zm7.5 8.5a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm0 0V5.65a2.1 2.1 0 0 0-2.1-2.1h-1.9"
                                          fill="none"
                                          stroke="currentColor"
                                          stroke-width="1.3"
                                          stroke-linecap="round"
                                          stroke-linejoin="round"
                                        />
                                      </svg>
                                    </span>
                                    <span class="min-w-0">
                                      <span class="block truncate font-medium text-white/80">{record.name}</span>
                                      <span class="mt-0.5 block truncate text-[11px] text-white/50">
                                        {workspaceBackgroundTask(record)?.currentStep ||
                                          parallelWorkspaceCurrentStep(record)}
                                      </span>
                                    </span>
                                    <span class="flex shrink-0 items-center gap-1.5 text-[11.5px]">
                                      <span class="text-emerald-400">+{stats.added}</span>
                                      <span class="text-rose-400">-{stats.removed}</span>
                                    </span>
                                  </button>
                                  <Show when={removable()}>
                                    <button
                                      type="button"
                                      class="absolute right-1.5 top-1.5 hidden size-6 place-items-center rounded-[7px] bg-white/[0.08] text-white/45 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:text-rose-300 group-hover/wsrow:grid"
                                      title={
                                        armedAction() === `remove-${record.id}`
                                          ? "Click again to remove"
                                          : "Remove from list"
                                      }
                                      aria-label={
                                        armedAction() === `remove-${record.id}`
                                          ? "Click again to remove workspace"
                                          : "Remove workspace from list"
                                      }
                                      classList={{ "!grid text-rose-300": armedAction() === `remove-${record.id}` }}
                                      onClick={() =>
                                        confirmTwice(`remove-${record.id}`, () => void removeParallelWorkspace(record))
                                      }
                                    >
                                      <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                                        <path
                                          d="m4.5 4.5 7 7M11.5 4.5l-7 7"
                                          fill="none"
                                          stroke="currentColor"
                                          stroke-width="1.35"
                                          stroke-linecap="round"
                                        />
                                      </svg>
                                    </button>
                                  </Show>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    </Show>
                  )}
                </For>
              </Show>
            </div>

            <div class="shrink-0 border-t border-[color:var(--vx-line)] p-3">
              <button
                type="button"
                class="flex h-10 w-full items-center justify-center gap-2 rounded-[10px] bg-white/[0.06] text-sm font-medium text-white/78 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.1] hover:text-white"
                onClick={() => setParallelComposerOpen(true)}
              >
                <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                  <path
                    d="M8 3.25v9.5M3.25 8h9.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.35"
                    stroke-linecap="round"
                  />
                </svg>
                Launch parallel work
              </button>
            </div>
          </aside>

          <main class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[color-mix(in_srgb,var(--vx-canvas)_92%,transparent)]">
            <Show when={selectedSwarmRun()}>
              {(selected) => {
                const run = () => selected()
                const completed = () => run().tasks.filter((task) => task.status === "complete").length
                const active = () =>
                  run().tasks.filter((task) => ["creating", "queued", "running", "merging"].includes(task.status))
                    .length
                return (
                  <div class="flex h-full min-h-0 flex-col">
                    <header class="flex h-[64px] shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] px-5">
                      <div class="min-w-0 flex-1">
                        <div class="flex min-w-0 items-center gap-2">
                          <div class="truncate text-[15px] font-semibold text-white">{run().name}</div>
                          <span
                            class={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${swarmStatusTone(run().status)}`}
                          >
                            {parallelStatusLabel(run().status)}
                          </span>
                          <Show when={isSwarmRunning(run())}>
                            <span class="size-1.5 animate-pulse rounded-full bg-[color:var(--vx-purple-bright)]" />
                          </Show>
                        </div>
                        <div class="mt-0.5 truncate text-[11.5px] text-white/50">
                          {run().strategy} routing · {run().maxConcurrency} concurrent · up to {run().maxAgents} planned
                          work items
                        </div>
                      </div>
                      <Show when={isSwarmRunning(run())}>
                        <button
                          type="button"
                          class="h-9 rounded-[10px] border border-rose-400/35 bg-rose-400/[0.08] px-3 text-[12px] font-medium text-rose-200 transition-colors duration-200 hover:bg-rose-400/[0.16]"
                          onClick={() => void stopSwarm(run().id)}
                        >
                          Stop swarm
                        </button>
                      </Show>
                      <Show when={["failed", "canceled", "interrupted"].includes(run().status)}>
                        <button
                          type="button"
                          class="h-9 rounded-[10px] bg-[color:var(--vx-purple)] px-3 text-[12px] font-semibold text-white transition-colors duration-200 hover:brightness-110"
                          onClick={() => void resumeSwarm(run().id)}
                        >
                          Resume
                        </button>
                      </Show>
                      <Show when={run().status === "needs review" && run().changedFiles.length}>
                        <button
                          type="button"
                          class="h-9 rounded-[10px] bg-emerald-300 px-3 text-[12px] font-semibold text-[#07110c] transition-colors duration-200 hover:bg-emerald-200"
                          onClick={() => confirmTwice(`merge-swarm-${run().id}`, () => void mergeSwarm(run().id))}
                        >
                          {armedAction() === `merge-swarm-${run().id}` ? "Confirm merge" : "Merge aggregate"}
                        </button>
                      </Show>
                      <Show when={!isSwarmRunning(run()) && !["merged", "discarded"].includes(run().status)}>
                        <button
                          type="button"
                          class="h-9 rounded-[10px] border border-[color:var(--vx-line)] px-3 text-[12px] font-medium text-white/58 transition-colors duration-200 hover:border-rose-400/25 hover:text-rose-200"
                          onClick={() => confirmTwice(`discard-swarm-${run().id}`, () => void discardSwarm(run().id))}
                        >
                          {armedAction() === `discard-swarm-${run().id}` ? "Confirm discard" : "Discard"}
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="flex h-9 items-center gap-2 rounded-[10px] border border-[color:var(--vx-line)] px-3 text-xs font-medium text-white/65 transition-colors duration-200 hover:bg-white/[0.06] hover:text-white"
                        onClick={closeFullscreenWorkspace}
                      >
                        <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                          <path
                            d="M9.75 3.75 5.5 8l4.25 4.25"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.45"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        Back to Vector
                      </button>
                    </header>

                    <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                      <div class="mx-auto max-w-[1080px] space-y-4">
                        <section class="overflow-hidden rounded-[16px] border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)]">
                          <div class="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_260px]">
                            <div>
                              <div class="font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[color:var(--vx-purple-bright)]/80">
                                Objective
                              </div>
                              <p class="mt-2 text-[14px] leading-6 text-white/85">{run().objective}</p>
                              <p class="mt-3 text-[12.5px] leading-6 text-white/52">
                                {run().planSummary || run().summary}
                              </p>
                            </div>
                            <div class="rounded-[12px] border border-[color:var(--vx-line)] bg-black/20 p-4">
                              <div class="flex items-baseline justify-between">
                                <span class="text-[12px] text-white/48">Verified milestones</span>
                                <span class="text-lg font-semibold text-white">
                                  {completed()} / {run().tasks.length || "—"}
                                </span>
                              </div>
                              <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                                <div
                                  class="h-full rounded-full bg-[linear-gradient(90deg,var(--vx-purple),#c9a8ff)] transition-[width] duration-500"
                                  style={{ width: `${run().progress}%` }}
                                />
                              </div>
                              <div class="mt-3 flex items-center justify-between text-[11px] text-white/42">
                                <span>{active()} active</span>
                                <span>{run().changedFiles.length} staged files</span>
                              </div>
                              <div class="mt-3 border-t border-[color:var(--vx-line)] pt-3 text-[11px] leading-5 text-white/46">
                                Planner: {run().plannerProvider}/{run().plannerModel}
                              </div>
                            </div>
                          </div>
                          <div class="border-t border-[color:var(--vx-line)] bg-white/[0.02] px-5 py-3 text-[12px] text-white/55">
                            <span class="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-[color:var(--vx-purple-bright)] align-middle" />
                            {run().currentStep}
                          </div>
                        </section>

                        <Show when={run().error}>
                          <section class="rounded-[14px] border border-rose-400/25 bg-rose-400/[0.07] px-4 py-3 text-[12.5px] leading-6 text-rose-100/80">
                            <div class="font-semibold text-rose-200">Swarm attention required</div>
                            <pre class="mt-1 whitespace-pre-wrap font-sans">{run().error}</pre>
                          </section>
                        </Show>

                        <section class="rounded-[16px] border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] p-4">
                          <div class="mb-3 flex items-center justify-between px-1">
                            <div>
                              <h2 class="text-[14px] font-semibold text-white/88">Dependency graph</h2>
                              <p class="mt-1 text-[12px] text-white/45">
                                Work unlocks only after every required result has been validated and integrated into
                                staging.
                              </p>
                            </div>
                            <span class="rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/48">
                              {run().tasks.length} work items
                            </span>
                          </div>
                          <Show
                            when={run().tasks.length}
                            fallback={
                              <div class="rounded-[12px] border border-dashed border-[color:var(--vx-line)] px-5 py-8 text-center text-[13px] text-white/48">
                                Vector is reading the repository and designing the execution graph.
                              </div>
                            }
                          >
                            <div class="space-y-2">
                              <For each={run().tasks}>
                                {(task, index) => (
                                  <details class="group rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.025] open:bg-white/[0.04]">
                                    <summary class="grid cursor-pointer list-none grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
                                      <span class="relative grid size-7 place-items-center rounded-[8px] bg-black/25 font-mono text-[10px] text-white/45">
                                        <Show when={["creating", "queued", "running", "merging"].includes(task.status)}>
                                          <span
                                            class={`absolute size-2 animate-ping rounded-full ${swarmTaskMarker(task.status)}`}
                                          />
                                        </Show>
                                        <span
                                          class={`absolute right-0 top-0 size-2 rounded-full ring-2 ring-[#17151d] ${swarmTaskMarker(task.status)}`}
                                        />
                                        {index() + 1}
                                      </span>
                                      <span class="min-w-0">
                                        <span class="flex min-w-0 items-center gap-2">
                                          <span class="truncate text-[13px] font-semibold text-white/78">
                                            {task.title}
                                          </span>
                                          <span class="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium text-white/43">
                                            {task.role}
                                          </span>
                                        </span>
                                        <span class="mt-0.5 block truncate text-[11.5px] text-white/45">
                                          {task.lastAction}
                                        </span>
                                      </span>
                                      <span class="text-right">
                                        <span class="block text-[11px] font-medium text-white/58">
                                          {parallelStatusLabel(task.status)}
                                        </span>
                                        <span class="mt-0.5 block max-w-[180px] truncate text-[10px] text-white/35">
                                          {task.provider}/{task.model}
                                        </span>
                                      </span>
                                    </summary>
                                    <div class="grid gap-3 border-t border-[color:var(--vx-line)] px-4 py-3 text-[12px] leading-5 text-white/52 md:grid-cols-2">
                                      <div>
                                        <div class="text-[10px] font-semibold uppercase tracking-[0.09em] text-white/32">
                                          Assignment
                                        </div>
                                        <p class="mt-1">{task.prompt}</p>
                                      </div>
                                      <div>
                                        <div class="text-[10px] font-semibold uppercase tracking-[0.09em] text-white/32">
                                          Dependencies
                                        </div>
                                        <p class="mt-1">
                                          {task.dependsOn.length ? task.dependsOn.join(" → ") : "Ready immediately"}
                                        </p>
                                        <Show when={task.summary}>
                                          <div class="mt-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-white/32">
                                            Result
                                          </div>
                                          <p class="mt-1">{task.summary}</p>
                                        </Show>
                                        <Show when={task.error}>
                                          <p class="mt-2 text-rose-200/75">{task.error}</p>
                                        </Show>
                                      </div>
                                    </div>
                                  </details>
                                )}
                              </For>
                            </div>
                          </Show>
                        </section>

                        <Show when={run().diff}>
                          <section>
                            <div class="mb-3 flex items-end justify-between px-1">
                              <div>
                                <h2 class="text-[14px] font-semibold text-white/88">Aggregate review</h2>
                                <p class="mt-1 text-[12px] text-white/45">
                                  Every worker result is combined here; main remains unchanged until you approve it.
                                </p>
                              </div>
                              <span class="text-[11px] text-white/42">
                                {run().changedFiles.length} files · {run().riskLevel} risk
                              </span>
                            </div>
                            <ParallelDiffReview
                              diff={run().diff}
                              disabled={isSwarmRunning(run()) || run().status === "merged"}
                              onMergeSelection={(selection) => mergeSwarmSelection(run().id, selection)}
                            />
                          </section>
                        </Show>

                        <details class="rounded-[14px] border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)]">
                          <summary class="cursor-pointer list-none px-4 py-3 text-[13px] font-medium text-white/68">
                            Orchestrator log · {run().logs.length} events
                          </summary>
                          <pre class="max-h-72 overflow-auto border-t border-[color:var(--vx-line)] px-4 py-3 whitespace-pre-wrap font-mono text-[10.5px] leading-5 text-white/42">
                            {run().logs.join("\n")}
                          </pre>
                        </details>
                      </div>
                    </div>
                  </div>
                )
              }}
            </Show>
            <Show
              when={selectedSwarmRun() ? undefined : selectedParallelWorkspace()}
              fallback={
                <div class="grid h-full place-items-center px-8 text-center">
                  <div class="max-w-[520px]">
                    <img
                      src="/vector-logo.png"
                      alt=""
                      class="mx-auto size-14 rounded-[14px] object-cover"
                      draggable={false}
                    />
                    <h2 class="mt-5 text-xl font-semibold text-white">Create a parallel agent chat</h2>
                    <p class="mt-2 text-sm leading-6 text-white/55">
                      Each chat has the same Vector agent experience, its own isolated files, and an explicit review
                      step before anything reaches your main project.
                    </p>
                    <button
                      type="button"
                      class="vx-pill mt-5 bg-[color:var(--vx-purple)] px-4 py-2 text-sm font-semibold text-white transition-transform duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:brightness-110 active:scale-[0.985]"
                      onClick={() => setParallelComposerOpen(true)}
                    >
                      Create chat with agent
                    </button>
                  </div>
                </div>
              }
            >
              {(workspace) => {
                const record = () => workspace()
                const stats = () => parallelDiffStats(record())
                return (
                  <div class="flex h-full min-h-0 flex-col">
                    <header class="flex h-[64px] shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] px-5">
                      <div class="min-w-0 flex-1">
                        <div class="flex min-w-0 items-center gap-2">
                          <div class="truncate text-[15px] font-semibold text-white">{record().name}</div>
                          <span
                            class={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${parallelStatusTone(record().status)}`}
                          >
                            {parallelStatusLabel(record().status)}
                          </span>
                          <Show when={isParallelWorkspaceRunning(record())}>
                            <span class="size-1.5 animate-pulse rounded-full bg-[color:var(--vx-purple-bright)]" />
                          </Show>
                        </div>
                        <div class="mt-0.5 truncate text-[11.5px] text-white/50">
                          {record().gitBranch || record().isolatedPath || "isolated workspace"}
                          <Show when={record().model}> · {record().model}</Show>
                        </div>
                      </div>
                      <Show when={isParallelWorkspaceRunning(record())}>
                        <button
                          type="button"
                          class="h-9 rounded-[10px] border border-rose-400/35 bg-rose-400/[0.08] px-3 text-[12px] font-medium text-rose-200 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-rose-400/[0.16]"
                          onClick={() => void stopParallelWorkspace(record().id)}
                        >
                          Stop
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="grid size-9 place-items-center rounded-[10px] border border-[color:var(--vx-line)] text-white/55 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06] hover:text-white"
                        title="Refresh diff and status"
                        aria-label="Refresh diff and status"
                        onClick={() => void refreshParallelWorkspace(record().id)}
                      >
                        <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                          <path
                            d="M12.4 7.15A4.5 4.5 0 0 0 4.8 4.2L3.5 5.5M3.6 8.85a4.5 4.5 0 0 0 7.6 2.95l1.3-1.3M3.5 2.9v2.6h2.6M12.5 13.1v-2.6H9.9"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.25"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="flex h-9 items-center gap-2 rounded-[10px] border border-[color:var(--vx-line)] px-3 text-xs font-medium text-white/65 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06] hover:text-white"
                        onClick={closeFullscreenWorkspace}
                        title="Back to main Vector"
                      >
                        <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                          <path
                            d="M9.75 3.75 5.5 8l4.25 4.25"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.45"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        Back to Vector
                      </button>
                    </header>

                    <div class="flex h-11 shrink-0 items-center gap-1.5 border-b border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] px-5">
                      <button
                        type="button"
                        class="rounded-[9px] px-3 py-1.5 text-[13px] font-medium transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)]"
                        classList={{
                          "bg-white/[0.08] text-white": parallelDetailTab() === "session",
                          "text-white/60 hover:bg-white/[0.05] hover:text-white/80": parallelDetailTab() !== "session",
                        }}
                        onClick={() => setParallelDetailTab("session")}
                      >
                        Agent Session
                      </button>
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-[9px] px-3 py-1.5 text-[13px] font-medium transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)]"
                        classList={{
                          "bg-white/[0.08] text-white": parallelDetailTab() === "review",
                          "text-white/60 hover:bg-white/[0.05] hover:text-white/80": parallelDetailTab() !== "review",
                        }}
                        onClick={() => setParallelDetailTab("review")}
                      >
                        Review &amp; Merge
                        <Show when={record().changedFilesCount}>
                          <span class="rounded-full bg-[rgba(147,116,236,0.18)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--vx-purple-bright)]">
                            {record().changedFilesCount}
                          </span>
                        </Show>
                      </button>
                    </div>

                    <Show
                      when={parallelDetailTab() === "review"}
                      fallback={
                        <Show
                          when={record().agentSessionId && location.pathname.includes("/server/")}
                          fallback={
                            <div class="grid min-h-0 flex-1 place-items-center px-8 text-center">
                              <div class="max-w-[520px]">
                                <Show
                                  when={record().status === "failed"}
                                  fallback={
                                    <>
                                      <img
                                        src="/vector-logo.png"
                                        alt=""
                                        class="mx-auto size-14 rounded-[14px] object-cover"
                                        draggable={false}
                                      />
                                      <h2 class="mt-5 text-xl font-semibold text-white">
                                        {isParallelWorkspaceRunning(record())
                                          ? "Launching isolated Vector agent"
                                          : "Agent session not started"}
                                      </h2>
                                      <p class="mt-2 text-sm leading-6 text-white/52">
                                        {isParallelWorkspaceRunning(record())
                                          ? "Vector is creating the isolated workspace and opening its full agent session."
                                          : "Run this workspace to start its isolated agent, or open Review & Merge to inspect its current state."}
                                      </p>
                                      <Show
                                        when={!isParallelWorkspaceRunning(record()) && record().mergeState === "none"}
                                      >
                                        <button
                                          type="button"
                                          class="vx-pill mt-5 bg-[color:var(--vx-purple)] px-4 py-2 text-sm font-semibold text-white transition-transform duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:brightness-110 active:scale-[0.985]"
                                          onClick={() => void runParallelWorkspace(record().id)}
                                        >
                                          Run agent
                                        </button>
                                      </Show>
                                    </>
                                  }
                                >
                                  <div class="rounded-[14px] border border-rose-400/25 bg-rose-400/[0.07] p-6 text-left">
                                    <h2 class="text-lg font-semibold text-rose-200">This run failed</h2>
                                    <p class="mt-2 text-[13px] leading-6 text-white/70">
                                      {record().error || record().finalSummary || record().lastAction}
                                    </p>
                                    <div class="mt-4 flex gap-2">
                                      <button
                                        type="button"
                                        class="vx-pill bg-[color:var(--vx-purple)] px-4 py-2 text-sm font-semibold text-white transition-transform duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:brightness-110 active:scale-[0.985]"
                                        onClick={() => void runParallelWorkspace(record().id)}
                                      >
                                        Run again
                                      </button>
                                      <button
                                        type="button"
                                        class="rounded-[10px] border border-[color:var(--vx-line)] px-4 py-2 text-sm text-white/70 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06]"
                                        onClick={() => setParallelDetailTab("review")}
                                      >
                                        Inspect state
                                      </button>
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          }
                        >
                          <div class="min-h-0 flex-1 overflow-hidden">
                            <Suspense>{props.children}</Suspense>
                          </div>
                        </Show>
                      }
                    >
                      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                        <div class="mx-auto max-w-[1050px] space-y-4">
                          <section class="rounded-[14px] border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] p-5">
                            <div class="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-white/55">
                              <span>{record().logs.length} log entries</span>
                              <span>·</span>
                              <span>{record().changedFilesCount} changed files</span>
                              <span>·</span>
                              <span>{formatParallelDate(record().lastActivityAt)}</span>
                              <Show when={isParallelWorkspaceRunning(record())}>
                                <span>·</span>
                                <span class="flex items-center gap-1.5 text-[color:var(--vx-purple-bright)]">
                                  <span class="size-1.5 animate-pulse rounded-full bg-[color:var(--vx-purple-bright)]" />
                                  {workspaceBackgroundTask(record())?.currentStep ||
                                    parallelWorkspaceCurrentStep(record())}
                                </span>
                              </Show>
                            </div>
                            <p class="text-[14px] leading-6 text-white/85">
                              {record().finalSummary ||
                                record().lastAction ||
                                "Vector is preparing this isolated workspace."}
                            </p>
                            <Show when={record().taskPrompt}>
                              <div class="mt-3 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.035] p-3.5 text-[13px] leading-6 text-white/58">
                                {record().taskPrompt}
                              </div>
                            </Show>
                          </section>

                          <Show
                            when={
                              record().mergeState === "none" &&
                              record().changedFilesCount > 0 &&
                              record().isolation === "git-worktree"
                            }
                          >
                            <section class="rounded-[14px] border border-[color:var(--vx-purple)]/25 bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] p-5">
                              <div class="text-[13px] font-semibold text-white/85">Commit all changes to main</div>
                              <p class="mt-1 max-w-2xl text-[12.5px] leading-6 text-white/55">
                                Merges this agent's entire isolated worktree into your main project and records a real
                                git commit. Vector checkpoints main first; you can undo the commit with{" "}
                                <code class="rounded bg-white/[0.06] px-1 text-white/70">git reset --soft HEAD~1</code>.
                              </p>
                              <div class="mt-3 flex flex-wrap items-center gap-2">
                                <input
                                  type="text"
                                  value={effectiveCommitMessage()}
                                  onInput={(event) => {
                                    setCommitMessageTouched(true)
                                    setCommitMessage(event.currentTarget.value)
                                  }}
                                  placeholder="Commit message"
                                  class="min-w-[220px] flex-1 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.03] px-3 py-2 text-[13px] text-white/85 outline-none transition placeholder:text-white/30 focus:border-[color:var(--vx-line)]"
                                />
                                <button
                                  type="button"
                                  class="vx-pill bg-[color:var(--vx-purple)] px-4 py-2 text-sm font-semibold text-white transition-transform duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:brightness-110 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40"
                                  classList={{ "!bg-[color:var(--vx-purple-bright)]": armedAction() === "commit-main" }}
                                  disabled={parallelBusy() || !effectiveCommitMessage().trim()}
                                  onClick={() =>
                                    confirmTwice(
                                      "commit-main",
                                      () =>
                                        void mergeParallelWorkspace(record(), true, {
                                          message: effectiveCommitMessage().trim(),
                                        }),
                                    )
                                  }
                                >
                                  {armedAction() === "commit-main"
                                    ? "Commit to main — sure?"
                                    : "Commit all changes to main"}
                                </button>
                              </div>
                            </section>
                          </Show>

                          <Show when={record().contextFiles?.length || record().contextSummary}>
                            <section class="rounded-[14px] border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] p-5">
                              <div class="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <div class="text-[13px] font-semibold text-white/80">Smart context</div>
                                  <p class="mt-1 max-w-2xl text-[12.5px] leading-6 text-white/50">
                                    Vector indexed the workspace locally, followed imports, and packed only the files
                                    most relevant to this mission.
                                  </p>
                                </div>
                                <div class="flex gap-2 text-[11px] font-medium text-white/58">
                                  <Show when={record().contextIndexedFiles !== undefined}>
                                    <span class="rounded-full bg-white/[0.06] px-2.5 py-1">
                                      {record().contextIndexedFiles} indexed
                                    </span>
                                  </Show>
                                  <Show when={record().contextTokenEstimate !== undefined}>
                                    <span class="rounded-full bg-[color:var(--vx-purple-soft)] px-2.5 py-1 text-[color:var(--vx-purple-bright)]">
                                      ~{record().contextTokenEstimate?.toLocaleString()} tokens
                                    </span>
                                  </Show>
                                </div>
                              </div>
                              <Show when={record().contextSummary}>
                                <p class="mt-3 text-[12.5px] leading-6 text-white/58">{record().contextSummary}</p>
                              </Show>
                              <div class="mt-3 flex flex-wrap gap-1.5">
                                <For each={record().contextFiles ?? []}>
                                  {(file) => (
                                    <span class="max-w-full truncate rounded-[6px] bg-white/[0.035] px-2 py-1 font-mono text-[11px] text-white/60">
                                      {file}
                                    </span>
                                  )}
                                </For>
                              </div>
                            </section>
                          </Show>

                          <Show when={record().validationReport}>
                            {(report) => (
                              <section class="rounded-[14px] border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] p-5">
                                <div class="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <div class="text-[13px] font-semibold text-white/80">Deterministic guardrails</div>
                                    <p class="mt-1 text-[12.5px] leading-6 text-white/50">
                                      Checks ran inside this isolated workspace before Vector marked the result ready
                                      for review.
                                    </p>
                                  </div>
                                  <span
                                    class="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                                    classList={{
                                      "bg-emerald-400/10 text-emerald-300": report().passed && report().hadChecks,
                                      "bg-amber-400/10 text-amber-200": !report().hadChecks,
                                      "bg-rose-400/10 text-rose-300": report().hadChecks && !report().passed,
                                    }}
                                  >
                                    {report().hadChecks
                                      ? report().passed
                                        ? "Verified"
                                        : "Failed"
                                      : "No checks detected"}
                                  </span>
                                </div>
                                <Show when={(record().repairAttempts ?? 0) > 0}>
                                  <p class="mt-3 text-xs text-[color:var(--vx-purple-bright)]/75">
                                    Vector used {record().repairAttempts} bounded repair{" "}
                                    {record().repairAttempts === 1 ? "attempt" : "attempts"} after a failed check.
                                  </p>
                                </Show>
                                <div class="mt-4 divide-y divide-white/[0.06]">
                                  <For each={report().checks}>
                                    {(check) => (
                                      <details class="group py-3 first:pt-0 last:pb-0">
                                        <summary class="flex cursor-pointer list-none items-center gap-3 text-[13px]">
                                          <span
                                            class="size-2 rounded-full"
                                            classList={{
                                              "bg-emerald-400": check.status === "passed",
                                              "bg-rose-400": check.status === "failed",
                                              "bg-amber-300": check.status === "skipped",
                                            }}
                                          />
                                          <span class="font-medium text-white/72">{check.label}</span>
                                          <code class="min-w-0 flex-1 truncate text-[11px] text-white/42">
                                            {[check.command, ...check.args].join(" ")}
                                          </code>
                                          <span class="text-[11px] text-white/38">
                                            {Math.max(0.1, check.durationMs / 1000).toFixed(1)}s
                                          </span>
                                        </summary>
                                        <pre class="mt-3 max-h-64 overflow-auto rounded-[8px] bg-white/[0.035] p-3 text-wrap font-mono text-[11px] leading-5 text-white/52">
                                          {check.output}
                                        </pre>
                                      </details>
                                    )}
                                  </For>
                                </div>
                              </section>
                            )}
                          </Show>

                          <Show
                            when={record().changedFiles.length || record().diff}
                            fallback={
                              <section class="rounded-[14px] border border-dashed border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] p-8 text-center">
                                <h3 class="text-lg font-semibold text-white">No diff ready yet.</h3>
                                <p class="mt-2 text-[13px] leading-6 text-white/60">
                                  Once this isolated agent edits files, Vector shows changed files, the full diff, and
                                  merge controls here.
                                </p>
                              </section>
                            }
                          >
                            <section class="rounded-[14px] border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] p-5">
                              <div class="mb-4 flex items-center justify-between">
                                <div class="text-[13px] font-semibold text-white/80">Changed files</div>
                                <div class="text-[13px]">
                                  <span class="text-emerald-400">+{stats().added}</span>{" "}
                                  <span class="text-rose-400">-{stats().removed}</span>
                                </div>
                              </div>
                              <Show
                                when={record().diff}
                                fallback={
                                  <div class="space-y-2">
                                    <For each={record().changedFiles}>
                                      {(file) => (
                                        <div class="flex items-center justify-between rounded-[10px] bg-white/[0.035] px-3 py-2 text-[13px]">
                                          <span class="truncate text-white/68">{file}</span>
                                          <span class="text-white/55">changed</span>
                                        </div>
                                      )}
                                    </For>
                                  </div>
                                }
                              >
                                {renderDiffReview(record)}
                              </Show>
                            </section>
                          </Show>

                          <Show when={record().terminalOutput.length || record().error}>
                            <section class="rounded-[14px] border border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] p-5">
                              <div class="mb-3 text-[13px] font-semibold text-white/80">Run results</div>
                              <div class="space-y-1.5">
                                <For each={record().terminalOutput}>
                                  {(line) => (
                                    <div class="rounded-[8px] bg-white/[0.035] px-3 py-2 font-mono text-xs text-white/55">
                                      {line}
                                    </div>
                                  )}
                                </For>
                              </div>
                              <Show when={record().error}>
                                <div class="mt-2 rounded-[8px] border border-rose-400/25 bg-rose-400/[0.08] px-3 py-2 text-[13px] text-rose-200">
                                  {record().error}
                                </div>
                              </Show>
                            </section>
                          </Show>
                        </div>
                      </div>

                      <footer class="shrink-0 border-t border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-stage)_90%,transparent)] px-6 py-4">
                        <div class="mx-auto flex max-w-[1050px] items-center gap-2">
                          <div class="min-w-0 flex-1 text-[12px] text-white/45">
                            <Show
                              when={record().mergeState === "none"}
                              fallback={
                                <span>This workspace is {record().mergeState}. Its record stays here as history.</span>
                              }
                            >
                              Merging checkpoints your main project first; approve individual hunks above for a partial
                              merge.
                            </Show>
                          </div>
                          <Show when={record().mergeState === "none"}>
                            <button
                              type="button"
                              class="rounded-[10px] border border-[color:var(--vx-line)] px-4 py-2 text-sm text-white/72 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-white/[0.06]"
                              onClick={() => void runParallelWorkspace(record().id)}
                            >
                              Continue
                            </button>
                            <button
                              type="button"
                              class="rounded-[10px] border border-rose-400/30 px-4 py-2 text-sm text-rose-200/85 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:bg-rose-400/[0.1]"
                              classList={{ "bg-rose-400/[0.14]": armedAction() === "discard" }}
                              onClick={() => confirmTwice("discard", () => void discardParallelWorkspace(record()))}
                            >
                              {armedAction() === "discard" ? "Discard — sure?" : "Discard"}
                            </button>
                            <Show when={record().changedFilesCount > 0}>
                              <button
                                data-vector-merge-action
                                type="button"
                                class="vx-pill bg-[color:var(--vx-purple)] px-4 py-2 text-sm font-semibold text-white transition-transform duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:brightness-110 active:scale-[0.985]"
                                classList={{ "!bg-[color:var(--vx-purple-bright)]": armedAction() === "merge" }}
                                disabled={parallelBusy()}
                                onClick={() => confirmTwice("merge", () => void mergeParallelWorkspace(record()))}
                              >
                                {parallelBusy()
                                  ? "Merging…"
                                  : armedAction() === "merge"
                                    ? `Merge ${record().changedFilesCount} files — sure?`
                                    : "Merge into main"}
                              </button>
                            </Show>
                          </Show>
                        </div>
                      </footer>
                    </Show>
                  </div>
                )
              }}
            </Show>
          </main>
        </section>
      </Show>

      <WorkspaceNavigation
        width={navigationWidth()}
        minimumWidth={NAVIGATION_MINIMUM_WIDTH}
        maximumWidth={NAVIGATION_MAXIMUM_WIDTH}
        macDesktop={macDesktop()}
        visible={navUnlocked() && navigationVisible()}
        resizing={navigationResizing()}
        projectName={projectDisplayName()}
        mainLabel={mainAgentLabel()}
        mainActive={!sidebarActiveAgentID() && taskRoute()}
        treeOpen={workspaceTreeOpen()}
        items={workspaceNavigationItems()}
        activeTool={canvasRoute() ? "canvas" : undefined}
        currentVersion={platform.version}
        updaterState={platform.updater?.state()}
        onResizeStart={beginNavigationResize}
        onResize={resizeNavigation}
        onResetWidth={() => {
          resizeNavigation(NAVIGATION_DEFAULT_WIDTH)
          globalThis.localStorage?.setItem(NAVIGATION_WIDTH_KEY, String(NAVIGATION_DEFAULT_WIDTH))
        }}
        onHome={() => {
          setToolsOpen(false)
          setSidePanelOpen(false)
          setBrowserAgentOpen(false)
          setParallelOpen(false)
          navigate("/")
        }}
        onHide={() => setNavigationVisible(false)}
        onToggleTree={() => setWorkspaceTreeOpen((open) => !open)}
        onNewWorkspace={openParallelWorkspaces}
        onOrchestrate={openOrchestration}
        onOpenMain={() => void openMainAgent()}
        onOpenWorkspace={openAgentByID}
        onReviewWorkspace={openAgentReviewByID}
        onRemoveWorkspace={(id) => {
          const record = parallelRecords().find((item) => item.id === id)
          if (!record) return
          confirmTwice(`remove-${record.id}`, () => void removeParallelWorkspace(record))
        }}
        onMoveWorkspace={moveAgentWorkspace}
        onCodeEditor={openCodespace}
        onAgentDashboard={() => {
          setAgentDashboardOpen(true)
          void refreshTeamConversations()
        }}
        onPullRequests={() => setPullRequestsOpen(true)}
        onBrowser={openPreviewPanel}
        onCanvas={() => navigate(`/canvas${taskScopeSearch(activeTaskScope())}`)}
        onMcp={() => void openMcpDialog()}
        onPlugins={() => void openPluginsDialog()}
        onFind={() => {
          if (!taskRoute() || !sessionCommandRegistered("file.open")) {
            showToast({
              title: "Open a project first",
              description: "Project search becomes available inside an active workspace.",
            })
            return
          }
          command.show()
        }}
        onReportBug={() => setReportBugOpen(true)}
        onGettingStarted={() => setHelpPanelOpen(true)}
        onUpdate={() => void updaterAction.updateLatest()}
      />

      <DialogReportBug open={reportBugOpen()} onClose={() => setReportBugOpen(false)} />

      <HelpPanel open={helpPanelOpen()} onClose={() => setHelpPanelOpen(false)} />

      <PullRequests
        open={pullRequestsOpen()}
        projectPath={activeWorkspaceScope().sourcePath}
        onClose={() => setPullRequestsOpen(false)}
        onAiReview={async (prompt) => {
          const directory = activeWorkspaceScope().sourcePath
          if (!directory) throw new Error("Open a project before running a review.")
          const client = serverSDK().createClient({ directory, throwOnError: true })
          const created = await client.session.create().then((result) => result.data ?? undefined)
          if (!created) throw new Error("Vector could not create a session for this review.")
          const outcome = await client.session.prompt({
            sessionID: created.id,
            directory,
            parts: [{ type: "text", text: prompt }],
          })
          return extractVelReply(outcome.data)
        }}
      />

      <AgentDashboard
        open={agentDashboardOpen()}
        agents={parallelRecords()}
        conversations={teamConversations()}
        onClose={() => setAgentDashboardOpen(false)}
        onOpenAgent={(id) => {
          setAgentDashboardOpen(false)
          openAgentByID(id)
        }}
      />

      <nav
        data-vector-navigation-legacy
        aria-hidden="true"
        class="hidden"
        style={{
          width: `${navigationWidth()}px`,
          "padding-top": macDesktop() ? "56px" : "12px",
          // The rail only exists once you've opened a task or a feature. On the
          // bare Overview/home it's hidden entirely — the home page carries its
          // own Start task / Open project entry points.
          display: "none",
        }}
      >
        <div data-vector-nav-brand class="flex items-center gap-3 px-4 pb-5">
          <img src="/vector-logo.png" alt="" class="size-8 rounded-[10px] object-cover" draggable={false} />
          <div class="min-w-0">
            <div class="truncate text-[14px] font-semibold text-white">Vector</div>
            <div class="truncate text-[10.5px] text-white/55">AI engineering workspace</div>
          </div>
          <button
            type="button"
            class="ml-auto grid size-8 shrink-0 place-items-center rounded-[9px] text-white/45 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
            aria-label="Hide Vector sidebar"
            title="Hide Vector sidebar"
            onClick={() => setNavigationVisible(false)}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <rect
                x="2.25"
                y="2.5"
                width="11.5"
                height="11"
                rx="1.75"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
              <path
                d="M6 2.75v10.5m3.5-7-2 2 2 2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <div data-vector-nav-primary class="px-3 pb-4">
          <button type="button" class="vector-nav-new-task" onClick={startTask}>
            <span class="vector-nav-new-task__icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" class="size-4 shrink-0">
                <path
                  d="M8 3.25v9.5M3.25 8h9.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.45"
                  stroke-linecap="round"
                />
              </svg>
            </span>
            <span>New project</span>
            <kbd>{platform.os === "macos" ? "⌘N" : "Ctrl+N"}</kbd>
          </button>
        </div>

        <div
          data-vector-nav-scroll
          class="min-h-0 flex-1 overflow-y-auto pb-2"
          classList={{ "vector-nav-gated": !navUnlocked() }}
        >
          <div data-vector-nav-group class="flex flex-col gap-0.5 px-2">
            <div data-vector-nav-label data-nav-always>
              Workspace
            </div>
            <button
              type="button"
              data-vector-nav-item
              data-nav-always
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              classList={{
                "bg-white/[0.08] text-white":
                  location.pathname === "/" &&
                  !browserAgentOpen() &&
                  !browserAgentRoute() &&
                  !parallelOpen() &&
                  !parallelWorkspacesRoute() &&
                  !toolsOpen(),
              }}
              onClick={() => {
                setToolsOpen(false)
                setSidePanelOpen(false)
                setBrowserAgentOpen(false)
                setParallelOpen(false)
                navigate("/")
              }}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="M3 7.25 8 3l5 4.25V13a.75.75 0 0 1-.75.75h-2.6v-3.6h-3.3v3.6h-2.6A.75.75 0 0 1 3 13V7.25Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linejoin="round"
                />
              </svg>
              Overview
            </button>
            <button
              type="button"
              data-vector-nav-item
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              onClick={() => {
                if (!taskRoute() || !sessionCommandRegistered("file.open")) {
                  showToast({
                    title: "Open a project first",
                    description: "Search becomes available after Vector has an active project workspace.",
                  })
                  return
                }
                setBrowserAgentOpen(false)
                setParallelOpen(false)
                command.show()
              }}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="M7.25 12.25a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm3.6-1.4 2.9 2.9"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
              Find in project
            </button>
            <button
              type="button"
              data-vector-nav-item
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              classList={{ "bg-white/[0.08] text-white": onboardingOpen() }}
              onClick={() => setOnboardingOpen(true)}
            >
              <span
                class="grid size-4 shrink-0 place-items-center rounded-full text-[8.5px] font-bold text-white"
                style={{ background: "var(--vx-gradient, #9374ec)" }}
                aria-hidden="true"
              >
                {onboardingDoneCount()}
              </span>
              <span class="min-w-0 flex-1 text-left">Getting started</span>
              <Show when={onboardingDoneCount() < onboardingSteps().length}>
                <span class="text-[10.5px] text-white/40">
                  {onboardingDoneCount()}/{onboardingSteps().length}
                </span>
              </Show>
            </button>
          </div>

          {/* Always visible — agents and project tools open their own surfaces
            or toast "open a task first" instead of vanishing from the rail. */}
          <div data-vector-nav-group class="mt-5 px-2">
            <div data-vector-nav-label>Agents</div>
            <button
              type="button"
              data-vector-nav-item
              class="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              onClick={() => void openMcpDialog()}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="M3.25 5.25a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm9.5 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 14.75a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM4.95 4.3l1.8 6.5M11.05 4.3l-1.8 6.5M5.1 3.25h5.8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="min-w-0 flex-1 text-left">MCP</span>
            </button>
            <button
              type="button"
              data-vector-nav-item
              class="mt-1 flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              onClick={() => void openPluginsDialog()}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="M6.1 1.6v2.7M9.9 1.6v2.7M4.6 4.3h6.8v1.7a3.4 3.4 0 0 1-6.8 0V4.3ZM8 9.4v.9c0 1.5-3.2.9-3.2 2.4 0 1.4 2.7 1.6 4.6.9"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="min-w-0 flex-1 text-left">Plugins</span>
            </button>
          </div>
          <div data-vector-nav-group class="mt-5 flex flex-col gap-0.5 px-2">
            <div data-vector-nav-label>Project</div>
            <button
              type="button"
              data-vector-nav-item
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              classList={{ "bg-white/[0.08] text-white": canvasRoute() }}
              onClick={() => navigate(`/canvas${taskScopeSearch(activeTaskScope())}`)}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <rect
                  x="2.4"
                  y="3.4"
                  width="11.2"
                  height="9.2"
                  rx="1.6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                />
                <path
                  d="M5.5 6.2h3v2.4h-3zM9.2 6.2h1.9M9.2 8.1h1.9M5.5 10h5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.05"
                  stroke-linecap="round"
                />
              </svg>
              Canvas
            </button>
            <button
              type="button"
              data-vector-nav-item
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              onClick={openCodespace}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="M5.25 5 2.75 8l2.5 3M10.75 5l2.5 3-2.5 3M9.15 3.75l-2.3 8.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.35"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              Code editor
            </button>
            <button
              type="button"
              data-vector-nav-item
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              onClick={openTerminalPanel}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path
                  d="m4 5 3 3-3 3m4.5 0H12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.35"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              Terminal
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-0.5 px-2 pt-2">
          <button
            type="button"
            data-vector-nav-item
            class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
            onClick={openSettings}
          >
            <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
              <path
                d="M8 10.35A2.35 2.35 0 1 0 8 5.65a2.35 2.35 0 0 0 0 4.7Zm4.72-1.35a4.8 4.8 0 0 0 0-2l1.2-.92-1.2-2.08-1.42.58a5.1 5.1 0 0 0-1.72-1L9.4 2H6.6l-.18 1.58a5.1 5.1 0 0 0-1.72 1L3.28 4l-1.2 2.08 1.2.92a4.8 4.8 0 0 0 0 2l-1.2.92L3.28 12l1.42-.58a5.1 5.1 0 0 0 1.72 1L6.6 14h2.8l.18-1.58a5.1 5.1 0 0 0 1.72-1l1.42.58 1.2-2.08-1.2-.92Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            Settings
          </button>
        </div>
      </nav>

      <Show when={navUnlocked() && !navigationVisible() && !parallelWorkspacesRoute()}>
        <button
          type="button"
          data-vector-floating-sidebar-toggle
          class="fixed z-[70] grid size-8 place-items-center rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-control)] text-white/48 transition hover:border-[color:var(--vx-line-strong)] hover:bg-[color:var(--vx-control-hover)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--vx-purple)]"
          style={{ left: "12px", top: macDesktop() ? "59px" : "11px" }}
          aria-label="Show Vector sidebar"
          title="Show Vector sidebar"
          onClick={() => setNavigationVisible(true)}
        >
          <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
            <rect
              x="2.25"
              y="2.5"
              width="11.5"
              height="11"
              rx="1.75"
              fill="none"
              stroke="currentColor"
              stroke-width="1.15"
            />
            <path d="M6 2.75v10.5" fill="none" stroke="currentColor" stroke-width="1.15" />
          </svg>
        </button>
      </Show>

      <aside
        class="fixed bottom-0 right-0 top-0 z-40 w-[380px] overflow-hidden border-l border-[color:var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-sidebar)_90%,transparent)] shadow-[-18px_0_64px_rgba(0,0,0,0.34)] backdrop-blur-2xl transition duration-200"
        classList={{
          "pointer-events-auto translate-x-0 opacity-100": toolsOpen(),
          "pointer-events-none translate-x-[calc(100%+24px)] opacity-0": !toolsOpen(),
        }}
        aria-hidden={!toolsOpen()}
        inert={!toolsOpen()}
      >
        <div class="flex h-full min-h-0 flex-col">
          <header class="flex h-[64px] shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] px-4">
            <img src="/vector-logo.png" alt="" class="size-9 rounded-xl object-cover" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-semibold text-white">Engineering Console</div>
              <div class="truncate text-xs text-white/55">Live project services and execution state</div>
            </div>
            <button
              type="button"
              class="grid size-8 place-items-center rounded-lg text-white/55 transition hover:bg-white/[0.06] hover:text-white"
              title="Close Engineering Console"
              aria-label="Close Engineering Console"
              onClick={() => setToolsOpen(false)}
            >
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path
                  d="m4.5 4.5 7 7m0-7-7 7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.35"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <section class="border-b border-[color:var(--vx-line)] pb-4">
              <div class="flex items-center gap-2">
                <span
                  class="size-2 rounded-full"
                  classList={{ "bg-emerald-400": Boolean(activeProjectPath()), "bg-amber-300": !activeProjectPath() }}
                />
                <div class="min-w-0 flex-1 truncate text-sm font-semibold text-white">{projectDisplayName()}</div>
                <span class="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/50">
                  {activeProjectPath() ? "Connected" : "Idle"}
                </span>
              </div>
              <div class="mt-2 truncate font-mono text-[11px] text-white/42">
                {activeProjectPath() || "Open a project to activate project-scoped tools"}
              </div>
              <div class="mt-3 grid grid-cols-3 gap-2">
                <div class="rounded-xl bg-white/[0.035] px-3 py-2">
                  <div class="text-lg font-semibold text-white">{activeParallelCount()}</div>
                  <div class="text-[10px] uppercase tracking-[0.12em] text-white/42">Running</div>
                </div>
                <div class="rounded-xl bg-white/[0.035] px-3 py-2">
                  <div class="text-lg font-semibold text-white">{reviewParallelCount()}</div>
                  <div class="text-[10px] uppercase tracking-[0.12em] text-white/42">Review</div>
                </div>
                <div class="rounded-xl bg-white/[0.035] px-3 py-2">
                  <div class="text-lg font-semibold text-white">{activeBackgroundTasks().length}</div>
                  <div class="text-[10px] uppercase tracking-[0.12em] text-white/42">Runs</div>
                </div>
              </div>
            </section>

            <section class="py-4">
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">Agent runtime</h3>
                <span class="text-[11px] text-white/42">
                  {parallelModelState.current()?.name || "No model selected"}
                </span>
              </div>
              <div>
                <button type="button" class="vector-engineering-action w-full" onClick={openParallelWorkspaces}>
                  <span class="vector-engineering-action__icon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" class="size-4">
                      <path
                        d="M2.75 5.25h3.5v3.5h-3.5zM9.75 2.75h3.5v3.5h-3.5zM9.75 9.75h3.5v3.5h-3.5zM6.25 7h1.9c.9 0 1.6-.7 1.6-1.6v-.9M6.25 7h1.9c.9 0 1.6.7 1.6 1.6v2.9"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.15"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </span>
                  <span>
                    <strong>New agent</strong>
                    <small>{parallelRecords().length} workspaces</small>
                  </span>
                </button>
              </div>
            </section>

            <section class="border-t border-[color:var(--vx-line)] py-4">
              <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">
                Trust and integrations
              </h3>
              <div class="space-y-1">
                <button type="button" class="vector-engineering-row" onClick={() => void openMcpDialog()}>
                  <span>MCP servers</span>
                  <small>Project tool connections</small>
                </button>
                <button type="button" class="vector-engineering-row" onClick={() => void openPluginsDialog()}>
                  <span>Plugins</span>
                  <small>GitHub, Linear, Sentry & more</small>
                </button>
                <button type="button" class="vector-engineering-row" onClick={openProviderSettings}>
                  <span>Model provider</span>
                  <small>{parallelModelState.current()?.provider.name || "Configure BYOK"}</small>
                </button>
              </div>
            </section>

            <section class="border-t border-[color:var(--vx-line)] pt-4">
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">Background activity</h3>
                <span class="text-[11px] text-white/42">{backgroundTaskRecords().length} total</span>
              </div>
              <Show
                when={backgroundTaskRecords().length}
                fallback={
                  <div class="rounded-xl border border-dashed border-[color:var(--vx-line)] px-3 py-5 text-center text-xs text-white/42">
                    No project activity yet.
                  </div>
                }
              >
                <div class="space-y-1.5">
                  <For each={backgroundTaskRecords().slice(0, 5)}>
                    {(task) => {
                      const workspace = () => parallelRecords().find((record) => record.id === task.workspaceId)
                      const dot = `size-2 rounded-full ${task.status === "failed" ? "bg-rose-400" : task.status === "needs_review" || task.status === "complete" ? "bg-emerald-400" : "bg-[color:var(--vx-purple-bright)]"}`
                      return (
                        <Show
                          when={workspace()}
                          fallback={
                            <div class="w-full rounded-xl bg-white/[0.03] px-3 py-2.5 text-left">
                              <div class="flex items-center gap-2">
                                <span class={dot} />
                                <span class="min-w-0 flex-1 truncate text-xs font-semibold text-white/72">
                                  {task.name}
                                </span>
                                <span class="text-[10px] uppercase tracking-[0.08em] text-white/38">
                                  {parallelStatusLabel(task.status)}
                                </span>
                              </div>
                              <div class="mt-1 truncate pl-4 text-[11px] text-white/42">{task.currentStep}</div>
                            </div>
                          }
                        >
                          {(ws) => (
                            <button
                              type="button"
                              class="w-full rounded-xl bg-white/[0.03] px-3 py-2.5 text-left transition hover:bg-white/[0.055]"
                              onClick={() => openParallelWorkspace(ws())}
                            >
                              <div class="flex items-center gap-2">
                                <span class={dot} />
                                <span class="min-w-0 flex-1 truncate text-xs font-semibold text-white/72">
                                  {task.name}
                                </span>
                                <span class="text-[10px] uppercase tracking-[0.08em] text-white/38">
                                  {parallelStatusLabel(task.status)}
                                </span>
                              </div>
                              <div class="mt-1 truncate pl-4 text-[11px] text-white/42">{task.currentStep}</div>
                            </button>
                          )}
                        </Show>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </section>
          </div>

          <footer class="shrink-0 border-t border-[color:var(--vx-line)] p-3">
            <div class="flex gap-2">
              <button
                type="button"
                class="flex h-9 flex-1 items-center justify-center rounded-xl border border-[color:var(--vx-line)] text-xs font-semibold text-white/62 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-45"
                disabled={engineeringRefreshBusy()}
                onClick={() => void refreshEngineeringConsole()}
              >
                {engineeringRefreshBusy() ? "Refreshing…" : "Refresh services"}
              </button>
              <button
                type="button"
                class="h-9 rounded-xl border px-3 text-xs font-semibold transition"
                classList={{
                  "border-[color:var(--vx-purple)]/55 bg-[color:var(--vx-purple)]/16 text-[color:var(--vx-purple-bright)]":
                    planMode.enabled(),
                  "border-[color:var(--vx-line)] text-white/58 hover:bg-white/[0.06] hover:text-white":
                    !planMode.enabled(),
                }}
                onClick={() => planMode.toggle()}
              >
                Plan {planMode.enabled() ? "On" : "Off"}
              </button>
            </div>
          </footer>
        </div>
      </aside>

      <Show when={chatSearchOpen()}>
        <form
          class="fixed right-4 top-4 z-[70] flex w-[min(360px,calc(100vw-88px))] items-center gap-1 rounded-2xl border border-[#303036] bg-[#242428]/96 p-1.5 shadow-[0_24px_70px_rgba(0,0,0,0.42)] backdrop-blur-2xl"
          onSubmit={(event) => {
            event.preventDefault()
            searchChat()
          }}
        >
          <svg viewBox="0 0 16 16" class="ml-2 size-4 text-white/58" aria-hidden="true">
            <path
              d="M7.25 12.25a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm3.6-1.4 2.9 2.9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.45"
              stroke-linecap="round"
            />
          </svg>
          <input
            ref={(el) => {
              chatSearchRef = el
            }}
            class="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm text-white outline-none placeholder:text-white/30"
            value={chatSearchValue()}
            placeholder="Search chat"
            spellcheck={false}
            onInput={(event) => {
              setChatSearchValue(event.currentTarget.value)
              searchChat(event.currentTarget.value)
            }}
          />
          <button
            type="button"
            class="grid size-8 place-items-center rounded-xl text-white/64 transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Previous match"
            onClick={() => searchChat(chatSearchValue(), true)}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4.5 9.5 3.5-3.5 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </button>
          <button
            type="button"
            class="grid size-8 place-items-center rounded-xl text-white/64 transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Next match"
            onClick={() => searchChat()}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </button>
          <button
            type="button"
            class="grid size-8 place-items-center rounded-xl text-white/64 transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Close search"
            onClick={() => {
              setChatSearchOpen(false)
              setChatSearchValue("")
            }}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </form>
      </Show>

      {import.meta.env.DEV && <DebugBar inline />}
      <ToastRegion v2 />
    </div>
  )
}
