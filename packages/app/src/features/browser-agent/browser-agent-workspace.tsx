import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { createBrowserPlanner, type BrowserModelAction } from "./planner"
import {
  browserAgentApi,
  isLocalBrowserUrl,
  normalizeBrowserUrl,
  type BrowserAgentCommand,
  type BrowserAgentInput,
  type BrowserAgentPageEvent,
  type BrowserAutomationRun,
} from "./types"
import "./browser-agent.css"

const MODEL_STORAGE_KEY = "vector.browser-agent-model.v1"
const URL_STORAGE_KEY = "vector.browser-agent-url.v1"
const MAX_PLANNER_STEPS = 12

function scopedStorageKey(base: string, contextId: string) {
  const hash = Array.from(contextId).reduce((value, character) => Math.imul(value ^ character.charCodeAt(0), 16777619), 2166136261)
  return `${base}.${(hash >>> 0).toString(36)}`
}

type ChatLine = { text: string; ok?: boolean }

type ChatEntry = {
  id: string
  role: "user" | "agent" | "system" | "error"
  text: string
  lines?: ChatLine[]
  externalGateUrl?: string
  at: number
}

export type BrowserAgentModelOption = {
  providerID: string
  providerName: string
  modelID: string
  modelName: string
}

let entryCounter = 0
const entryId = () => `entry-${++entryCounter}-${Date.now().toString(36)}`

function describeAction(action: BrowserModelAction) {
  if (action.type === "click") return `click ${action.selector}`
  if (action.type === "type") return `type ${action.selector}`
  if (action.type === "press") return `press ${action.key}`
  if (action.type === "scroll") return `scroll ${action.deltaY}`
  if (action.type === "navigate") return `navigate ${action.url}`
  if (action.type === "wait_for_user") return `wait for you — ${action.reason}`
  return `wait ${action.milliseconds}ms`
}

function emitEngineering(detail: Record<string, unknown>) {
  globalThis.window?.dispatchEvent(new CustomEvent("vector:engineering-event", { detail: { source: "Browser Agent", ...detail } }))
}

export function BrowserAgentWorkspace(props: {
  onClose: () => void
  macPad: boolean
  models: BrowserAgentModelOption[]
  resolveProjectPath: () => Promise<string>
  contextId: string
  // Deep-link entry (e.g. the preview's "Check with agent" button): open this
  // URL and immediately run a task against it.
  initialUrl?: string
  initialTask?: string
}) {
  const serverSDK = useServerSDK()
  const desktop = Boolean(browserAgentApi())
  const modelStorageKey = scopedStorageKey(MODEL_STORAGE_KEY, props.contextId)
  const urlStorageKey = scopedStorageKey(URL_STORAGE_KEY, props.contextId)

  const [entries, setEntries] = createSignal<ChatEntry[]>([])
  const [input, setInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [allowExternal, setAllowExternal] = createSignal(false)
  const [address, setAddress] = createSignal(globalThis.localStorage?.getItem(urlStorageKey) || "")
  // Only updated when a navigation is actually committed (form submit, deep
  // link, allow-external) — the web-fallback iframe binds to this, not the
  // live address() input value, so typing doesn't reload it per keystroke.
  const [committedAddress, setCommittedAddress] = createSignal(address())
  const [page, setPage] = createSignal<BrowserAgentPageEvent>()
  const [issueCount, setIssueCount] = createSignal(0)
  const [lastReport, setLastReport] = createSignal<BrowserAutomationRun>()
  const [modelKey, setModelKey] = createSignal(globalThis.localStorage?.getItem(modelStorageKey) ?? "")
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
  // Human handoff: while set, the planner loop is paused awaiting the user's
  // "Continue" click. The live browser stays fully interactive throughout.
  const [pendingHandoff, setPendingHandoff] = createSignal<{ reason: string; resolve: () => void }>()
  let abort: AbortController | undefined
  let stageRef: HTMLDivElement | undefined
  let transcriptRef: HTMLDivElement | undefined
  let modelPickerRef: HTMLDivElement | undefined
  let addressFocused = false

  createEffect(() => globalThis.localStorage?.setItem(urlStorageKey, address()))
  createEffect(() => {
    const key = modelKey()
    if (key) globalThis.localStorage?.setItem(modelStorageKey, key)
  })

  const selectedModel = createMemo(() => {
    const [providerID, modelID] = modelKey().split("::")
    const match = props.models.find((option) => option.providerID === providerID && option.modelID === modelID)
    return match ?? props.models[0]
  })

  const pushEntry = (entry: Omit<ChatEntry, "id" | "at">) => {
    setEntries((items) => [...items, { ...entry, id: entryId(), at: Date.now() }].slice(-160))
    queueMicrotask(() => transcriptRef?.scrollTo({ top: transcriptRef.scrollHeight, behavior: "smooth" }))
  }

  const command = async (name: BrowserAgentCommand, extra: Partial<BrowserAgentInput> = {}) => {
    const api = browserAgentApi()
    if (!api) return undefined
    try {
      const report = await api.runBrowserAgent({ ...extra, contextId: props.contextId, command: name })
      setLastReport(report)
      setIssueCount((report.diagnostics?.runtimeErrorCount ?? 0) + (report.diagnostics?.networkErrorCount ?? 0))
      return report
    } catch (error) {
      pushEntry({ role: "error", text: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  const planner = createBrowserPlanner({
    createClient: (directory) => serverSDK().createClient({ directory, throwOnError: true }),
    resolveDirectory: props.resolveProjectPath,
    model: () => {
      const model = selectedModel()
      return model ? { providerID: model.providerID, modelID: model.modelID } : undefined
    },
  })

  const measureStage = () => {
    if (!stageRef) return undefined
    const rect = stageRef.getBoundingClientRect()
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
  }

  onMount(() => {
    const closeModelPicker = (event: PointerEvent) => {
      if (modelPickerRef?.contains(event.target as Node)) return
      setModelPickerOpen(false)
    }
    const onModelPickerKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModelPickerOpen(false)
    }
    document.addEventListener("pointerdown", closeModelPicker)
    document.addEventListener("keydown", onModelPickerKeyDown)
    onCleanup(() => {
      document.removeEventListener("pointerdown", closeModelPicker)
      document.removeEventListener("keydown", onModelPickerKeyDown)
    })
  })

  onMount(() => {
    const api = browserAgentApi()
    if (!api || !stageRef) return
    void api
      .runBrowserAgent({ contextId: props.contextId, command: "attach", bounds: measureStage() })
      .then((report) => {
        setLastReport(report)
        if (report.url) {
          setPage({
            contextId: props.contextId,
            url: report.url,
            title: report.title,
            canGoBack: false,
            canGoForward: false,
            loading: false,
          })
          return
        }
        if (address()) navigateTo(address())
      })
      .catch((error) => pushEntry({ role: "error", text: error instanceof Error ? error.message : String(error) }))
    const syncBounds = () => {
      const bounds = measureStage()
      if (bounds) void api.runBrowserAgent({ contextId: props.contextId, command: "setBounds", bounds })
    }
    const observer = new ResizeObserver(syncBounds)
    observer.observe(stageRef)
    globalThis.window?.addEventListener("resize", syncBounds)
    const offZoom = (globalThis.window?.api as { onZoomFactorChanged?: (cb: (factor: number) => void) => () => void } | undefined)
      ?.onZoomFactorChanged?.(() => queueMicrotask(syncBounds))
    const offPage = api.onBrowserAgentPageEvent?.((event) => {
      if (event.contextId !== props.contextId) return
      setPage(event)
      if (!addressFocused && event.url) setAddress(event.url)
    })
    let deepLinkTimer: ReturnType<typeof setTimeout> | undefined
    if (props.initialUrl) {
      setAddress(normalizeBrowserUrl(props.initialUrl))
      if (props.initialTask) {
        const task = props.initialTask
        // Let the attach settle before the diagnostic run kicks off.
        deepLinkTimer = setTimeout(() => void runPrompt(task), 400)
      } else {
        navigateTo(props.initialUrl)
      }
    }
    onCleanup(() => {
      observer.disconnect()
      globalThis.window?.removeEventListener("resize", syncBounds)
      offZoom?.()
      offPage?.()
      clearTimeout(deepLinkTimer)
      abort?.abort()
      void api.runBrowserAgent({ contextId: props.contextId, command: "detach" })
    })
  })

  const navigateTo = (value: string, external = allowExternal()) => {
    const next = normalizeBrowserUrl(value)
    if (!next) return
    setAddress(next)
    setCommittedAddress(next)
    if (!desktop) return
    if (!isLocalBrowserUrl(next) && !external) {
      pushEntry({
        role: "system",
        text: `${next} is an external website. Vector only opens localhost automatically — allow external sites for this conversation to continue.`,
        externalGateUrl: next,
      })
      return
    }
    // Navigation failures must never be silent: surface them in chat so the
    // user (and the next planner observation) sees what actually happened.
    void command("openUrl", { url: next, allowExternal: external }).then((report) => {
      if (report && !report.ok && report.error) pushEntry({ role: "error", text: report.error })
    })
  }

  const allowExternalAndGo = (url: string) => {
    setAllowExternal(true)
    pushEntry({ role: "system", text: "External sites are allowed for this conversation." })
    navigateTo(url, true)
  }

  const stopRun = () => {
    abort?.abort()
    pushEntry({ role: "system", text: "Stopped. The browser stays on the current page." })
  }

  // Pauses the run until the user clicks "I've done it — Continue" (or stops
  // the run, which also resolves so the loop can exit cleanly).
  const waitForUser = (reason: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done)
        setPendingHandoff(undefined)
        resolve()
      }
      signal.addEventListener("abort", done)
      setPendingHandoff({ reason, resolve: done })
      queueMicrotask(() => transcriptRef?.scrollTo({ top: transcriptRef.scrollHeight, behavior: "smooth" }))
    })

  const runPrompt = async (promptText: string) => {
    if (busy() || !promptText.trim()) return
    if (!desktop) {
      showToast({
        variant: "error",
        title: "Agent browser not connected",
        description: "This window can preview localhost pages. The agent-driven browser activates once Vector connects to this workspace.",
      })
      return
    }
    const controller = new AbortController()
    abort = controller
    setBusy(true)
    setInput("")
    pushEntry({ role: "user", text: promptText })
    emitEngineering({ type: "browser", status: "running", title: "Browser Agent run started", summary: promptText })
    // Every early return below must leave a terminal event in the Engineering
    // Console — tracked here and emitted from `finally` as a fallback so no
    // exit path (gate, abort, planner error, …) leaves the feed hung on
    // "running".
    let terminalEmitted = false
    const finish = (status: "success" | "warning", title: string, summary: string) => {
      terminalEmitted = true
      emitEngineering({ type: "browser", status, title, summary })
    }
    try {
      // Make sure a page is open before planning against an empty view.
      if (!page()?.url && address()) {
        const next = normalizeBrowserUrl(address())
        if (next && (isLocalBrowserUrl(next) || allowExternal())) {
          const opened = await command("openUrl", { url: next, allowExternal: allowExternal() })
          if (opened && !opened.ok && opened.error) {
            // Planning against a blank page produces nonsense — stop here and
            // tell the user exactly why the page never opened.
            pushEntry({ role: "error", text: opened.error })
            finish("warning", "Browser Agent could not open the page", opened.error)
            return
          }
        } else if (next) {
          pushEntry({
            role: "system",
            text: `${next} is an external website. Allow external sites to let the agent browse it.`,
            externalGateUrl: next,
          })
          return
        }
      }

      const completed: string[] = []
      let finalSummary = ""
      for (let step = 0; step < MAX_PLANNER_STEPS; step++) {
        if (controller.signal.aborted) return
        const state = await command("inspectDom")
        if (!state) return
        if (!state.ok && state.error) {
          pushEntry({ role: "error", text: state.error })
          return
        }
        let plan
        try {
          plan = await planner.plan(promptText, state, completed)
        } catch (error) {
          pushEntry({ role: "error", text: error instanceof Error ? error.message : String(error) })
          return
        }
        if (controller.signal.aborted) return
        pushEntry({ role: "agent", text: plan.summary })
        if (plan.needsUser) {
          pushEntry({ role: "system", text: plan.needsUser })
          finish("warning", "Browser Agent needs you", plan.needsUser)
          return
        }
        if (plan.complete || plan.actions.length === 0) {
          finalSummary = plan.summary
          break
        }
        const lines: ChatLine[] = []
        let handoffReason: string | undefined
        for (const action of plan.actions) {
          if (controller.signal.aborted) return
          if (action.type === "wait_for_user") {
            // Pause here; any actions the model queued after the handoff are
            // dropped so the next step plans against the refreshed page.
            handoffReason = action.reason
            break
          }
          const label = describeAction(action)
          const report =
            action.type === "click"
              ? await command("click", { selector: action.selector })
              : action.type === "type"
                ? await command("type", { selector: action.selector, text: action.text })
                : action.type === "press"
                  ? await command("press", { key: action.key })
                  : action.type === "scroll"
                    ? await command("scroll", { deltaY: action.deltaY })
                    : action.type === "navigate"
                      ? await command("openUrl", { url: normalizeBrowserUrl(action.url), allowExternal: allowExternal() })
                      : await command("wait", { milliseconds: action.milliseconds })
          if (report?.ok) {
            completed.push(label)
            lines.push({ text: label, ok: true })
          } else {
            // A failed action feeds back into the next planning step instead
            // of killing the whole run.
            completed.push(`${label} — failed: ${report?.error ?? "unknown error"}`)
            lines.push({ text: `${label}${report?.error ? ` — ${report.error}` : ""}`, ok: false })
            if (action.type === "navigate" && report?.error?.includes("external")) {
              // The agent hit the external-site gate mid-run; give the user a
              // one-click way to allow it and send the browser there.
              pushEntry({ role: "system", text: report.error, externalGateUrl: normalizeBrowserUrl(action.url) })
            }
          }
        }
        if (lines.length) pushEntry({ role: "agent", text: "", lines })
        if (handoffReason) {
          emitEngineering({ type: "browser", status: "running", title: "Browser Agent is waiting for you", summary: handoffReason })
          await waitForUser(handoffReason, controller.signal)
          if (controller.signal.aborted) return
          completed.push(`wait_for_user — the user completed: ${handoffReason}`)
          pushEntry({ role: "system", text: "Thanks — continuing with a fresh look at the page." })
        }
      }

      const report = lastReport()
      const issues = (report?.diagnostics?.runtimeErrorCount ?? 0) + (report?.diagnostics?.networkErrorCount ?? 0)
      const summary =
        finalSummary ||
        `Done — ${completed.length} action${completed.length === 1 ? "" : "s"} on ${page()?.title || address()}${issues ? `, ${issues} page issue${issues === 1 ? "" : "s"} spotted` : ""}.`
      pushEntry({ role: "agent", text: summary })
      finish(issues ? "warning" : "success", "Browser Agent run finished", summary)
    } finally {
      if (!terminalEmitted) {
        finish(
          "warning",
          "Browser Agent run stopped",
          controller.signal.aborted ? "Stopped before finishing." : "Run ended without completing.",
        )
      }
      setBusy(false)
      abort = undefined
    }
  }

  const showIssues = () => {
    const report = lastReport()
    if (!report) return
    const items = [
      ...(report.pageErrors ?? []).map((item) => `Runtime: ${item}`),
      ...(report.networkErrors ?? []).map((item) => `Network: ${item.status ? `${item.status} ` : ""}${item.error || item.url}`),
    ]
    pushEntry({
      role: "system",
      text: items.length ? "Current page issues:" : "No runtime or network issues on the current page.",
      lines: items.map((text) => ({ text })),
    })
  }

  const clearConversation = () => {
    abort?.abort()
    setEntries([])
    planner.reset()
    setAllowExternal(false)
    void command("clearLogs")
  }

  return (
    <section
      data-vector-workspace="browser-agent"
      class="vector-fullscreen-workspace fixed inset-0 z-[130] flex min-h-0 flex-col overflow-hidden bg-[var(--vx-canvas)] text-[var(--vx-text)]"
    >
      <div class="flex min-h-0 flex-1">
        <aside class="flex min-h-0 w-[clamp(320px,28vw,400px)] shrink-0 flex-col border-r border-[var(--vx-line)] bg-[color-mix(in_srgb,var(--vx-sidebar)_88%,transparent)] backdrop-blur-2xl">
          <div
            class="relative flex h-11 shrink-0 items-center gap-2 border-b border-[var(--vx-line)] px-2"
            style={{ "padding-left": props.macPad ? "84px" : undefined }}
          >
            <button
              type="button"
              class="flex h-8 items-center gap-0.5 rounded-full pl-1.5 pr-3 text-[12px] font-medium text-white/60 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-white/[0.05] hover:text-white"
              title="Back to Vector"
              onClick={props.onClose}
            >
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path d="M9.75 3.75 5.5 8l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              Vector
            </button>
            <span class="text-[13px] font-semibold text-white">Browser Agent</span>
            <Show when={busy()}>
              <span class="size-1.5 animate-pulse rounded-full bg-[var(--vx-purple-bright)]" />
            </Show>
            <button
              type="button"
              class="ml-auto flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-white/55 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-white/[0.05] hover:text-white"
              title="Agent settings"
              aria-expanded={settingsOpen()}
              onClick={() => setSettingsOpen((value) => !value)}
            >
              <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.15" fill="currentColor" /><circle cx="8" cy="8" r="1.15" fill="currentColor" /><circle cx="12.5" cy="8" r="1.15" fill="currentColor" />
              </svg>
              Settings
            </button>

            <Show when={settingsOpen()}>
              <div class="vx-ba-popover absolute left-2 right-2 top-12 z-30 rounded-[14px] border border-[var(--vx-line)] bg-[linear-gradient(180deg,rgba(30,28,38,0.92),rgba(18,17,24,0.94))] p-4 shadow-[var(--vx-shadow-float)] backdrop-blur-xl">
                <label class="block font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-[var(--vx-purple-bright)]/80" id="browser-agent-model-label">
                  Model
                </label>
                <div class="relative mt-1.5" ref={(el) => (modelPickerRef = el)}>
                  <button
                    type="button"
                    class="flex h-9 w-full items-center justify-between gap-2 rounded-[10px] border border-[var(--vx-line)] bg-[var(--vx-stage)] px-2.5 text-[12.5px] text-white outline-none transition-colors duration-200 ease-[var(--vx-ease)] hover:border-[var(--vx-line-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(147,116,236,0.55)]"
                    aria-haspopup="listbox"
                    aria-expanded={modelPickerOpen()}
                    onClick={() => setModelPickerOpen((value) => !value)}
                  >
                    <span class="min-w-0 truncate text-left">
                      <Show when={selectedModel()} fallback="Connect a model">
                        {(model) => `${model().modelName} · ${model().providerName}`}
                      </Show>
                    </span>
                    <svg
                      viewBox="0 0 16 16"
                      class="size-3.5 shrink-0 text-white/50 transition-transform duration-200 ease-[var(--vx-ease)]"
                      classList={{ "rotate-180": modelPickerOpen() }}
                      aria-hidden="true"
                    >
                      <path d="M4.5 6.25 8 9.75l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <Show when={modelPickerOpen()}>
                    <ul
                      role="listbox"
                      aria-labelledby="browser-agent-model-label"
                      class="vx-ba-popover absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-48 overflow-y-auto rounded-[10px] border border-[var(--vx-line)] bg-[linear-gradient(180deg,rgba(34,32,42,0.94),rgba(20,19,26,0.96))] py-1 shadow-[var(--vx-shadow-float)] backdrop-blur-xl"
                    >
                      <Show when={props.models.length} fallback={<li class="px-3 py-1.5 text-[12.5px] text-white/45">Connect a model</li>}>
                        <For each={props.models}>
                          {(option) => {
                            const key = `${option.providerID}::${option.modelID}`
                            const active = () => selectedModel() === option
                            return (
                              <li
                                role="option"
                                aria-selected={active()}
                                class="mx-1 cursor-pointer truncate rounded-[6px] px-2.5 py-1.5 text-[12.5px] text-white/85 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-white/[0.06]"
                                classList={{ "bg-white/[0.06]": active() }}
                                onClick={() => {
                                  setModelKey(key)
                                  setModelPickerOpen(false)
                                }}
                              >
                                {option.modelName} · {option.providerName}
                              </li>
                            )
                          }}
                        </For>
                      </Show>
                    </ul>
                  </Show>
                </div>
                <div class="mt-4 border-t border-[var(--vx-line)] pt-3">
                  <span class="block font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-[var(--vx-purple-bright)]/80">Session</span>
                  <label class="mt-2.5 flex cursor-pointer items-center justify-between text-[12.5px] text-white/75">
                    <span>Allow external websites</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={allowExternal()}
                      aria-label="Allow external websites"
                      class="relative h-5 w-[34px] shrink-0 rounded-full transition-colors duration-200 ease-[var(--vx-ease)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(147,116,236,0.55)]"
                      classList={{ "bg-[var(--vx-purple)]": allowExternal(), "bg-white/10": !allowExternal() }}
                      onClick={() => setAllowExternal((value) => !value)}
                    >
                      <span
                        class="absolute left-0 top-[2px] block size-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-[var(--vx-ease)]"
                        classList={{ "translate-x-[16px]": allowExternal(), "translate-x-[2px]": !allowExternal() }}
                      />
                    </button>
                  </label>
                  <button
                    type="button"
                    class="mt-3 w-full rounded-[10px] border border-[var(--vx-line)] px-3 py-1.5 text-[12.5px] text-white/70 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-white/[0.05] hover:text-white"
                    onClick={() => {
                      clearConversation()
                      setSettingsOpen(false)
                    }}
                  >
                    New session
                  </button>
                </div>
              </div>
            </Show>
          </div>
          <div ref={transcriptRef} class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            <Show when={entries().length === 0}>
              <div class="relative px-4 py-14 text-center">
                <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(147,116,236,0.07),transparent_70%)]" aria-hidden="true" />
                <svg viewBox="0 0 40 40" class="relative mx-auto size-10 text-[var(--vx-purple-bright)] opacity-50" aria-hidden="true">
                  <path d="M20 5.5 23 15l9.5 3L23 21l-3 9.5L17 21l-9.5-3L17 15Z" fill="currentColor" />
                  <circle cx="31.5" cy="8.5" r="1.6" fill="currentColor" />
                  <circle cx="8" cy="31" r="1.2" fill="currentColor" />
                </svg>
                <p class="relative mt-4 text-[13px] font-medium text-white/85">Tell the agent what to do in the browser.</p>
                <p class="relative mx-auto mt-2 max-w-[300px] text-[12px] leading-5 text-white/45">
                  “Open the signup page and fill the form with test data.” “Click through checkout and tell me what breaks.”
                  The page on the right is the real browser the agent controls — you can click and type in it yourself at any
                  time.
                </p>
              </div>
            </Show>
            <For each={entries()}>
              {(entry) => (
                <div
                  class={
                    entry.role === "user"
                      ? "ml-8 rounded-[14px] bg-[var(--vx-purple-soft)] px-3.5 py-2.5"
                      : entry.role === "error"
                        ? "mr-8 rounded-[14px] border border-rose-400/20 bg-rose-400/[0.07] px-3.5 py-2.5"
                        : entry.role === "system"
                          ? "mr-8 rounded-[14px] bg-white/[0.03] px-3.5 py-2.5"
                          : "mr-8 rounded-[14px] bg-white/[0.045] px-3.5 py-2.5"
                  }
                >
                  <Show when={entry.text}>
                    <p class={`text-[13px] leading-5 ${entry.role === "error" ? "text-rose-200" : "text-white/88"}`}>{entry.text}</p>
                  </Show>
                  <Show when={entry.lines?.length}>
                    <ul class="mt-1 space-y-1">
                      <For each={entry.lines}>
                        {(line) => (
                          <li
                            class={`flex items-start gap-1.5 font-mono text-[11.5px] leading-5 ${line.ok === false ? "text-rose-300/90" : "text-white/60"}`}
                          >
                            <Show when={line.ok !== undefined}>
                              <svg viewBox="0 0 16 16" class="mt-[3px] size-3 shrink-0" aria-hidden="true">
                                <Show
                                  when={line.ok}
                                  fallback={
                                    <path
                                      d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"
                                      fill="none"
                                      stroke="currentColor"
                                      stroke-width="1.4"
                                      stroke-linecap="round"
                                    />
                                  }
                                >
                                  <path d="M3.5 8.4 6.5 11.4 12.5 4.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                                </Show>
                              </svg>
                            </Show>
                            <span class="min-w-0">{line.text}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <Show when={entry.externalGateUrl}>
                    {(url) => (
                      <button
                        type="button"
                        class="mt-2 rounded-full bg-[var(--vx-purple)] px-3.5 py-1.5 text-[12px] font-semibold text-white transition-all duration-200 ease-[var(--vx-ease)] hover:brightness-110"
                        onClick={() => allowExternalAndGo(url())}
                      >
                        Allow external sites and open
                      </button>
                    )}
                  </Show>
                </div>
              )}
            </For>
            <Show when={pendingHandoff()}>
              {(handoff) => (
                <div class="mr-8 rounded-[14px] border border-[var(--vx-purple)]/45 bg-[var(--vx-purple-soft)] px-3.5 py-3">
                  <p class="text-[13px] font-semibold leading-5 text-white">{handoff().reason}</p>
                  <p class="mt-1 text-[12px] leading-5 text-white/55">
                    The agent is paused — the browser on the right is all yours. Finish this step there, then continue.
                  </p>
                  <button
                    type="button"
                    class="mt-2.5 rounded-full bg-[linear-gradient(180deg,#efe6ff,#cdb2ff)] px-4 py-1.5 text-[12px] font-semibold text-[#0b0712] shadow-[0_10px_26px_rgba(147,116,236,0.26)] transition-all duration-200 ease-[var(--vx-ease)] hover:brightness-[1.04] active:scale-[0.985]"
                    onClick={() => pendingHandoff()?.resolve()}
                  >
                    I've done it — Continue
                  </button>
                </div>
              )}
            </Show>
            <Show when={busy() && !pendingHandoff()}>
              <div class="mr-8 flex items-center gap-2 rounded-[14px] bg-white/[0.045] px-3.5 py-2.5">
                <span class="size-1.5 animate-pulse rounded-full bg-[var(--vx-purple-bright)]" />
                <span class="text-[12.5px] text-white/60">Agent is working in the browser…</span>
              </div>
            </Show>
          </div>

          <form
            class="shrink-0 border-t border-[var(--vx-line)] p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void runPrompt(input().trim())
            }}
          >
            <textarea
              class="min-h-[64px] w-full resize-none rounded-[14px] border border-[var(--vx-line)] bg-white/[0.03] px-3.5 py-2.5 text-[13px] leading-5 text-white outline-none transition-colors duration-200 ease-[var(--vx-ease)] placeholder:text-white/40 focus:border-[var(--vx-purple)]/55"
              value={input()}
              placeholder="Tell the agent what to do on this page…"
              onInput={(event) => setInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
                event.preventDefault()
                void runPrompt(input().trim())
              }}
            />
            <div class="mt-2 flex items-center gap-2">
              <span class="text-[11px] text-white/45">Enter to send · Shift+Enter for a new line</span>
              <Show
                when={busy()}
                fallback={
                  <button
                    type="submit"
                    class="ml-auto h-9 rounded-full bg-[linear-gradient(180deg,#efe6ff,#cdb2ff)] px-5 text-[13px] font-semibold text-[#0b0712] shadow-[0_10px_26px_rgba(147,116,236,0.26)] transition-all duration-200 ease-[var(--vx-ease)] hover:brightness-[1.04] active:scale-[0.985] disabled:opacity-50 disabled:shadow-none"
                    disabled={!input().trim() || !desktop}
                  >
                    Send
                  </button>
                }
              >
                <button
                  type="button"
                  class="ml-auto h-9 rounded-full border border-rose-400/40 bg-rose-400/10 px-5 text-[13px] font-semibold text-rose-200 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-rose-400/20"
                  onClick={stopRun}
                >
                  Stop
                </button>
              </Show>
            </div>
          </form>
        </aside>

        <main class="flex min-h-0 min-w-0 flex-1 flex-col bg-[color-mix(in_srgb,var(--vx-stage)_84%,transparent)]">
          <div class="flex h-[46px] shrink-0 items-center gap-2 border-b border-[var(--vx-line)] px-3">
            <div class="flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-white/[0.04] p-0.5">
              <button
                type="button"
                class="flex h-7 items-center gap-1 rounded-full pl-2 pr-2.5 text-[11.5px] font-medium text-white/60 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-35"
                title="Back"
                disabled={!page()?.canGoBack}
                onClick={() => void command("goBack")}
              >
                <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true"><path d="M9.75 3.75 5.5 8l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" /></svg>
                Back
              </button>
              <button
                type="button"
                class="flex h-7 items-center gap-1 rounded-full pl-2.5 pr-2 text-[11.5px] font-medium text-white/60 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-35"
                title="Forward"
                disabled={!page()?.canGoForward}
                onClick={() => void command("goForward")}
              >
                Forward
                <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true"><path d="M6.25 3.75 10.5 8l-4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium text-white/60 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-white/[0.06] hover:text-white"
                title="Reload"
                onClick={() => void command("reload")}
              >
                <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5h-2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
                Reload
              </button>
            </div>
            <form
              class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-[var(--vx-line)] bg-white/[0.03] px-3.5 transition-colors duration-200 ease-[var(--vx-ease)] focus-within:border-[var(--vx-purple)]/50"
              onSubmit={(event) => {
                event.preventDefault()
                navigateTo(address())
              }}
            >
              <span class={`size-1.5 shrink-0 rounded-full ${page()?.loading ? "animate-pulse bg-[var(--vx-purple-bright)]" : page()?.url ? "bg-[var(--vx-green)]" : "bg-white/25"}`} />
              <input
                class="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-white outline-none placeholder:text-white/40"
                value={address()}
                placeholder="http://localhost:5173"
                onFocus={() => (addressFocused = true)}
                onBlur={() => (addressFocused = false)}
                onInput={(event) => setAddress(event.currentTarget.value)}
              />
            </form>
            <Show when={issueCount() > 0}>
              <button
                type="button"
                class="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-amber-300/[0.1] px-3 text-[11.5px] font-semibold text-amber-200 transition-colors duration-200 ease-[var(--vx-ease)] hover:bg-amber-300/[0.16]"
                title="Show current page issues in chat"
                onClick={showIssues}
              >
                {issueCount()} issue{issueCount() === 1 ? "" : "s"}
              </button>
            </Show>
          </div>

          <div ref={stageRef} class="relative min-h-0 flex-1 overflow-hidden">
            <Show
              when={desktop}
              fallback={
                <Show
                  when={committedAddress() && isLocalBrowserUrl(normalizeBrowserUrl(committedAddress()))}
                  fallback={
                    <div class="relative grid h-full place-items-center px-8 text-center">
                      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(147,116,236,0.07),transparent_65%)]" aria-hidden="true" />
                      <div class="relative">
                        <img src="/vector-logo.png" alt="" class="mx-auto mb-5 size-10 rounded-[12px] object-cover opacity-50" draggable={false} />
                        <h2 class="text-[17px] font-semibold tracking-[-0.01em] text-white">
                          Your agent's{" "}
                          <em
                            class="not-italic"
                            style={{ background: "var(--vx-gradient)", "-webkit-background-clip": "text", "background-clip": "text", color: "transparent" }}
                          >
                            browser
                          </em>{" "}
                          lives here
                        </h2>
                        <p class="mx-auto mt-2 max-w-md text-[13px] leading-6 text-white/45">
                          Chat on the left drives a real browser in this pane — it activates once Vector connects to
                          this workspace. Localhost previews work right now.
                        </p>
                      </div>
                    </div>
                  }
                >
                  <iframe
                    title="Local preview"
                    src={normalizeBrowserUrl(committedAddress())}
                    class="h-full w-full border-0 bg-white"
                    sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-scripts allow-same-origin"
                  />
                </Show>
              }
            >
              {/* The embedded WebContentsView is positioned over this element by
                  the desktop main process; it renders the live page the agent
                  controls. This fallback only shows before the first page. */}
              <Show when={!page()?.url}>
                <div class="relative grid h-full place-items-center px-8 text-center">
                  <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(147,116,236,0.07),transparent_65%)]" aria-hidden="true" />
                  <div class="relative">
                    <img src="/vector-logo.png" alt="" class="mx-auto mb-5 size-10 rounded-[12px] object-cover opacity-50" draggable={false} />
                    <h2 class="text-[17px] font-semibold tracking-[-0.01em] text-white">
                      Live{" "}
                      <em
                        class="not-italic"
                        style={{ background: "var(--vx-gradient)", "-webkit-background-clip": "text", "background-clip": "text", color: "transparent" }}
                      >
                        browser
                      </em>
                    </h2>
                    <p class="mx-auto mt-2 max-w-md text-[13px] leading-6 text-white/45">
                      Open a URL above or just tell the agent what to do — the page appears here and stays live while the
                      agent works. Click or type in it yourself at any time to take over.
                    </p>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </main>
      </div>
    </section>
  )
}
