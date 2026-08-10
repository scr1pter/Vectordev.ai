import { For, Show, type JSX } from "solid-js"
import type { UpdaterState } from "@/updater"

export type WorkspaceNavigationItem = {
  id: string
  name: string
  status: string
  runtime: string
  added: number
  removed: number
  active: boolean
  running: boolean
  reviewable: boolean
  removable: boolean
  removeArmed: boolean
}

const statusTone = (status: string) => {
  if (status === "failed") return "bg-rose-400"
  if (status === "waiting for approval" || status === "needs review") return "bg-amber-300"
  if (status === "complete" || status === "merged") return "bg-emerald-400"
  if (status === "stopped" || status === "discarded") return "bg-white/30"
  return "bg-[color:var(--vx-purple-bright)]"
}

const statusTextTone = (status: string) => {
  if (status === "failed") return "text-rose-300"
  if (status === "waiting for approval" || status === "needs review") return "text-amber-200"
  if (status === "complete" || status === "merged") return "text-emerald-300"
  if (status === "stopped" || status === "discarded") return "text-white/34"
  return "text-[color:var(--vx-purple-bright)]"
}

const Icon = (props: { children: JSX.Element }) => (
  <span class="grid size-[18px] shrink-0 place-items-center text-white/42">{props.children}</span>
)

const BranchIcon = () => (
  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
    <path
      d="M4.15 2.25v6.2a2.65 2.65 0 0 0 2.65 2.65h2.45M4.15 2.25a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm7.7 8.85a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm0 0V5.8A2.65 2.65 0 0 0 9.2 3.15H7.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.15"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

export function WorkspaceNavigation(props: {
  width: number
  minimumWidth: number
  maximumWidth: number
  macDesktop: boolean
  visible: boolean
  resizing: boolean
  projectName: string
  mainLabel: string
  mainActive: boolean
  treeOpen: boolean
  items: WorkspaceNavigationItem[]
  activeTool?: "browser" | "canvas"
  scheduledCount: number
  currentVersion?: string
  updaterState?: UpdaterState
  onResizeStart: (event: PointerEvent) => void
  onResize: (width: number) => void
  onResetWidth: () => void
  onHome: () => void
  onHide: () => void
  onToggleTree: () => void
  onNewWorkspace: () => void
  onOrchestrate: () => void
  onOpenMain: () => void
  onOpenWorkspace: (id: string) => void
  onReviewWorkspace: (id: string) => void
  onRemoveWorkspace: (id: string) => void
  onMoveWorkspace: (sourceID: string, targetID: string) => void
  onCodeEditor: () => void
  onBrowser: () => void
  onCanvas: () => void
  onScheduled: () => void
  onMcp: () => void
  onPlugins: () => void
  onFind: () => void
  onSettings: () => void
  onGettingStarted: () => void
  onUpdate: () => void
}) {
  const updateBusy = () => ["checking", "downloading", "installing"].includes(props.updaterState?.status ?? "")
  const updateDetail = () => {
    const state = props.updaterState
    if (!state) return ""
    if (state.status === "checking") return "Checking…"
    if (state.status === "downloading") return `Downloading v${state.version}…`
    if (state.status === "ready") return `v${state.version} available`
    if (state.status === "installing") return "Restarting…"
    if (state.status === "up-to-date") return props.currentVersion ? `v${props.currentVersion} · Latest` : "Latest"
    if (state.status === "error") return "Try again"
    return props.currentVersion ? `v${props.currentVersion} · Check` : "Check now"
  }

  return (
    <nav
      data-vector-navigation
      class="fixed inset-y-0 left-0 z-50 flex flex-col text-white/70 transition-opacity duration-200"
      style={{
        width: `${props.width}px`,
        "padding-top": props.macDesktop ? "48px" : "0px",
        display: props.visible ? undefined : "none",
      }}
    >
      <div
        data-vector-nav-top
        class="flex h-[54px] shrink-0 items-center gap-2 border-b border-[color:var(--vx-line)] px-3"
      >
        <button
          type="button"
          data-vector-nav-home
          class="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-[5px] px-2 text-left text-[13px] font-medium text-white/72 transition hover:bg-white/[0.055] hover:text-white"
          onClick={props.onHome}
        >
          <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
            <path
              d="M3 7.15 8 3l5 4.15v5.6a.75.75 0 0 1-.75.75h-2.6V9.9h-3.3v3.6h-2.6A.75.75 0 0 1 3 12.75v-5.6Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linejoin="round"
            />
          </svg>
          <span class="truncate">Home</span>
        </button>
        <button
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-[5px] text-white/38 transition hover:bg-white/[0.055] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
          onClick={props.onFind}
          title="Find in project"
          aria-label="Find in project"
        >
          <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
            <path
              d="M7.1 12.1a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm3.55-1.45 3 3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button
          type="button"
          class="grid size-8 shrink-0 place-items-center rounded-[5px] text-white/38 transition hover:bg-white/[0.055] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(147,116,236,0.55)]"
          aria-label="Hide Vector sidebar"
          title="Hide Vector sidebar"
          onClick={props.onHide}
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

      <div data-vector-nav-scroll class="min-h-0 flex-1 overflow-y-auto">
        <section data-vector-project-group>
          <button
            type="button"
            data-vector-project-heading
            class="flex h-10 w-full items-center gap-2 px-3.5 text-left text-[12px] font-semibold text-white/78 transition hover:bg-white/[0.025] hover:text-white"
            onClick={props.onToggleTree}
            aria-expanded={props.treeOpen}
          >
            <svg
              viewBox="0 0 16 16"
              class="size-3.5 shrink-0 text-white/35 transition-transform duration-150"
              classList={{ "-rotate-90": !props.treeOpen }}
              aria-hidden="true"
            >
              <path
                d="m4.75 6.25 3.25 3 3.25-3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="min-w-0 flex-1 truncate">{props.projectName}</span>
            <span class="shrink-0 text-[10px] font-normal tabular-nums text-white/30">{props.items.length + 1}</span>
          </button>

          <Show when={props.treeOpen}>
            <div data-vector-workspace-actions class="flex items-center gap-1 px-2.5 pb-1.5">
              <button
                type="button"
                data-tour="nav-new-workspace"
                class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[5px] px-2 text-left text-[12px] text-white/52 transition hover:bg-white/[0.05] hover:text-white"
                onClick={props.onNewWorkspace}
              >
                <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
                  <path
                    d="M8 3.25v9.5M3.25 8h9.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                  />
                </svg>
                <span class="truncate">New workspace</span>
              </button>
              <button
                type="button"
                class="grid size-8 shrink-0 place-items-center rounded-[5px] text-white/32 transition hover:bg-white/[0.05] hover:text-white"
                onClick={props.onOrchestrate}
                title="Coordinate agents"
                aria-label="Coordinate agents"
              >
                <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                  <path
                    d="M3 4.15h3v3H3zM10 2.6h3v3h-3zM10 10.4h3v3h-3zM6 5.65h1.1A2.9 2.9 0 0 0 10 2.75M6 5.65h1.1A2.9 2.9 0 0 1 10 8.55v3.35"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.1"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>

            <div data-vector-workspace-list class="space-y-px px-2 pb-3">
              <button
                type="button"
                data-vector-workspace-row
                data-active={props.mainActive ? "true" : "false"}
                class="group relative flex min-h-[50px] w-full items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 text-left transition"
                classList={{
                  "bg-white/[0.075] text-white": props.mainActive,
                  "text-white/62 hover:bg-white/[0.045] hover:text-white": !props.mainActive,
                }}
                onClick={props.onOpenMain}
              >
                <Icon>
                  <BranchIcon />
                </Icon>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12px] font-medium">{props.mainLabel}</span>
                  <span class="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-white/34">
                    <span class="size-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span class="truncate">main · Ready</span>
                  </span>
                </span>
                <span class="shrink-0 rounded-[4px] border border-white/[0.08] px-1.5 py-0.5 text-[9.5px] text-white/32">
                  main
                </span>
              </button>

              <For each={props.items}>
                {(item, index) => (
                  <div
                    data-vector-workspace-row
                    data-active={item.active ? "true" : "false"}
                    data-status={item.status}
                    class="group relative rounded-[5px] transition"
                    classList={{ "bg-white/[0.075]": item.active, "hover:bg-white/[0.045]": !item.active }}
                    draggable={true}
                    onDragStart={(event) => {
                      event.dataTransfer?.setData("text/vector-agent-workspace", item.id)
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                    }}
                    onDragOver={(event) => {
                      if (!event.dataTransfer?.types.includes("text/vector-agent-workspace")) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = "move"
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      const sourceID = event.dataTransfer?.getData("text/vector-agent-workspace")
                      if (!sourceID || sourceID === item.id) return
                      props.onMoveWorkspace(sourceID, item.id)
                    }}
                  >
                    <button
                      type="button"
                      class="flex min-h-[55px] w-full items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 pr-[78px] text-left"
                      onClick={() => props.onOpenWorkspace(item.id)}
                      title={`${item.name} · ${item.status}`}
                    >
                      <span class="relative grid size-[18px] shrink-0 place-items-center text-white/42">
                        <Show when={item.running}>
                          <span class="absolute size-4 animate-ping rounded-full bg-[color:var(--vx-purple-bright)]/12" />
                        </Show>
                        <BranchIcon />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[12px] font-medium text-white/82">{item.name}</span>
                        <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-white/34">
                          <span class={`size-1.5 shrink-0 rounded-full ${statusTone(item.status)}`} />
                          <span class={`truncate capitalize ${statusTextTone(item.status)}`}>{item.status}</span>
                          <span class="shrink-0 text-white/18">·</span>
                          <span class="truncate">{item.runtime}</span>
                        </span>
                      </span>
                    </button>

                    <div class="absolute right-2 top-2 flex items-center gap-1">
                      <span class="flex h-6 items-center gap-1 rounded-[4px] border border-white/[0.07] bg-black/10 px-1.5 text-[10px] tabular-nums opacity-100 transition group-hover:opacity-0">
                        <span class="text-emerald-400">+{item.added}</span>
                        <span class="text-rose-400">-{item.removed}</span>
                      </span>
                      <div class="absolute right-0 top-0 hidden items-center gap-0.5 group-hover:flex">
                        <Show when={item.reviewable}>
                          <button
                            type="button"
                            class="grid size-6 place-items-center rounded-[4px] bg-[#343235] text-white/45 transition hover:bg-white/[0.09] hover:text-white"
                            title="Review changes"
                            aria-label={`Review changes from ${item.name}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              props.onReviewWorkspace(item.id)
                            }}
                          >
                            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                              <path
                                d="M3.25 3.5h9.5v9h-9.5zM5.4 6h5.2M5.4 8h5.2M5.4 10h3.1"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.1"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                        </Show>
                        <Show when={item.removable}>
                          <button
                            type="button"
                            class="grid size-6 place-items-center rounded-[4px] bg-[#343235] text-white/42 transition hover:bg-rose-400/10 hover:text-rose-300"
                            classList={{ "text-rose-300": item.removeArmed }}
                            title={item.removeArmed ? "Click again to remove" : "Close workspace"}
                            aria-label={item.removeArmed ? "Click again to remove workspace" : "Close workspace"}
                            onClick={(event) => {
                              event.stopPropagation()
                              props.onRemoveWorkspace(item.id)
                            }}
                          >
                            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                              <path
                                d="m4.5 4.5 7 7m0-7-7 7"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.25"
                                stroke-linecap="round"
                              />
                            </svg>
                          </button>
                        </Show>
                      </div>
                    </div>
                    <span class="pointer-events-none absolute bottom-1.5 right-2 text-[9px] tabular-nums text-white/20 group-hover:opacity-0">
                      #{index() + 1}
                    </span>
                  </div>
                )}
              </For>

              <Show when={!props.items.length}>
                <div class="px-3 py-2 text-[10.5px] leading-4 text-white/28">
                  Launch an isolated workspace to run another agent without touching main.
                </div>
              </Show>
            </div>
          </Show>
        </section>

        <section data-vector-nav-group class="border-t border-[color:var(--vx-line)] px-2 py-3">
          <div data-vector-nav-label>Project tools</div>
          <button type="button" data-vector-nav-item data-tour="nav-code-editor" onClick={props.onCodeEditor}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <path
                d="M5.25 5 2.75 8l2.5 3M10.75 5l2.5 3-2.5 3M9.15 3.75l-2.3 8.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>Code editor</span>
          </button>
          <button
            type="button"
            data-vector-nav-item
            data-tour="nav-browser"
            classList={{ active: props.activeTool === "browser" }}
            onClick={props.onBrowser}
          >
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <rect
                x="2.25"
                y="3"
                width="11.5"
                height="10"
                rx="1.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
              <path
                d="M2.75 5.45h10.5M4.4 4.2h.01M6 4.2h.01"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
              />
            </svg>
            <span>Browser</span>
          </button>
          <button
            type="button"
            data-vector-nav-item
            data-tour="nav-canvas"
            classList={{ active: props.activeTool === "canvas" }}
            onClick={props.onCanvas}
          >
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <rect
                x="2.4"
                y="3.4"
                width="11.2"
                height="9.2"
                rx="1.4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
              />
              <path
                d="M5.4 6.2h3v2.4h-3zM9.2 6.2h1.9M9.2 8.1h1.9M5.4 10h5"
                fill="none"
                stroke="currentColor"
                stroke-width="1"
                stroke-linecap="round"
              />
            </svg>
            <span>Canvas</span>
          </button>
        </section>

        <section data-vector-nav-group class="border-t border-[color:var(--vx-line)] px-2 py-3">
          <div data-vector-nav-label>Connections</div>
          <button type="button" data-vector-nav-item data-tour="nav-scheduled" onClick={props.onScheduled}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <path
                d="M8 2.55a5.45 5.45 0 1 0 0 10.9 5.45 5.45 0 0 0 0-10.9Zm0 2.6v3.1l2.15 1.25"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="min-w-0 flex-1">Scheduled runs</span>
            <Show when={props.scheduledCount}>
              <span class="rounded-full bg-[color:var(--vx-purple)]/80 px-1.5 py-0.5 text-[9.5px] font-semibold text-white">
                {props.scheduledCount}
              </span>
            </Show>
          </button>
          <button type="button" data-vector-nav-item data-tour="nav-mcp" onClick={props.onMcp}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <path
                d="M3.25 5.25a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm9.5 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 14.75a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM4.95 4.3l1.8 6.5M11.05 4.3l-1.8 6.5M5.1 3.25h5.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>MCP</span>
          </button>
          <button type="button" data-vector-nav-item data-tour="nav-plugins" onClick={props.onPlugins}>
            <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true">
              <path
                d="M6.1 1.6v2.7M9.9 1.6v2.7M4.6 4.3h6.8v1.7a3.4 3.4 0 0 1-6.8 0V4.3ZM8 9.4v.9c0 1.5-3.2.9-3.2 2.4 0 1.4 2.7 1.6 4.6.9"
                fill="none"
                stroke="currentColor"
                stroke-width="1.15"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>Plugins</span>
          </button>
        </section>
      </div>

      <div
        data-vector-nav-footer
        class="grid min-h-[58px] shrink-0 grid-cols-[1fr_auto_auto] items-center gap-1 border-t border-[color:var(--vx-line)] px-3 py-2"
      >
        <Show
          when={props.updaterState && props.updaterState.status !== "disabled"}
          fallback={<div class="px-2 text-[11px] text-white/28">Updates unavailable</div>}
        >
          <button
            type="button"
            data-vector-update-action
            class="group flex h-9 min-w-0 items-center gap-2 rounded-[5px] px-2 text-left text-[12px] text-white/52 transition hover:bg-white/[0.05] hover:text-white disabled:cursor-wait disabled:opacity-65"
            disabled={updateBusy()}
            aria-busy={updateBusy()}
            title="Check, download, install, and restart Vector"
            onClick={props.onUpdate}
          >
            <svg
              viewBox="0 0 16 16"
              class="size-3.5 shrink-0 text-[color:var(--vx-purple-bright)]"
              classList={{ "animate-spin": props.updaterState?.status === "checking" }}
              aria-hidden="true"
            >
              <path
                d="M8 2.4v7.2m0 0 2.45-2.45M8 9.6 5.55 7.15M3 12.65h10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="min-w-0 flex-1 truncate font-medium">Update Vector</span>
            <span class="shrink-0 text-[9.5px] text-white/30 group-hover:text-white/48">{updateDetail()}</span>
          </button>
        </Show>
        <button
          type="button"
          data-tour="nav-getting-started"
          class="grid size-8 place-items-center rounded-[5px] text-white/38 transition hover:bg-white/[0.05] hover:text-white"
          onClick={props.onGettingStarted}
          title="Getting started"
          aria-label="Getting started"
        >
          <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
            <circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.15" />
            <path
              d="M6.2 6.25a1.85 1.85 0 0 1 3.6.55c0 1.15-1.8 1.35-1.8 2.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.15"
              stroke-linecap="round"
            />
            <circle cx="8" cy="11.35" r="0.7" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          class="grid size-8 place-items-center rounded-[5px] text-white/38 transition hover:bg-white/[0.05] hover:text-white"
          onClick={props.onSettings}
          title="Settings"
          aria-label="Settings"
        >
          <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
            <path
              d="M8 10.35A2.35 2.35 0 1 0 8 5.65a2.35 2.35 0 0 0 0 4.7Zm4.72-1.35a4.8 4.8 0 0 0 0-2l1.2-.92-1.2-2.08-1.42.58a5.1 5.1 0 0 0-1.72-1L9.4 2H6.6l-.18 1.58a5.1 5.1 0 0 0-1.72 1L3.28 4l-1.2 2.08 1.2.92a4.8 4.8 0 0 0 0 2l-1.2.92L3.28 12l1.42-.58a5.1 5.1 0 0 0 1.72 1L6.6 14h2.8l.18-1.58a5.1 5.1 0 0 0 1.72-1l1.42.58 1.2-2.08-1.2-.92Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.1"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <div
        data-vector-navigation-resizer
        role="separator"
        aria-label="Resize Vector sidebar"
        aria-orientation="vertical"
        aria-valuemin={props.minimumWidth}
        aria-valuemax={props.maximumWidth}
        aria-valuenow={props.width}
        tabIndex={0}
        class="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none focus-visible:outline-none"
        classList={{ "is-resizing": props.resizing }}
        title="Drag to resize. Double-click to reset."
        onPointerDown={props.onResizeStart}
        onDblClick={props.onResetWidth}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            props.onResize(props.width - (event.shiftKey ? 32 : 12))
            return
          }
          if (event.key === "ArrowRight") {
            event.preventDefault()
            props.onResize(props.width + (event.shiftKey ? 32 : 12))
            return
          }
          if (event.key === "Home") {
            event.preventDefault()
            props.onResize(props.minimumWidth)
            return
          }
          if (event.key === "End") {
            event.preventDefault()
            props.onResize(props.maximumWidth)
          }
        }}
      >
        <span class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-[color:var(--vx-purple)] group-focus-visible:bg-[color:var(--vx-purple-bright)]" />
      </div>
    </nav>
  )
}
