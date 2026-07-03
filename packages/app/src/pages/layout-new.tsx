import { createEffect, createSignal, onCleanup, Show, Suspense, type ParentProps } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { HelpButton } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { usePlanMode } from "@/context/plan-mode"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme } from "@opencode-ai/ui/theme/context"

function storedText(key: string) {
  if (typeof localStorage === "undefined") return ""
  return localStorage.getItem(key) ?? ""
}

function slugify(input: string) {
  const slug = input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
  return slug || "vector-app"
}

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const planMode = usePlanMode()
  const command = useCommand()
  const dialog = useDialog()
  const layout = useLayout()
  const settings = useSettings()
  const theme = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const [leftSidebarOpen, setLeftSidebarOpen] = createSignal(true)
  const [toolsOpen, setToolsOpen] = createSignal(false)
  const [sidePanelOpen, setSidePanelOpen] = createSignal(false)
  const [sidePanelMode, setSidePanelMode] = createSignal<"web" | "files">("web")
  const [webAddress, setWebAddress] = createSignal("http://localhost:5173")
  const [webViewUrl, setWebViewUrl] = createSignal("")
  const [webFrameKey, setWebFrameKey] = createSignal(0)
  const [deployUrl, setDeployUrl] = createSignal(storedText("vector.deploy.url"))
  setNavigate(navigate)

  createEffect(() => setV2Toast(true))
  createEffect(() => layout.sidebar.close())
  createEffect(() => {
    const root = document.documentElement
    root.dataset.vectorTheme = theme.mode() === "light" ? "light" : "dark"
    root.dataset.vectorBackdrop = "none"
    root.dataset.vectorFont = "system"
    root.dataset.vectorSidebar = "classic"
  })

  const normalizeUrl = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return ""
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
    return `http://${trimmed}`
  }

  const openWebView = (value = webAddress()) => {
    const next = normalizeUrl(value)
    if (!next) return
    setWebAddress(next)
    setWebViewUrl(next)
    setWebFrameKey((key) => key + 1)
    setSidePanelMode("web")
    setSidePanelOpen(true)
  }

  const webFrameSrc = () => {
    const url = webViewUrl()
    if (!url) return ""
    return `${url}${url.includes("?") ? "&" : "?"}vector_preview_reload=${webFrameKey()}`
  }

  const openSidePanel = (mode: "web" | "files") => {
    setSidePanelMode(mode)
    setSidePanelOpen(true)
  }

  const toggleTheme = () => {
    theme.setColorScheme(theme.mode() === "dark" ? "light" : "dark")
  }

  const openReviewPanel = () => {
    setSidePanelOpen(false)
    setToolsOpen(false)
    command.trigger("review.toggle")
  }

  const openFilePicker = () => {
    settings.general.setShowFileTree(true)
    layout.fileTree.setTab("all")
    layout.fileTree.open()
    setSidePanelOpen(false)
    setToolsOpen(false)
    queueMicrotask(() => command.trigger("file.open"))
  }

  const openTerminalPanel = () => {
    setSidePanelOpen(false)
    setToolsOpen(false)
    command.trigger("terminal.toggle")
  }

  const createDeployLink = () => {
    const seed = slugify(webViewUrl() || webAddress() || "vector-app")
    const suffix = Math.random().toString(36).slice(2, 8)
    const next = `https://${seed}-${suffix}.vectordev.ai`
    setDeployUrl(next)
    localStorage.setItem("vector.deploy.url", next)
    void navigator.clipboard?.writeText(next).catch(() => undefined)
    openSidePanel("web")
  }

  const copyDeployLink = () => {
    const value = deployUrl()
    if (!value) return
    void navigator.clipboard?.writeText(value).catch(() => undefined)
  }

  const taskRoute = () => /\/session\/[^/?#]+/.test(location.pathname)

  const openSettings = () => {
    setLeftSidebarOpen(false)
    void import("@/components/settings-v2/dialog-settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  const openNewTask = () => {
    setLeftSidebarOpen(false)
    navigate("/new-session")
  }

  const openProjects = () => {
    setLeftSidebarOpen(false)
    navigate("/")
  }

  const openModelSettings = () => {
    setLeftSidebarOpen(false)
    command.trigger("model.choose")
  }

  const openHelp = () => {
    setLeftSidebarOpen(false)
    platform.openLink("mailto:contact.astr0gpt@gmail.com")
  }

  let lastPath = ""
  createEffect(() => {
    const path = location.pathname
    if (path !== lastPath) {
      lastPath = path
      setToolsOpen(false)
      setSidePanelOpen(false)
    }
    if (taskRoute()) return
    setToolsOpen(false)
    setSidePanelOpen(false)
  })

  const handleGlobalKeyDown = (event: KeyboardEvent) => {
    if (!event.shiftKey || event.key !== "Tab") return
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
      class="relative bg-[#111112] flex-1 min-h-0 min-w-0 flex flex-col select-none text-[#f4f4f5] [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar update={update} />
      <main
        class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict transition-[padding] duration-200"
        style={{ "padding-left": leftSidebarOpen() ? "330px" : "56px" }}
      >
        <Suspense>{props.children}</Suspense>
      </main>

      <nav class="fixed inset-y-0 left-0 z-50 flex w-14 flex-col items-center border-r border-[#2a2a2d] bg-[#181818]/96 py-3 text-white/58 shadow-[14px_0_44px_rgba(0,0,0,0.28)] backdrop-blur-2xl">
        <button
          type="button"
          class="grid size-9 place-items-center rounded-xl border border-[#2b2b30] bg-[#1b1b1d]/92 text-white/70 transition hover:border-[#9b6cff]/55 hover:bg-[#232127] hover:text-white"
          aria-label={leftSidebarOpen() ? "Close Vector navigation" : "Open Vector navigation"}
          aria-pressed={leftSidebarOpen()}
          title="Vector navigation"
          onClick={() => setLeftSidebarOpen((open) => !open)}
        >
          <Show
            when={leftSidebarOpen()}
            fallback={<img src="/vector-logo.png" alt="" class="size-5 rounded-md" />}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </Show>
        </button>
        <div class="mt-5 flex flex-1 flex-col items-center gap-2">
          <button
            type="button"
            class="grid size-9 place-items-center rounded-xl transition hover:bg-white/[0.06] hover:text-white"
            aria-label="New task"
            title="New task"
            onClick={openNewTask}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="M3 12.5h10M8 3v10M4 4.5h8" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
            </svg>
          </button>
          <button
            type="button"
            class="grid size-9 place-items-center rounded-xl transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Projects"
            title="Projects"
            onClick={openProjects}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="M2.75 5.5h10.5v7H2.75zM2.75 5.5l1.6-2h3.2l1.2 2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            class="grid size-9 place-items-center rounded-xl transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Models"
            title="Models"
            onClick={openModelSettings}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="M3.5 5.5h9M3.5 10.5h9M6 3.5v4M10 8.5v4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <div class="flex flex-col items-center gap-2">
          <button
            type="button"
            class="grid size-9 place-items-center rounded-xl transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Settings"
            title="Settings"
            onClick={openSettings}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="M8 5.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Zm0-3v1.5m0 8.5v1.5M3.93 3.93l1.06 1.06m6.02 6.02 1.06 1.06m1.68-4.07h-1.5m-8.5 0h-1.5m1.68 4.07 1.06-1.06m6.02-6.02 1.06-1.06" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            </svg>
          </button>
          <button
            type="button"
            class="grid size-9 place-items-center rounded-xl transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Help"
            title="Help"
            onClick={openHelp}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0-3.5v.1M6.35 6.25a1.72 1.72 0 0 1 1.72-1.5c1.02 0 1.78.63 1.78 1.55 0 1.45-1.85 1.37-1.85 2.7" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </nav>

      <aside
        class="fixed bottom-0 left-14 top-9 z-40 w-[274px] overflow-hidden border-r border-[#2a2a2d] bg-[#202020]/96 shadow-[14px_0_50px_rgba(0,0,0,0.28)] backdrop-blur-2xl transition duration-200"
        classList={{
          "pointer-events-auto translate-x-0 opacity-100": leftSidebarOpen(),
          "pointer-events-none -translate-x-[calc(100%+24px)] opacity-0": !leftSidebarOpen(),
        }}
      >
        <div class="flex h-full flex-col">
          <div class="flex items-center gap-3 border-b border-[#29292c] px-4 py-4">
            <img src="/vector-logo.png" alt="" class="size-8 rounded-lg" />
            <div>
              <div class="text-sm font-semibold text-white">Vector</div>
              <div class="text-xs text-white/42">Tasks, projects, settings.</div>
            </div>
          </div>
          <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-xl border border-[#9b6cff]/35 bg-[#9b6cff]/14 px-3 py-3 text-left text-white transition hover:border-[#b99cff]/65 hover:bg-[#9b6cff]/22"
              onClick={openNewTask}
            >
              <svg viewBox="0 0 16 16" class="size-4 text-[#c5adff]" aria-hidden="true">
                <path d="M3 12.5h10M8 3v10M4 4.5h8" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
              </svg>
              <span>
                <span class="block text-sm font-semibold">New task</span>
                <span class="mt-0.5 block text-xs text-white/45">Start a fresh coding session.</span>
              </span>
            </button>

            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-white/76 transition hover:border-[#9b6cff]/40 hover:text-white"
              onClick={openProjects}
            >
              <svg viewBox="0 0 16 16" class="size-4 text-white/45" aria-hidden="true">
                <path d="M2.75 5.5h10.5v7H2.75zM2.75 5.5l1.6-2h3.2l1.2 2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
              </svg>
              <span>
                <span class="block text-sm font-semibold">Projects</span>
                <span class="mt-0.5 block text-xs text-white/42">Open or add a workspace.</span>
              </span>
            </button>

            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-white/76 transition hover:border-[#9b6cff]/40 hover:text-white"
              onClick={openModelSettings}
            >
              <svg viewBox="0 0 16 16" class="size-4 text-white/45" aria-hidden="true">
                <path d="M3.5 5.5h9M3.5 10.5h9M6 3.5v4M10 8.5v4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
              </svg>
              <span>
                <span class="block text-sm font-semibold">Models</span>
                <span class="mt-0.5 block text-xs text-white/42">Choose or connect providers.</span>
              </span>
            </button>
          </div>
          <div class="border-t border-[#29292c] p-3">
            <button
              type="button"
              class="mb-2 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-white/64 transition hover:bg-white/[0.055] hover:text-white"
              onClick={openSettings}
            >
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path d="M8 5.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Zm0-3v1.5m0 8.5v1.5M3.93 3.93l1.06 1.06m6.02 6.02 1.06 1.06m1.68-4.07h-1.5m-8.5 0h-1.5m1.68 4.07 1.06-1.06m6.02-6.02 1.06-1.06" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
              </svg>
              <span class="text-sm font-medium">Settings</span>
            </button>
            <button
              type="button"
              class="mb-2 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-white/64 transition hover:bg-white/[0.055] hover:text-white"
              onClick={toggleTheme}
            >
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path
                  d="M8 2.5a5.5 5.5 0 1 0 0 11 4.2 4.2 0 0 1 0-11Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="text-sm font-medium">{theme.mode() === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-white/64 transition hover:bg-white/[0.055] hover:text-white"
              onClick={openHelp}
            >
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path d="M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0-3.5v.1M6.35 6.25a1.72 1.72 0 0 1 1.72-1.5c1.02 0 1.78.63 1.78 1.55 0 1.45-1.85 1.37-1.85 2.7" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
              </svg>
              <span class="text-sm font-medium">Help</span>
            </button>
          </div>
        </div>
      </aside>

      <Show when={taskRoute()}>
        <button
          type="button"
          class="fixed right-3 top-3 z-50 grid size-9 place-items-center rounded-xl border border-[#2b2b30] bg-[#1b1b1d]/92 text-white/70 shadow-[0_18px_52px_rgba(0,0,0,0.35)] backdrop-blur-xl transition hover:border-[#9b6cff]/55 hover:bg-[#232127] hover:text-white"
          aria-label={toolsOpen() ? "Close Vector tools" : "Open Vector tools"}
          aria-pressed={toolsOpen()}
          title="Vector tools"
          onClick={() => setToolsOpen((open) => !open)}
        >
          <Show
            when={toolsOpen()}
            fallback={
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path
                  d="M3 4.5h10M3 8h10M3 11.5h10"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </svg>
            }
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </Show>
        </button>
      </Show>

      <aside
        class="fixed bottom-0 right-0 top-9 z-40 w-[318px] overflow-hidden border-l border-[#2a2a2d] bg-[#202020]/96 shadow-[-14px_0_50px_rgba(0,0,0,0.28)] backdrop-blur-2xl transition duration-200"
        classList={{
          "pointer-events-auto translate-x-0 opacity-100": toolsOpen(),
          "pointer-events-none translate-x-[calc(100%+24px)] opacity-0": !toolsOpen(),
        }}
      >
        <div class="flex h-full flex-col">
          <div class="flex items-center gap-3 border-b border-[#29292c] px-4 py-4">
            <img src="/vector-logo.png" alt="" class="size-8 rounded-lg" />
            <div>
              <div class="text-sm font-semibold text-white">Vector tools</div>
              <div class="text-xs text-white/42">Plan, preview, review, deploy.</div>
            </div>
          </div>
          <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            <button
              type="button"
              class="flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left transition"
              classList={{
                "border-[#9b6cff]/55 bg-[#9b6cff]/16 text-white": planMode.enabled(),
                "border-[#2a2a2d] bg-white/[0.035] text-white/76 hover:border-[#9b6cff]/40 hover:text-white":
                  !planMode.enabled(),
              }}
              onClick={() => planMode.toggle()}
            >
              <span>
                <span class="block text-sm font-semibold">Plan Mode</span>
                <span class="mt-0.5 block text-xs text-white/42">Shift Tab</span>
              </span>
              <span class="rounded-full border border-[#2b2b30] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-white/52">
                {planMode.enabled() ? "On" : "Off"}
              </span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-between rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-white/76 transition hover:border-[#9b6cff]/40 hover:text-white"
              onClick={() => openSidePanel("web")}
            >
              <span>
                <span class="block text-sm font-semibold">Web preview</span>
                <span class="mt-0.5 block text-xs text-white/42">Open localhost beside Vector</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-4 text-white/42" aria-hidden="true">
                <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-between rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-white/76 transition hover:border-[#9b6cff]/40 hover:text-white"
              onClick={() => openSidePanel("files")}
            >
              <span>
                <span class="block text-sm font-semibold">Files & code</span>
                <span class="mt-0.5 block text-xs text-white/42">Open files, diffs, and code</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-4 text-white/42" aria-hidden="true">
                <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-between rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-white/76 transition hover:border-[#9b6cff]/40 hover:text-white"
              onClick={openReviewPanel}
            >
              <span>
                <span class="block text-sm font-semibold">Review changes</span>
                <span class="mt-0.5 block text-xs text-white/42">Inspect generated diffs</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-4 text-white/42" aria-hidden="true">
                <path d="m3.5 8 2.75 2.75L12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-between rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-white/76 transition hover:border-[#9b6cff]/40 hover:text-white"
              onClick={openTerminalPanel}
            >
              <span>
                <span class="block text-sm font-semibold">Terminal</span>
                <span class="mt-0.5 block text-xs text-white/42">Open the project terminal</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-4 text-white/42" aria-hidden="true">
                <path d="m4 5 3 3-3 3m4.5 0H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-between rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-white/76 transition hover:border-[#9b6cff]/40 hover:text-white"
              onClick={openReviewPanel}
            >
              <span>
                <span class="block text-sm font-semibold">Usage</span>
                <span class="mt-0.5 block text-xs text-white/42">View session tokens and cost</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-4 text-white/42" aria-hidden="true">
                <path d="M3 12.5V8m3.3 4.5v-8m3.4 8v-5m3.3 5v-10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-between rounded-xl border border-[#9b6cff]/35 bg-[#9b6cff]/12 px-3 py-3 text-left text-white transition hover:border-[#b99cff]/60 hover:bg-[#9b6cff]/18"
              onClick={createDeployLink}
            >
              <span>
                <span class="block text-sm font-semibold">Deploy link</span>
                <span class="mt-0.5 block text-xs text-white/46">Create a shareable Vector URL</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-4 text-[#c5adff]" aria-hidden="true">
                <path
                  d="M8 13V3.5m0 0L4.5 7M8 3.5 11.5 7M3.5 12.5h9"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.45"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>

            <Show when={deployUrl()}>
              {(url) => (
                <div class="rounded-xl border border-[#9b6cff]/20 bg-[#9b6cff]/8 p-3">
                  <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#c5adff]">Latest deploy</div>
                  <div class="mt-2 truncate text-xs text-white/68">{url()}</div>
                  <button
                    type="button"
                    class="mt-3 rounded-lg border border-[#2b2b30] px-2.5 py-1.5 text-xs font-semibold text-white/70 transition hover:border-[#9b6cff]/45 hover:text-white"
                    onClick={copyDeployLink}
                  >
                    Copy link
                  </button>
                </div>
              )}
            </Show>
          </div>
        </div>
      </aside>

      <aside
        class="fixed bottom-4 top-14 z-50 w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-[#2b2b30] bg-[#151518]/96 shadow-[0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl transition duration-200 ease-out"
        style={{ right: toolsOpen() ? "334px" : "16px" }}
        classList={{
          "pointer-events-auto translate-x-0 opacity-100": sidePanelOpen(),
          "pointer-events-none translate-x-[calc(100%+32px)] opacity-0": !sidePanelOpen(),
        }}
      >
        <div class="flex h-full flex-col">
          <div class="flex items-center justify-between border-b border-[#2a2a2d] px-4 py-3">
            <div class="flex rounded-full bg-white/[0.045] p-1">
              <button
                type="button"
                class="rounded-full px-3 py-1.5 text-xs font-semibold transition"
                classList={{
                  "bg-[#9b6cff] text-white": sidePanelMode() === "web",
                  "text-white/[0.55] hover:text-white": sidePanelMode() !== "web",
                }}
                onClick={() => setSidePanelMode("web")}
              >
                Web preview
              </button>
              <button
                type="button"
                class="rounded-full px-3 py-1.5 text-xs font-semibold transition"
                classList={{
                  "bg-[#9b6cff] text-white": sidePanelMode() === "files",
                  "text-white/[0.55] hover:text-white": sidePanelMode() !== "files",
                }}
                onClick={() => setSidePanelMode("files")}
              >
                Files & code
              </button>
            </div>
            <button
              type="button"
              class="grid size-8 place-items-center rounded-full text-white/[0.55] transition hover:bg-white/10 hover:text-white"
              aria-label="Close side panel"
              onClick={() => setSidePanelOpen(false)}
            >
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <Show
            when={sidePanelMode() === "web"}
            fallback={
              <div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
                <div class="rounded-2xl border border-[#2a2a2d] bg-white/[0.035] p-4">
                  <div class="text-sm font-semibold text-white">Files & code</div>
                  <p class="mt-2 text-xs leading-5 text-white/[0.55]">
                    Use Vector's real file tree, code opener, review panel, and terminal instead of a mock preview.
                  </p>
                </div>
                <div class="grid gap-2">
                  <button
                    type="button"
                    class="rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-sm font-semibold text-white/78 transition hover:border-[#9b6cff]/45 hover:text-white"
                    onClick={openFilePicker}
                  >
                    Open file tree and code
                    <span class="mt-1 block text-xs font-normal text-white/42">Browse every project file and open source code.</span>
                  </button>
                  <button
                    type="button"
                    class="rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-sm font-semibold text-white/78 transition hover:border-[#9b6cff]/45 hover:text-white"
                    onClick={openReviewPanel}
                  >
                    Review generated diffs
                    <span class="mt-1 block text-xs font-normal text-white/42">Inspect files Vector created or changed.</span>
                  </button>
                  <button
                    type="button"
                    class="rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-sm font-semibold text-white/78 transition hover:border-[#9b6cff]/45 hover:text-white"
                    onClick={openTerminalPanel}
                  >
                    Open terminal
                    <span class="mt-1 block text-xs font-normal text-white/42">Run dev servers and commands beside the task.</span>
                  </button>
                </div>
              </div>
            }
          >
            <div class="flex min-h-0 flex-1 flex-col bg-[#0f0f11]">
              <form
                class="flex items-center gap-2 border-b border-[#2a2a2d] px-4 py-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  openWebView()
                }}
              >
                <div class="flex gap-1.5">
                  <span class="size-2.5 rounded-full bg-[#ff5f57]" />
                  <span class="size-2.5 rounded-full bg-[#febc2e]" />
                  <span class="size-2.5 rounded-full bg-[#28c840]" />
                </div>
                <input
                  class="min-w-0 flex-1 rounded-full border border-[#2a2a2d] bg-white/[0.045] px-3 py-1.5 text-xs text-white outline-none transition placeholder:text-white/[0.32] focus:border-[#9b6cff]/60"
                  value={webAddress()}
                  placeholder="http://localhost:5173"
                  onInput={(event) => setWebAddress(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  class="rounded-full bg-white/[0.08] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#9b6cff]/35"
                >
                  Open
                </button>
              </form>
              <div class="flex gap-2 border-b border-[#26262a] px-4 py-2">
                {["5173", "3000", "4173", "8080"].map((port) => (
                  <button
                    type="button"
                    class="rounded-full border border-[#2a2a2d] px-2.5 py-1 text-[10px] font-medium text-white/[0.55] transition hover:border-[#9b6cff]/50 hover:text-white"
                    onClick={() => openWebView(`http://localhost:${port}`)}
                  >
                    :{port}
                  </button>
                ))}
                <button
                  type="button"
                  class="ml-auto rounded-full border border-[#2a2a2d] px-2.5 py-1 text-[10px] font-medium text-white/[0.55] transition hover:border-[#9b6cff]/50 hover:text-white"
                  onClick={() => {
                    if (webViewUrl()) setWebFrameKey((key) => key + 1)
                  }}
                >
                  Reload
                </button>
              </div>
              <Show when={deployUrl()}>
                {(url) => (
                  <div class="flex items-center gap-2 border-b border-[#9b6cff]/14 bg-[#9b6cff]/8 px-4 py-2">
                    <div class="min-w-0 flex-1">
                      <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#c5adff]">Deploy link</div>
                      <div class="truncate text-xs font-medium text-white/72">{url()}</div>
                    </div>
                    <button
                      type="button"
                      class="rounded-full border border-[#2a2a2d] px-2.5 py-1 text-[10px] font-semibold text-white/65 transition hover:border-[#9b6cff]/50 hover:text-white"
                      onClick={copyDeployLink}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </Show>
              <div class="relative min-h-0 flex-1 bg-[#08080a]">
                <Show
                  when={webViewUrl()}
                  fallback={
                    <div class="grid h-full place-items-center p-6 text-center">
                      <div>
                        <img
                          src="/vector-logo.png"
                          alt=""
                          class="mx-auto size-14 rounded-2xl shadow-[0_18px_40px_rgba(155,108,255,0.2)]"
                        />
                        <h2 class="mt-5 text-lg font-semibold text-white">Web preview</h2>
                        <p class="mt-2 max-w-[290px] text-xs leading-5 text-white/[0.52]">
                          Run a local app, then open its localhost URL here beside the session.
                        </p>
                      </div>
                    </div>
                  }
                >
                  <iframe
                    src={webFrameSrc()}
                    title="Vector web preview"
                    class="h-full w-full border-0 bg-white"
                    sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"
                  />
                </Show>
                <Show when={deployUrl()}>
                  <a
                    href="https://vectordev.ai"
                    target="_blank"
                    rel="noreferrer"
                    class="absolute right-3 top-3 z-10 inline-flex items-center gap-2 rounded-full border border-[#c8b4ff]/75 bg-[#150d28]/90 px-3 py-2 text-xs font-semibold text-white shadow-[0_14px_42px_rgba(0,0,0,0.38)] backdrop-blur-xl transition hover:bg-[#241044]"
                  >
                    <img src="/vector-logo.png" alt="" class="size-5 rounded-md" />
                    Deployed with vector.ai
                  </a>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </aside>

      {import.meta.env.DEV && <DebugBar inline />}
      <HelpButton />
      <ToastRegion v2 />
    </div>
  )
}
