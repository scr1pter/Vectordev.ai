import "@/index.css"
import "@/vector-premium.css"
import "@/product-suite.css"
import * as Sentry from "@sentry/solid"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/session-ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider, useTheme } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useParams, useSearchParams } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider, useCommand, type CommandOption } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { GlobalProvider, useGlobal } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PlanModeProvider } from "@/context/plan-mode"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TabsProvider, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider, useSDK } from "@/context/sdk"
import { WslServersProvider } from "@/wsl/context"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import LegacyLayout from "@/pages/layout"
import NewLayout from "@/pages/layout-new"
import { ErrorPage } from "./pages/error"
import { LicenseGate } from "./components/license-gate"
import { useCheckServerHealth } from "./utils/server-health"
import { legacySessionServer, requireServerKey, sessionHref } from "./utils/session-route"

import { SessionPage, TargetSessionRouteContent } from "@/pages/session"
import { NewHome } from "@/pages/home"
import { CloudHome } from "@/features/cloud/cloud-home"

const NewSession = lazy(() => import("@/pages/new-session"))

const SessionRoute = () => {
  const settings = useSettings()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const sdk = useSDK()
  const server = useServer()
  const tabs = useTabs()

  if (params.id && settings.general.newLayoutDesigns()) {
    const sessionID = params.id
    return (
      <Show when={tabs.ready()}>
        {(_) => {
          const persisted = tabs.store.filter((item) => item.type === "session")
          return <Navigate href={sessionHref(legacySessionServer(persisted, sessionID, server.key), sessionID)} />
        }}
      </Show>
    )
  }

  // When the new layout is enabled, the legacy new-session route (/:dir/session with no id)
  // is replaced by a draft at /new-session?draftId=…
  createEffect(() => {
    if (!settings.general.newLayoutDesigns()) return
    if (params.id || search.draftId) return
    if (!tabs.ready() || !sdk().directory) return
    tabs.newDraft({ server: server.key, directory: sdk().directory }, search.prompt)
  })

  return <SessionPage />
}

const TargetSessionRoute = () => {
  const params = useParams<{ serverKey: string; id: string }>()
  const global = useGlobal()
  const conn = createMemo(() => {
    const key = requireServerKey(params.serverKey)
    return global.servers.list().find((item) => ServerConnection.key(item) === key)
  })

  return (
    // Owns the server-identity remount. Session changes must NOT remount this
    // subtree (SessionRouteErrorBoundary resets and createSessionLineage
    // re-resolves reactively instead); both rely on this key for server changes.
    <Show when={requireServerKey(params.serverKey)} keyed>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>
          <TargetSessionRouteContent />
        </ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

// Wraps the non-draft routes. They are gated on (and keyed to) the globally selected
// server via ServerKey, then provide the server-scoped shell (Permission/Layout/
// Notification/Models + the visual Layout) for that server.
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <ServerSyncProvider>{props.children}</ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

function LegacyServerLayout(props: ParentProps) {
  return (
    <SelectedServerProviders>
      <LegacyServerScopedShell>{props.children}</LegacyServerScopedShell>
    </SelectedServerProviders>
  )
}

function DraftRoute() {
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  return (
    <Show when={tabs.ready()}>
      <Show
        when={tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)}
        keyed
        fallback={<Navigate href="/" />}
      >
        {(draft) => <ResolvedDraftRoute draft={draft} />}
      </Show>
    </Show>
  )
}

function ResolvedDraftRoute(props: { draft: DraftTab }) {
  const global = useGlobal()
  const conn = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === props.draft.server))
  const directory = () => props.draft.directory
  const serverKey = () => props.draft.server

  return (
    <Show when={`${props.draft.server}\0${props.draft.directory}`} keyed>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>
          <DraftServerScopedProviders directory={directory}>
            <SDKProvider directory={directory}>
              <DirectoryDataProvider directory={directory} server={serverKey}>
                <DraftProviders>
                  <NewSession />
                </DraftProviders>
              </DirectoryDataProvider>
            </SDKProvider>
          </DraftServerScopedProviders>
        </ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
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

type ParallelWorkspaceRecord = {
  id: string
  name: string
  taskPrompt: string
  runtime: "vector" | "claude-code" | "codex" | "cursor"
  provider: string
  model: string
  sourcePath: string
  isolatedPath: string
  isolation: "git-worktree" | "copy"
  gitBranch?: string
  parentSessionId?: string
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
  baselineHashes?: Record<string, string>
  agentSessionId?: string
  backgroundTaskId?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
  contextFiles?: string[]
  contextIndexedFiles?: number
  contextTokenEstimate?: number
  contextSummary?: string
  validationReport?: {
    startedAt: string
    completedAt: string
    passed: boolean
    hadChecks: boolean
    checks: {
      id: string
      label: string
      command: string
      args: string[]
      reason: string
      status: "passed" | "failed" | "skipped"
      exitCode?: number
      durationMs: number
      output: string
    }[]
    failureSummary: string
  }
  validationPassed?: boolean
  repairAttempts?: number
  error?: string
}

type CreateParallelWorkspaceInput = {
  sourcePath: string
  parentSessionId?: string
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
  status:
    | "planning"
    | "running"
    | "needs review"
    | "complete"
    | "failed"
    | "canceled"
    | "interrupted"
    | "merged"
    | "discarded"
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

declare global {
  interface Window {
    __OPENCODE__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
      openLink?: (url: string) => void
      exportDebugLogs?: () => Promise<string>
      getMicrophonePermission?: () => Promise<"not-determined" | "granted" | "denied" | "restricted" | "unknown">
      requestMicrophonePermission?: () => Promise<"not-determined" | "granted" | "denied" | "restricted" | "unknown">
      runBrowserAgent?: (
        input: import("@/features/browser-agent/types").BrowserAgentInput,
      ) => Promise<import("@/features/browser-agent/types").BrowserAutomationRun>
      prepareAgentTask?: (
        root: string,
        task: string,
      ) => Promise<import("@/utils/task-intelligence").AgentTaskPreparation>
      onBrowserAgentPageEvent?: (
        cb: (event: import("@/features/browser-agent/types").BrowserAgentPageEvent) => void,
      ) => () => void
      onZoomFactorChanged?: (cb: (factor: number) => void) => () => void
      voice?: {
        speak: (text: string) => Promise<{
          status: "spoken" | "unavailable" | "stopped" | "failed"
          message?: string
        }>
        stop: () => Promise<void>
      }
      parallelWorkspaces?: {
        list: (scope?: { sourcePath?: string; parentSessionId?: string }) => Promise<ParallelWorkspaceRecord[]>
        create: (input: CreateParallelWorkspaceInput) => Promise<ParallelWorkspaceRecord>
        refresh: (id: string) => Promise<ParallelWorkspaceRecord>
        run: (id: string, concurrency?: number) => Promise<ParallelWorkspaceRecord>
        stop: (id: string) => Promise<ParallelWorkspaceRecord>
        merge: (id: string, force?: boolean) => Promise<ParallelWorkspaceRecord>
        mergeSelection: (
          id: string,
          selection: { hunkIds?: string[]; files?: string[] },
          force?: boolean,
        ) => Promise<ParallelWorkspaceRecord>
        discard: (id: string) => Promise<ParallelWorkspaceRecord>
        remove: (id: string) => Promise<ParallelWorkspaceRecord[]>
      }
      swarmOrchestrator?: {
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
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  const settings = useSettings()

  createRenderEffect(() => {
    if (typeof document === "undefined") return

    const enabled = settings.general.newLayoutDesigns()
    document.body.toggleAttribute("data-new-layout", enabled)
    document.body.classList.toggle("text-12-regular", !enabled)
    document.body.classList.toggle("font-(family-name:--font-family-text)", enabled)
    document.body.classList.toggle("text-[13px]", enabled)
    document.body.classList.toggle("font-[440]", enabled)
  })

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <>
      <BodyDesignClass />
      <PlanModeProvider>
        <CommandProvider>
          <DesktopCommands />
          <HighlightsProvider>{props.children}</HighlightsProvider>
        </CommandProvider>
      </PlanModeProvider>
    </>
  )
}

function DesktopCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()

  command.register("desktop", () => {
    const commands: CommandOption[] = []
    if (platform.platform === "desktop" && platform.exportDebugLogs) {
      commands.push({
        id: "logs.export",
        title: "Export logs",
        category: language.t("command.category.settings"),
        onSelect: () => {
          void platform.exportDebugLogs?.()
        },
      })
    }
    return commands
  })

  return null
}

// Server-scoped providers shared by the legacy shell and the top-level new shell.
type ServerScopedShellProps = ParentProps<{
  directory?: () => string | undefined
  sessionID?: () => string | undefined
}>

function ServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <PermissionProvider directory={props.directory}>
      <LayoutProvider>
        <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
      </LayoutProvider>
    </PermissionProvider>
  )
}

function LegacyServerScopedShell(props: ServerScopedShellProps) {
  return (
    <ServerScopedProviders directory={props.directory} sessionID={props.sessionID}>
      <LegacyLayout>{props.children}</LegacyLayout>
    </ServerScopedProviders>
  )
}

function NewAppLayout(props: ParentProps) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders>
        <NewLayout>{props.children}</NewLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}

function DraftServerScopedProviders(props: ParentProps<{ directory?: () => string | undefined }>) {
  return (
    <PermissionProvider directory={props.directory}>
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </PermissionProvider>
  )
}

// The draft page only renders the prompt composer, so it drops TerminalProvider.
// FileProvider and CommentsProvider stay because PromptInput uses file search and comment context.
function DraftProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

function VectorThemeSync() {
  const settings = useSettings()
  const theme = useTheme()

  createEffect(() => {
    const preference = settings.appearance.theme()
    if (theme.colorScheme() === preference) return
    theme.setColorScheme(preference)
  })

  return null
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                Sentry.captureException(error)
                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider>
                    <MarkedProvider>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )

  return (
    <Show
      when={!checking()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck.latest}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") void healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              void healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  // Desktop dictation transcribes on-device with Whisper; pre-warm the worker
  // and its ~40MB model during idle time so the first dictation doesn't stall
  // on a download. No-op on web, which uses the browser speech engine instead.
  onMount(() => {
    if (!globalThis.window?.api) return
    const warm = () =>
      void import("@/services/local-transcription").then((mod) => mod.warmupLocalTranscription()).catch(() => undefined)
    if (typeof globalThis.requestIdleCallback === "function") globalThis.requestIdleCallback(warm, { timeout: 5000 })
    else setTimeout(warm, 2500)
  })

  // The visual new layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const ServerShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>
        {props.children}
        {shellProps.children}
      </SharedProviders>
    </QueryProvider>
  )

  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      canonicalLocalServer={props.canonicalLocalServer}
      servers={props.servers}
    >
      <GlobalProvider>
        <SettingsProvider>
          <VectorThemeSync />
          <LicenseGate>
            <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
              <Show when={useSettings().general.newLayoutDesigns().toString()} keyed>
                <Dynamic
                  component={props.router ?? Router}
                  root={(routerProps) => (
                    <TabsProvider>
                      <NotificationProvider>
                        <ServerShell>
                          <Show when={useSettings().general.newLayoutDesigns()} fallback={routerProps.children}>
                            <NewAppLayout>{routerProps.children}</NewAppLayout>
                          </Show>
                        </ServerShell>
                      </NotificationProvider>
                    </TabsProvider>
                  )}
                >
                  <Routes />
                </Dynamic>
              </Show>
            </ConnectionGate>
          </LicenseGate>
        </SettingsProvider>
      </GlobalProvider>
    </ServerProvider>
  )
}

function Routes() {
  const settings = useSettings()

  return (
    <>
      <Route component={LegacyServerLayout}>
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/:id?" component={SessionRoute} />
        </Route>
      </Route>
      <Show when={settings.general.newLayoutDesigns()}>
        <Route path="/" component={NewHome} />
        <Route path="/code" component={() => <Navigate href="/" />} />
        <Route path="/work" component={() => <Navigate href="/" />} />
        <Route path="/cloud" component={CloudHome} />
        <Route path="/canvas" component={() => <Navigate href="/" />} />
        <Route path="/parallel-workspaces" component={() => null} />
        <Route path="/parallel-workspaces/swarm/:swarmId" component={() => null} />
        <Route path="/parallel-workspaces/:workspaceId" component={() => null} />
        <Route path="/parallel-workspaces/:workspaceId/server/:serverKey/session/:id" component={TargetSessionRoute} />
        <Route path="/:dir/session/:id" component={LegacyTargetSessionRoute} />
      </Show>
      <Route path="/new-session" component={DraftRoute} />
      <Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />
    </>
  )
}

function LegacyTargetSessionRoute() {
  const server = useServer()
  const tabs = useTabs()
  const params = useParams<{ id: string }>()

  return (
    <Show when={tabs.ready()}>
      <Navigate
        href={sessionHref(
          legacySessionServer(
            tabs.store.filter((item) => item.type === "session"),
            params.id,
            server.key,
          ),
          params.id,
        )}
      />
    </Show>
  )
}
