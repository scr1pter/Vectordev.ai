import { createEffect, createSignal, For, lazy, Show, Suspense, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Terminal } from "@/components/terminal"
import { FileProvider } from "@/context/file"
import type { ServerConnection } from "@/context/server"
import { SDKProvider } from "@/context/sdk"
import { TerminalProvider, useTerminal } from "@/context/terminal"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { externalAgentWorkspaceTabs, type ExternalAgentWorkspaceView } from "./external-agent-workspace-model"

const CodespaceWorkbench = lazy(() =>
  import("@/pages/session/session-side-panel").then((module) => ({ default: module.CodespaceWorkbench })),
)
const PreviewPanel = lazy(() =>
  import("@/pages/session/session-side-panel").then((module) => ({ default: module.PreviewPanel })),
)

export function ExternalAgentWorkspace(props: {
  id: string
  directory: string
  server: ServerConnection.Key
  name: string
  runtimeLabel: string
  statusLabel: string
  statusTone: string
  branchLabel: string
  model: string
  cost: string
  running: boolean
  changedFiles: number
  changedFilePaths: readonly string[]
  added: number
  removed: number
  risk: string
  initialView: ExternalAgentWorkspaceView
  chat: JSX.Element
  changes: JSX.Element
  activity: JSX.Element
  composer: JSX.Element
  actions: JSX.Element
  onBack: () => void
  onRefresh: () => void
  onViewChange: (view: ExternalAgentWorkspaceView) => void
}) {
  const [state, setState] = createStore({ view: props.initialView })
  createEffect(() => setState("view", props.initialView))
  const openView = (view: ExternalAgentWorkspaceView) => {
    setState("view", view)
    props.onViewChange(view)
  }

  return (
    <SDKProvider directory={() => props.directory}>
      <DirectoryDataProvider directory={() => props.directory} server={() => props.server}>
        <TerminalProvider>
          <FileProvider>
            <section
              data-vector-external-agent-workspace
              data-workspace-id={props.id}
              data-workspace-directory={props.directory}
              data-active-view={state.view}
              class="flex size-full min-h-0 flex-col overflow-hidden bg-[#171719] text-white"
            >
              <header class="flex h-[68px] shrink-0 items-center gap-3 border-b border-[color:var(--vx-line)] bg-[#1b1b1e] px-4">
                <button
                  type="button"
                  class="grid size-9 shrink-0 place-items-center rounded-[9px] text-white/50 transition hover:bg-white/[0.06] hover:text-white"
                  aria-label="Back to main agent"
                  title="Back to main agent"
                  onClick={props.onBack}
                >
                  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                    <path
                      d="M9.75 3.75 5.5 8l4.25 4.25"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
                <img src="/vector-logo.png" alt="" class="size-8 rounded-[9px] object-cover" draggable={false} />
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-2">
                    <h1 class="truncate text-[14px] font-semibold text-white">{props.name}</h1>
                    <span
                      class={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${props.statusTone}`}
                    >
                      {props.statusLabel}
                    </span>
                    <Show when={props.running}>
                      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-[color:var(--vx-purple-bright)]" />
                    </Show>
                  </div>
                  <p class="mt-0.5 truncate text-[10.5px] text-white/38">
                    {props.runtimeLabel} · {props.branchLabel} · {props.model}
                  </p>
                </div>
                <div class="hidden shrink-0 items-center gap-4 text-right md:flex">
                  <div>
                    <div class="text-[9.5px] uppercase tracking-[0.08em] text-white/25">Spend</div>
                    <div class="mt-0.5 text-[11px] tabular-nums text-white/60">{props.cost}</div>
                  </div>
                  <button
                    type="button"
                    class="grid size-8 place-items-center rounded-[8px] text-white/42 transition hover:bg-white/[0.06] hover:text-white"
                    aria-label={`Refresh ${props.runtimeLabel} activity`}
                    title="Refresh workspace"
                    onClick={props.onRefresh}
                  >
                    <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                      <path
                        d="M12.65 6.2A4.9 4.9 0 1 0 12 10.8M12.65 6.2V2.9m0 3.3h-3.3"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </header>

              <div
                role="tablist"
                aria-label="Agent workspace views"
                class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[color:var(--vx-line)] bg-[#19191c] px-4"
              >
                <For each={externalAgentWorkspaceTabs}>
                  {(tab) => (
                    <button
                      type="button"
                      role="tab"
                      data-agent-workspace-tab={tab.value}
                      class="relative h-10 shrink-0 px-3 text-[11.5px] font-medium transition"
                      classList={{
                        "text-white": state.view === tab.value,
                        "text-white/38 hover:text-white/70": state.view !== tab.value,
                      }}
                      aria-selected={state.view === tab.value}
                      onClick={() => openView(tab.value)}
                    >
                      {tab.label}
                      <Show when={tab.value === "changes" && props.changedFiles > 0}>
                        <span class="ml-1.5 rounded-full bg-[color:var(--vx-purple-soft)] px-1.5 py-0.5 text-[9px] tabular-nums text-[color:var(--vx-purple-bright)]">
                          {props.changedFiles}
                        </span>
                      </Show>
                      <Show when={state.view === tab.value}>
                        <span class="absolute inset-x-2 bottom-0 h-px bg-[color:var(--vx-purple-bright)]" />
                      </Show>
                    </button>
                  )}
                </For>
                <div class="flex-1" />
                <span class="hidden text-[10px] text-white/25 sm:inline">Isolated workspace</span>
              </div>

              <div class="grid shrink-0 grid-cols-4 border-b border-[color:var(--vx-line)] bg-[#18181a] sm:grid-cols-5">
                <Stat label="Files" value={String(props.changedFiles)} />
                <Stat label="Added" value={`+${props.added}`} tone="text-emerald-300" />
                <Stat label="Removed" value={`-${props.removed}`} tone="text-rose-300" />
                <Stat label="Risk" value={props.risk} />
                <div class="hidden sm:block">
                  <Stat label="Runtime" value={props.runtimeLabel} />
                </div>
              </div>

              <div class="min-h-0 flex-1 overflow-hidden">
                <Show when={state.view === "chat"}>
                  <div class="flex size-full min-h-0 flex-col">
                    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                      <div class="mx-auto w-full max-w-[980px]">{props.chat}</div>
                    </div>
                    {props.composer}
                  </div>
                </Show>
                <Show when={state.view === "files"}>
                  <ExternalAgentFiles
                    changedFiles={() => props.changedFilePaths}
                    onClose={() => openView("chat")}
                    onReview={() => openView("changes")}
                  />
                </Show>
                <Show when={state.view === "changes"}>
                  <div class="size-full overflow-y-auto px-5 py-5">
                    <div class="mx-auto w-full max-w-[1180px]">{props.changes}</div>
                  </div>
                </Show>
                <Show when={state.view === "terminal"}>
                  <ExternalAgentTerminal />
                </Show>
                <Show when={state.view === "browser"}>
                  <div data-vector-agent-browser class="size-full min-h-0">
                    <Suspense fallback={<ToolLoading label="Opening browser" />}>
                      <PreviewPanel
                        sessionKey={`external-agent:${props.id}`}
                        contextId={`external-agent:${props.id}`}
                        directory={props.directory}
                        onClose={() => openView("chat")}
                      />
                    </Suspense>
                  </div>
                </Show>
                <Show when={state.view === "activity"}>
                  <div class="size-full overflow-y-auto px-5 py-5">
                    <div class="mx-auto w-full max-w-[1080px]">{props.activity}</div>
                  </div>
                </Show>
              </div>

              <footer class="flex min-h-[58px] shrink-0 flex-wrap items-center gap-2 border-t border-[color:var(--vx-line)] bg-[#1b1b1e] px-4 py-2.5">
                {props.actions}
              </footer>
            </section>
          </FileProvider>
        </TerminalProvider>
      </DirectoryDataProvider>
    </SDKProvider>
  )
}

function Stat(props: { label: string; value: string; tone?: string }) {
  return (
    <div class="min-w-0 border-r border-[color:var(--vx-line)] px-4 py-2.5 last:border-r-0">
      <div class="text-[9px] uppercase tracking-[0.08em] text-white/25">{props.label}</div>
      <div class={`mt-0.5 truncate text-[11.5px] font-medium capitalize ${props.tone ?? "text-white/70"}`}>
        {props.value}
      </div>
    </div>
  )
}

function ExternalAgentFiles(props: {
  changedFiles: () => readonly string[]
  onClose: () => void
  onReview: () => void
}) {
  const [portalMount, setPortalMount] = createSignal<HTMLDivElement>()

  return (
    <div
      ref={setPortalMount}
      data-vector-agent-files
      class="relative size-full min-h-0 overflow-hidden bg-[color:var(--vx-canvas)]"
    >
      <Show when={portalMount()}>
        {(mount) => (
          <Suspense fallback={<ToolLoading label="Opening isolated code editor" />}>
            <CodespaceWorkbench
              modified={props.changedFiles}
              kinds={() => new Map()}
              empty={() => <span>No changed files yet.</span>}
              diffs={() => []}
              focusReviewDiff={props.onReview}
              onClose={props.onClose}
              embedded
              portalMount={mount()}
            />
          </Suspense>
        )}
      </Show>
    </div>
  )
}

function ExternalAgentTerminal() {
  const terminal = useTerminal()
  const [state, setState] = createStore({ created: false })

  createEffect(() => {
    if (!terminal.ready() || terminal.all().length || state.created) return
    setState("created", true)
    terminal.new()
  })

  return (
    <div data-vector-agent-terminal class="flex size-full min-h-0 flex-col bg-[color:var(--vx-canvas)]">
      <div class="flex h-10 shrink-0 items-center border-b border-[color:var(--vx-line)] bg-[#18181a] px-2">
        <For each={terminal.all()}>
          {(pty) => (
            <div
              class="group flex h-8 min-w-[112px] max-w-[220px] items-center rounded-[6px] text-[11px] transition"
              classList={{
                "bg-white/[0.07] text-white/82": terminal.active() === pty.id,
                "text-white/38 hover:bg-white/[0.04] hover:text-white/68": terminal.active() !== pty.id,
              }}
            >
              <button
                type="button"
                class="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-left"
                onClick={() => terminal.open(pty.id)}
              >
                <span class="size-1.5 shrink-0 rounded-full bg-emerald-400/70" />
                <span class="min-w-0 flex-1 truncate">{pty.title || `Terminal ${pty.titleNumber}`}</span>
              </button>
              <button
                type="button"
                class="mr-1 grid size-4 shrink-0 place-items-center rounded text-white/25 opacity-0 transition hover:bg-white/[0.08] hover:text-white group-hover:opacity-100"
                aria-label={`Close ${pty.title || "terminal"}`}
                onClick={() => void terminal.close(pty.id)}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="ml-1 grid size-7 place-items-center rounded-[6px] text-white/35 transition hover:bg-white/[0.06] hover:text-white"
          aria-label="New terminal in isolated workspace"
          title="New terminal"
          onClick={() => terminal.new()}
        >
          +
        </button>
      </div>
      <div class="relative min-h-0 flex-1">
        <Show when={terminal.ready()} fallback={<ToolLoading label="Connecting terminal" />}>
          <Show when={terminal.active()} fallback={<ToolLoading label="Starting terminal" />} keyed>
            {(id) => {
              const operations = terminal.bind()
              return (
                <Show when={terminal.all().find((pty) => pty.id === id)}>
                  {(pty) => (
                    <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                      <Terminal
                        pty={pty()}
                        autoFocus
                        onConnect={() => operations.trim(id)}
                        onCleanup={operations.update}
                        onConnectError={() => void operations.clone(id)}
                      />
                    </div>
                  )}
                </Show>
              )
            }}
          </Show>
        </Show>
      </div>
    </div>
  )
}

function ToolLoading(props: { label: string }) {
  return (
    <div class="grid size-full place-items-center bg-[#151517] text-[11.5px] text-white/38">
      <div class="flex items-center gap-2">
        <span class="size-1.5 animate-pulse rounded-full bg-[color:var(--vx-purple-bright)]" />
        {props.label}…
      </div>
    </div>
  )
}
