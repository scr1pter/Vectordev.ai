import { createEffect, createSignal, onCleanup, Show, Suspense, type ParentProps } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { usePlanMode } from "@/context/plan-mode"
import { usePlatform } from "@/context/platform"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"

const RAIL_WIDTH = "236px"
type BrowserAutomationReport = {
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
}
type BrowserAutomationRun = BrowserAutomationReport & {
  viewport: { width: number; height: number }
  screenshotDataUrl: string
  textSample: string
  console: { level: string; message: string }[]
  pageErrors: string[]
  actions: { label: string; ok: boolean; error?: string; result?: unknown }[]
  interactives: { tag: string; text: string; selector: string; role?: string; type?: string }[]
  inputs: { tag: string; selector: string; placeholder?: string; type?: string; name?: string }[]
}

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const planMode = usePlanMode()
  const command = useCommand()
  const dialog = useDialog()
  const layout = useLayout()
  const navigate = useNavigate()
  const location = useLocation()
  const [toolsOpen, setToolsOpen] = createSignal(false)
  const [sidePanelOpen, setSidePanelOpen] = createSignal(false)
  const [chatSearchOpen, setChatSearchOpen] = createSignal(false)
  const [chatSearchValue, setChatSearchValue] = createSignal("")
  const [webAddress, setWebAddress] = createSignal("http://localhost:5173")
  const [webViewUrl, setWebViewUrl] = createSignal("")
  const [webFrameKey, setWebFrameKey] = createSignal(0)
  const [browserBusy, setBrowserBusy] = createSignal(false)
  const [browserReport, setBrowserReport] = createSignal<BrowserAutomationReport | undefined>()
  const [browserRun, setBrowserRun] = createSignal<BrowserAutomationRun | undefined>()
  const [browserHistory, setBrowserHistory] = createSignal<BrowserAutomationReport[]>([])
  const [browserSelector, setBrowserSelector] = createSignal("")
  const [browserText, setBrowserText] = createSignal("")
  let chatSearchRef: HTMLInputElement | undefined
  setNavigate(navigate)

  createEffect(() => setV2Toast(true))
  createEffect(() => layout.sidebar.close())
  createEffect(() => {
    const root = document.documentElement
    root.dataset.vectorTheme = "dark"
  })

  createEffect(() => {
    if (!chatSearchOpen()) return
    queueMicrotask(() => chatSearchRef?.focus())
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
    setSidePanelOpen(true)
  }

  const inspectWebView = async (value = webViewUrl() || webAddress()) => {
    const next = normalizeUrl(value)
    if (!next) return
    setWebAddress(next)
    if (!webViewUrl()) setWebViewUrl(next)
    const inspect = globalThis.window?.api?.inspectBrowserUrl
    if (!inspect) {
      const report = {
        url: next,
        finalUrl: next,
        status: 0,
        ok: false,
        title: "",
        description: "",
        htmlBytes: 0,
        links: 0,
        scripts: 0,
        stylesheets: 0,
        checkedAt: new Date().toISOString(),
        error: "Browser automation is available in the desktop app after restart.",
      }
      setBrowserReport(report)
      setBrowserHistory((items) => [report, ...items].slice(0, 8))
      return
    }
    setBrowserBusy(true)
    const report = await inspect(next).catch((error) => ({
      url: next,
      finalUrl: next,
      status: 0,
      ok: false,
      title: "",
      description: "",
      htmlBytes: 0,
      links: 0,
      scripts: 0,
      stylesheets: 0,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }))
    setBrowserReport(report)
    setBrowserHistory((items) => [report, ...items].slice(0, 8))
    setBrowserBusy(false)
  }

  const runBrowserAutomation = async (
    actions: Parameters<NonNullable<NonNullable<Window["api"]>["runBrowserAutomation"]>>[0]["actions"] = [],
  ) => {
    const next = normalizeUrl(webViewUrl() || webAddress())
    if (!next) return
    setWebAddress(next)
    setWebViewUrl(next)
    const runner = globalThis.window?.api?.runBrowserAutomation
    if (!runner) {
      const report: BrowserAutomationRun = {
        url: next,
        finalUrl: next,
        status: 0,
        ok: false,
        title: "",
        description: "",
        htmlBytes: 0,
        links: 0,
        scripts: 0,
        stylesheets: 0,
        checkedAt: new Date().toISOString(),
        viewport: { width: 1366, height: 900 },
        screenshotDataUrl: "",
        textSample: "",
        console: [],
        pageErrors: [],
        actions: [],
        interactives: [],
        inputs: [],
        error: "Browser automation is available in the desktop app after restart.",
      }
      setBrowserRun(report)
      setBrowserReport(report)
      return
    }
    setBrowserBusy(true)
    const report = await runner({
      url: next,
      actions,
      viewport: { width: 1366, height: 900 },
    }).catch((error) => ({
      url: next,
      finalUrl: next,
      status: 0,
      ok: false,
      title: "",
      description: "",
      htmlBytes: 0,
      links: 0,
      scripts: 0,
      stylesheets: 0,
      checkedAt: new Date().toISOString(),
      viewport: { width: 1366, height: 900 },
      screenshotDataUrl: "",
      textSample: "",
      console: [],
      pageErrors: [],
      actions: [],
      interactives: [],
      inputs: [],
      error: error instanceof Error ? error.message : String(error),
    }))
    setBrowserRun(report)
    setBrowserReport(report)
    setBrowserHistory((items) => [report, ...items].slice(0, 8))
    setBrowserBusy(false)
  }

  const webFrameSrc = () => {
    const url = webViewUrl()
    if (!url) return ""
    return `${url}${url.includes("?") ? "&" : "?"}vector_preview_reload=${webFrameKey()}`
  }

  const openSidePanel = () => {
    setSidePanelOpen(true)
    setToolsOpen(false)
  }

  const openTerminalPanel = () => {
    setSidePanelOpen(false)
    setToolsOpen(false)
    command.trigger("terminal.toggle")
  }

  const openCodespace = () => {
    setSidePanelOpen(false)
    setToolsOpen(false)
    command.trigger("vector.codespace.open")
  }

  const openCodeArchaeology = () => {
    setSidePanelOpen(false)
    setToolsOpen(false)
    globalThis.window?.dispatchEvent(new CustomEvent("vector:open-code-archaeology"))
  }

  const taskRoute = () => /\/session\/[^/?#]+/.test(location.pathname)
  const macDesktop = () => platform.platform === "desktop" && platform.os === "macos"

  const openSettings = () => {
    void import("@/components/settings-v2/dialog-settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  let lastPath = ""
  createEffect(() => {
    const path = location.pathname
    if (path !== lastPath) {
      lastPath = path
      setToolsOpen(false)
      setSidePanelOpen(false)
      setChatSearchOpen(false)
    }
    if (taskRoute()) return
    setToolsOpen(false)
    setSidePanelOpen(false)
    setChatSearchOpen(false)
  })

  const searchChat = (value = chatSearchValue(), backwards = false) => {
    const query = value.trim()
    if (!query) return
    const find = (globalThis.window as unknown as { find?: (...args: unknown[]) => boolean }).find
    find?.call(globalThis.window, query, false, backwards, true, false, false, false)
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
    if (event.key === "Escape" && (toolsOpen() || sidePanelOpen())) {
      event.preventDefault()
      setToolsOpen(false)
      setSidePanelOpen(false)
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
      const inComposer = target.closest(
        '[data-component="prompt-input"], [data-component="session-composer"], [data-component="session-new-composer"]',
      )
      if (inField && !inComposer) return
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
      class="relative bg-[#111112] flex-1 min-h-0 min-w-0 flex flex-col select-none text-[#f4f4f5] [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar update={update} />
      <main
        class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict transition-[padding] duration-200"
        style={{ "padding-left": RAIL_WIDTH, background: "var(--vector-workspace-bg, #111112)" }}
      >
        <Suspense>{props.children}</Suspense>
      </main>

      <nav
        class="fixed inset-y-0 left-0 z-50 flex flex-col border-r border-[#2a2a2d] pb-3 text-white/70"
        style={{ width: RAIL_WIDTH, "padding-top": macDesktop() ? "56px" : "12px", background: "var(--vector-sidebar-bg, #18181a)" }}
      >
        <div class="flex items-center gap-2.5 px-4 pb-3">
          <img src="/vector-logo.png" alt="" class="size-7 rounded-lg object-cover" draggable={false} />
          <span class="text-[15px] font-semibold text-white">Vector</span>
        </div>

        <div class="flex flex-col gap-0.5 px-2">
          <button
            type="button"
            class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
            onClick={() => {
              setToolsOpen(false)
              setSidePanelOpen(false)
              navigate("/")
            }}
          >
            <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
              <path d="M9.5 2.75 3.9 8.35l-.65 3.4 3.4-.65 5.6-5.6a1.94 1.94 0 1 0-2.75-2.75Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
            </svg>
            New chat
          </button>
          <button
            type="button"
            class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
            onClick={() => command.show()}
          >
            <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
              <path d="M7.25 12.25a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm3.6-1.4 2.9 2.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            Search
          </button>
          <button
            type="button"
            class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
            onClick={() => {
              setToolsOpen(false)
              setSidePanelOpen(false)
              navigate("/")
            }}
          >
            <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
              <path d="M3 7.25 8 3l5 4.25V13a.75.75 0 0 1-.75.75h-2.6v-3.6h-3.3v3.6h-2.6A.75.75 0 0 1 3 13V7.25Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
            </svg>
            Home
          </button>
        </div>

        <Show when={taskRoute()}>
          <div class="mt-4 px-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Workspace</div>
          <div class="mt-1 flex flex-col gap-0.5 px-2">
            <button
              type="button"
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              classList={{ "bg-white/[0.08] text-white": toolsOpen() }}
              aria-expanded={toolsOpen()}
              onClick={() => {
                setSidePanelOpen(false)
                setToolsOpen((open) => !open)
              }}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path d="M8 2.4l1.35 3.1 3.35.3-2.55 2.2.76 3.3L8 9.6l-2.91 1.7.76-3.3-2.55-2.2 3.35-.3L8 2.4Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
              Vector tools
            </button>
            <button
              type="button"
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              onClick={openCodespace}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path d="M5.25 5 2.75 8l2.5 3M10.75 5l2.5 3-2.5 3M9.15 3.75l-2.3 8.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              Codespace
            </button>
            <button
              type="button"
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-[#c4a8ff] transition hover:bg-[#2a1c3d] hover:text-white"
              onClick={openCodeArchaeology}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path d="M4.25 3.25h5.6l2 2v7.5h-7.6z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
                <path d="M9.85 3.25v2h2M5.85 7.1h4.3M5.85 9.2h4.3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
              </svg>
              Code Archaeology
            </button>
            <button
              type="button"
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              onClick={openSidePanel}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.2" />
                <path d="M2.8 8h10.4M8 2.6c-3.2 3.4-3.2 7.4 0 10.8 3.2-3.4 3.2-7.4 0-10.8Z" fill="none" stroke="currentColor" stroke-width="1.1" />
              </svg>
              Browser preview
            </button>
            <button
              type="button"
              class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
              onClick={openTerminalPanel}
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
                <path d="m4 5 3 3-3 3m4.5 0H12" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              Terminal
            </button>
          </div>
        </Show>

        <div class="flex-1" />

        <div class="flex flex-col gap-0.5 px-2">
          <button
            type="button"
            class="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition hover:bg-white/[0.06] hover:text-white"
            onClick={openSettings}
          >
            <svg viewBox="0 0 16 16" class="size-4 shrink-0" aria-hidden="true">
              <path d="M8 10.35A2.35 2.35 0 1 0 8 5.65a2.35 2.35 0 0 0 0 4.7Zm4.72-1.35a4.8 4.8 0 0 0 0-2l1.2-.92-1.2-2.08-1.42.58a5.1 5.1 0 0 0-1.72-1L9.4 2H6.6l-.18 1.58a5.1 5.1 0 0 0-1.72 1L3.28 4l-1.2 2.08 1.2.92a4.8 4.8 0 0 0 0 2l-1.2.92L3.28 12l1.42-.58a5.1 5.1 0 0 0 1.72 1L6.6 14h2.8l.18-1.58a5.1 5.1 0 0 0 1.72-1l1.42.58 1.2-2.08-1.2-.92Z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Settings
          </button>
        </div>
      </nav>

      <aside
        class="fixed bottom-0 right-0 top-0 z-40 w-[318px] overflow-hidden border-l border-[#2a2a2d] bg-[#202020]/96 shadow-[-14px_0_50px_rgba(0,0,0,0.28)] backdrop-blur-2xl transition duration-200"
        classList={{
          "pointer-events-auto translate-x-0 opacity-100": toolsOpen(),
          "pointer-events-none translate-x-[calc(100%+24px)] opacity-0": !toolsOpen(),
        }}
        aria-hidden={!toolsOpen()}
        inert={!toolsOpen()}
      >
        <div class="flex h-full flex-col">
          <div class="flex items-center gap-3 border-b border-[#29292c] px-4 py-4">
            <img src="/vector-logo.png" alt="" class="size-8 rounded-lg" />
            <div>
              <div class="text-sm font-semibold text-white">Vector Agent</div>
              <div class="text-xs text-white/42">Plan, prove, learn, inspect.</div>
            </div>
          </div>
          <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            <button
              type="button"
              class="flex w-full items-center justify-between rounded-xl border border-[#2a2a2d] bg-white/[0.035] px-3 py-3 text-left text-white/76 transition hover:border-[#9b6cff]/40 hover:text-white"
              onClick={openCodespace}
            >
              <span>
                <span class="block text-sm font-semibold">Vector Codespace</span>
                <span class="mt-0.5 block text-xs text-white/42">Synced files, review, editor, terminal</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-4 text-white/42" aria-hidden="true">
                <path
                  d="M6 3.5 10.5 8 6 12.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </button>

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
              onClick={openSidePanel}
            >
              <span>
                <span class="block text-sm font-semibold">Web preview</span>
                <span class="mt-0.5 block text-xs text-white/42">Open localhost beside Vector</span>
              </span>
              <svg viewBox="0 0 16 16" class="size-4 text-white/42" aria-hidden="true">
                <path
                  d="M6 3.5 10.5 8 6 12.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
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
                <path
                  d="m4 5 3 3-3 3m4.5 0H12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      <aside
        class="fixed bottom-4 top-4 z-50 w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-[#2b2b30] bg-[#151518]/96 shadow-[0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl transition duration-200 ease-out"
        style={{ right: toolsOpen() ? "334px" : "16px" }}
        classList={{
          "pointer-events-auto translate-x-0 opacity-100": sidePanelOpen(),
          "pointer-events-none translate-x-[calc(100%+32px)] opacity-0": !sidePanelOpen(),
        }}
        aria-hidden={!sidePanelOpen()}
        inert={!sidePanelOpen()}
      >
        <div class="flex h-full flex-col">
          <div class="flex items-center justify-between border-b border-[#2a2a2d] px-4 py-3">
            <div>
              <div class="text-sm font-semibold text-white">Browser automation</div>
              <div class="mt-0.5 text-xs text-white/42">Preview, reload, and inspect local apps.</div>
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
          <div class="flex min-h-0 flex-1 flex-col bg-[#0f0f11]">
            <form
              class="flex items-center gap-2 border-b border-[#2a2a2d] px-4 py-3"
              onSubmit={(event) => {
                event.preventDefault()
                openWebView()
              }}
            >
              <div class="flex items-center gap-0.5">
                <button
                  type="button"
                  class="grid size-7 place-items-center rounded-lg text-white/45 transition hover:bg-white/[0.07] hover:text-white"
                  aria-label="Back"
                  onClick={() => history.back()}
                >
                  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                    <path d="M9.5 4 5.5 8l4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="grid size-7 place-items-center rounded-lg text-white/45 transition hover:bg-white/[0.07] hover:text-white"
                  aria-label="Forward"
                  onClick={() => history.forward()}
                >
                  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                    <path d="m6.5 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="grid size-7 place-items-center rounded-lg text-white/45 transition hover:bg-white/[0.07] hover:text-white"
                  aria-label="Reload"
                  onClick={() => {
                    if (webViewUrl()) setWebFrameKey((key) => key + 1)
                  }}
                >
                  <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                    <path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.8v2.4h-2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
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
              <button
                type="button"
                class="rounded-full border border-[#9b6cff]/35 px-3 py-1.5 text-xs font-semibold text-[#cbb6ff] transition hover:border-[#b997ff]/70 hover:bg-[#9b6cff]/18 hover:text-white"
                disabled={browserBusy()}
                onClick={() => runBrowserAutomation()}
              >
                {browserBusy() ? "Running" : "Run browser"}
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
            <div class="border-b border-[#26262a] bg-[#111114] px-4 py-3">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-xs font-semibold uppercase tracking-[0.18em] text-white/38">Automation check</div>
                  <div class="mt-1 text-sm font-medium text-white">
                    {browserBusy()
                      ? "Driving browser"
                      : browserReport()
                        ? browserReport()?.ok
                          ? "Page is reachable"
                          : "Page needs attention"
                        : "Idle"}
                  </div>
                </div>
                <button
                  type="button"
                  class="rounded-full bg-[#9b6cff] px-3 py-1.5 text-xs font-bold text-white shadow-[0_12px_26px_rgba(155,108,255,0.22)] transition hover:bg-[#b28cff] disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={browserBusy()}
                  onClick={() => runBrowserAutomation()}
                >
                  Run browser
                </button>
              </div>
              <Show when={browserReport()}>
                <div class="mt-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                      <div class="truncate text-sm font-semibold text-white">
                        {browserReport()?.title || browserReport()?.finalUrl || "Untitled page"}
                      </div>
                      <div class="mt-1 truncate text-xs text-white/42">{browserReport()?.finalUrl}</div>
                    </div>
                    <span
                      class="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold"
                      classList={{
                        "bg-emerald-400/12 text-emerald-200": !!browserReport()?.ok,
                        "bg-red-400/12 text-red-200": !browserReport()?.ok,
                      }}
                    >
                      {browserReport()?.status || "ERR"}
                    </span>
                  </div>
                  <div class="mt-3 grid grid-cols-4 gap-2 text-center">
                    <div class="rounded-xl bg-black/20 px-2 py-2">
                      <div class="text-sm font-semibold text-white">{browserReport()?.links}</div>
                      <div class="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/32">Links</div>
                    </div>
                    <div class="rounded-xl bg-black/20 px-2 py-2">
                      <div class="text-sm font-semibold text-white">{browserReport()?.scripts}</div>
                      <div class="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/32">Scripts</div>
                    </div>
                    <div class="rounded-xl bg-black/20 px-2 py-2">
                      <div class="text-sm font-semibold text-white">{browserReport()?.stylesheets}</div>
                      <div class="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/32">Styles</div>
                    </div>
                    <div class="rounded-xl bg-black/20 px-2 py-2">
                      <div class="text-sm font-semibold text-white">{Math.round((browserReport()?.htmlBytes ?? 0) / 1024)}k</div>
                      <div class="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/32">HTML</div>
                    </div>
                  </div>
                  <Show when={browserReport()?.description}>
                    <p class="mt-3 line-clamp-2 text-xs leading-5 text-white/50">{browserReport()?.description}</p>
                  </Show>
                  <Show when={browserReport()?.error}>
                    <p class="mt-3 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-100">
                      {browserReport()?.error}
                    </p>
                  </Show>
                </div>
              </Show>
              <Show when={browserRun()}>
                <div class="mt-3 grid gap-3">
                  <Show when={browserRun()?.screenshotDataUrl}>
                    <div class="overflow-hidden rounded-2xl border border-white/[0.08] bg-black/35">
                      <img
                        src={browserRun()?.screenshotDataUrl}
                        alt="Browser automation screenshot"
                        class="max-h-52 w-full object-cover object-top"
                      />
                    </div>
                  </Show>
                  <div class="grid grid-cols-2 gap-2">
                    <div class="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
                      <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/36">Detected controls</div>
                      <div class="mt-2 max-h-24 space-y-1 overflow-auto pr-1">
                        <Show
                          when={(browserRun()?.interactives.length ?? 0) > 0}
                          fallback={<div class="text-xs text-white/35">No clickable controls detected.</div>}
                        >
                          {browserRun()
                            ?.interactives.slice(0, 8)
                            .map((item) => (
                              <button
                                type="button"
                                class="block w-full truncate rounded-lg px-2 py-1 text-left text-xs text-white/62 transition hover:bg-white/[0.06] hover:text-white"
                                title={item.selector}
                                onClick={() => setBrowserSelector(item.selector)}
                              >
                                {item.text || item.selector}
                              </button>
                            ))}
                        </Show>
                      </div>
                    </div>
                    <div class="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
                      <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/36">Detected inputs</div>
                      <div class="mt-2 max-h-24 space-y-1 overflow-auto pr-1">
                        <Show
                          when={(browserRun()?.inputs.length ?? 0) > 0}
                          fallback={<div class="text-xs text-white/35">No inputs detected.</div>}
                        >
                          {browserRun()
                            ?.inputs.slice(0, 8)
                            .map((item) => (
                              <button
                                type="button"
                                class="block w-full truncate rounded-lg px-2 py-1 text-left text-xs text-white/62 transition hover:bg-white/[0.06] hover:text-white"
                                title={item.selector}
                                onClick={() => setBrowserSelector(item.selector)}
                              >
                                {item.placeholder || item.name || item.selector}
                              </button>
                            ))}
                        </Show>
                      </div>
                    </div>
                  </div>
                  <div class="rounded-2xl border border-white/[0.08] bg-black/25 p-3">
                    <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/36">Browser actions</div>
                    <input
                      class="mt-2 w-full rounded-xl border border-white/[0.08] bg-white/[0.045] px-3 py-2 text-xs text-white outline-none placeholder:text-white/28 focus:border-[#9b6cff]/50"
                      value={browserSelector()}
                      placeholder="CSS selector, for example #email or button[type=submit]"
                      onInput={(event) => setBrowserSelector(event.currentTarget.value)}
                    />
                    <input
                      class="mt-2 w-full rounded-xl border border-white/[0.08] bg-white/[0.045] px-3 py-2 text-xs text-white outline-none placeholder:text-white/28 focus:border-[#9b6cff]/50"
                      value={browserText()}
                      placeholder="Text to type"
                      onInput={(event) => setBrowserText(event.currentTarget.value)}
                    />
                    <div class="mt-2 flex gap-2">
                      <button
                        type="button"
                        class="rounded-full border border-white/[0.1] px-3 py-1.5 text-xs font-semibold text-white/60 transition hover:border-[#9b6cff]/45 hover:text-white"
                        disabled={!browserSelector() || browserBusy()}
                        onClick={() => runBrowserAutomation([{ type: "click", selector: browserSelector() }])}
                      >
                        Click
                      </button>
                      <button
                        type="button"
                        class="rounded-full border border-white/[0.1] px-3 py-1.5 text-xs font-semibold text-white/60 transition hover:border-[#9b6cff]/45 hover:text-white"
                        disabled={!browserSelector() || !browserText() || browserBusy()}
                        onClick={() =>
                          runBrowserAutomation([{ type: "type", selector: browserSelector(), text: browserText(), clear: true }])
                        }
                      >
                        Type
                      </button>
                    </div>
                    <Show when={(browserRun()?.actions.length ?? 0) > 0}>
                      <div class="mt-3 space-y-1">
                        {browserRun()
                          ?.actions.slice(-4)
                          .map((action) => (
                            <div
                              class="rounded-lg px-2 py-1 text-xs"
                              classList={{
                                "bg-emerald-400/10 text-emerald-100": action.ok,
                                "bg-red-400/10 text-red-100": !action.ok,
                              }}
                            >
                              {action.label}
                              {!action.ok && action.error ? `: ${action.error}` : ""}
                            </div>
                          ))}
                      </div>
                    </Show>
                  </div>
                  <Show when={(browserRun()?.console.length ?? 0) > 0 || (browserRun()?.pageErrors.length ?? 0) > 0}>
                    <div class="rounded-2xl border border-white/[0.08] bg-black/25 p-3">
                      <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/36">Console and page errors</div>
                      <div class="mt-2 max-h-28 space-y-1 overflow-auto pr-1">
                        {browserRun()?.pageErrors.map((item) => <div class="text-xs text-red-200">{item}</div>)}
                        {browserRun()?.console.slice(-8).map((item) => (
                          <div class="truncate text-xs text-white/44">
                            [{item.level}] {item.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={browserHistory().length > 1}>
                <div class="mt-3 flex flex-wrap gap-1.5">
                  {browserHistory()
                    .slice(1, 5)
                    .map((item) => (
                      <button
                        type="button"
                        class="rounded-full border border-white/[0.08] px-2 py-1 text-[10px] text-white/40 transition hover:border-[#9b6cff]/40 hover:text-white"
                        onClick={() => {
                          setBrowserReport(item)
                          setWebAddress(item.finalUrl || item.url)
                        }}
                      >
                        {item.status || "ERR"} · {item.title || new URL(item.url).host}
                      </button>
                    ))}
                </div>
              </Show>
            </div>
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
                      <h2 class="mt-5 text-lg font-semibold text-white">Browser automation</h2>
                      <p class="mt-2 max-w-[290px] text-xs leading-5 text-white/[0.52]">
                        Open a localhost app, then run an inspection to capture status, title, assets, and load problems.
                      </p>
                    </div>
                  </div>
                }
              >
                <iframe
                  src={webFrameSrc()}
                  title="Vector browser preview"
                  class="h-full w-full border-0 bg-white"
                  sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"
                />
              </Show>
            </div>
          </div>
        </div>
      </aside>

      <Show when={chatSearchOpen()}>
        <form
          class="fixed right-4 top-4 z-[70] flex w-[min(360px,calc(100vw-88px))] items-center gap-1 rounded-2xl border border-[#303036] bg-[#1b1b1f]/96 p-1.5 shadow-[0_24px_70px_rgba(0,0,0,0.42)] backdrop-blur-2xl"
          onSubmit={(event) => {
            event.preventDefault()
            searchChat()
          }}
        >
          <svg viewBox="0 0 16 16" class="ml-2 size-4 text-white/38" aria-hidden="true">
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
            class="grid size-8 place-items-center rounded-xl text-white/48 transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Previous match"
            onClick={() => searchChat(chatSearchValue(), true)}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4.5 9.5 3.5-3.5 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </button>
          <button
            type="button"
            class="grid size-8 place-items-center rounded-xl text-white/48 transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Next match"
            onClick={() => searchChat()}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </button>
          <button
            type="button"
            class="grid size-8 place-items-center rounded-xl text-white/48 transition hover:bg-white/[0.06] hover:text-white"
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
