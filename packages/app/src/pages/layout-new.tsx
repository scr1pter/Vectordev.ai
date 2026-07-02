import { createEffect, createSignal, onCleanup, Show, Suspense, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { HelpButton } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlanMode } from "@/context/plan-mode"
import { usePlatform } from "@/context/platform"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const planMode = usePlanMode()
  const navigate = useNavigate()
  const [colorMode, setColorMode] = createSignal<"dark" | "light">(
    typeof localStorage === "undefined" || localStorage.getItem("vector.theme") !== "light" ? "dark" : "light",
  )
  const [sidePanelOpen, setSidePanelOpen] = createSignal(false)
  const [sidePanelMode, setSidePanelMode] = createSignal<"web" | "files">("web")
  const [webAddress, setWebAddress] = createSignal("http://localhost:5173")
  const [webViewUrl, setWebViewUrl] = createSignal("")
  const [webFrameKey, setWebFrameKey] = createSignal(0)
  setNavigate(navigate)

  createEffect(() => setV2Toast(true))
  createEffect(() => {
    const theme = colorMode()
    document.documentElement.dataset.vectorTheme = theme
    localStorage.setItem("vector.theme", theme)
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
  }

  const webFrameSrc = () => {
    const url = webViewUrl()
    if (!url) return ""
    return `${url}${url.includes("?") ? "&" : "?"}vector_preview_reload=${webFrameKey()}`
  }

  const toggleSidePanel = (mode: "web" | "files") => {
    const sameMode = sidePanelMode() === mode
    setSidePanelMode(mode)
    setSidePanelOpen((open) => (sameMode ? !open : true))
  }

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
      data-vector-theme={colorMode()}
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar update={update} />
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      <div class="pointer-events-none fixed right-4 top-12 z-40 flex flex-col items-end gap-2">
        <button
          type="button"
          class="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-semibold shadow-[0_14px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl transition"
          classList={{
            "border-[#9b6cff]/70 bg-[#9b6cff]/25 text-[#dccfff]": planMode.enabled(),
            "border-white/10 bg-[#1f1f22]/90 text-white hover:border-[#9b6cff]/60 hover:bg-[#27232f]": !planMode.enabled(),
          }}
          aria-pressed={planMode.enabled()}
          title="Plan Mode. Shift+Tab toggles planning/review behavior and blocks file-changing actions."
          onClick={() => planMode.toggle()}
        >
          <span class="grid size-5 place-items-center rounded-full bg-[#9b6cff]/20 text-[#c9b2ff]">
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <path
                d="M4 3.75h8M4 7.75h8M4 11.75h5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          </span>
          Plan Mode
          <span class="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60">Shift Tab</span>
        </button>
        <button
          type="button"
          class="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-[#1f1f22]/90 px-3 text-[12px] font-medium text-white shadow-[0_14px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl transition hover:border-[#9b6cff]/60 hover:bg-[#27232f] dark:[color-scheme:dark]"
          aria-pressed={colorMode() === "light"}
          title="Toggle Vector light mode."
          onClick={() => setColorMode((mode) => (mode === "light" ? "dark" : "light"))}
        >
          <span class="grid size-5 place-items-center rounded-full bg-[#9b6cff]/20 text-[#b99cff]">
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <path
                d="M8 2.25v1.5M8 12.25v1.5M3.58 3.58l1.06 1.06m6.72 6.72 1.06 1.06M2.25 8h1.5m8.5 0h1.5M3.58 12.42l1.06-1.06m6.72-6.72 1.06-1.06"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linecap="round"
              />
              <circle cx="8" cy="8" r="2.25" fill="currentColor" />
            </svg>
          </span>
          {colorMode() === "light" ? "Light" : "Dark"}
        </button>
        <button
          type="button"
          class="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-[#1f1f22]/90 px-3 text-[12px] font-medium text-white shadow-[0_14px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl transition hover:border-[#9b6cff]/60 hover:bg-[#27232f]"
          aria-pressed={sidePanelOpen()}
          onClick={() => toggleSidePanel("web")}
        >
          <span class="grid size-5 place-items-center rounded-full bg-[#9b6cff]/20 text-[#b99cff]">
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <path
                d="M2.5 5.5C3.95 3.64 5.78 2.75 8 2.75s4.05.89 5.5 2.75c.34.44.34 1.06 0 1.5C12.05 8.86 10.22 9.75 8 9.75S3.95 8.86 2.5 7a1.22 1.22 0 0 1 0-1.5Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
              />
              <circle cx="8" cy="6.25" r="1.6" fill="currentColor" />
              <path d="M3 12.75h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </span>
          Web view
        </button>
        <button
          type="button"
          class="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-[#1f1f22]/90 px-3 text-[12px] font-medium text-white shadow-[0_14px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl transition hover:border-[#9b6cff]/60 hover:bg-[#27232f]"
          aria-pressed={sidePanelOpen() && sidePanelMode() === "files"}
          onClick={() => toggleSidePanel("files")}
        >
          <span class="grid size-5 place-items-center rounded-full bg-[#9b6cff]/20 text-[#b99cff]">
            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
              <path
                d="M3.25 2.75h4.3l1.7 1.7v8.8h-6V2.75Zm4.25 0v2h1.75M11.75 5.25h1v8h-6v-1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          Edited files
        </button>
      </div>
      <aside
        class="fixed bottom-4 right-4 top-[92px] z-50 w-[min(440px,calc(100vw-32px))] overflow-hidden rounded-[24px] border border-white/10 bg-[#151518]/95 shadow-[0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl transition duration-200 ease-out"
        classList={{
          "pointer-events-auto translate-x-0 opacity-100": sidePanelOpen(),
          "pointer-events-none translate-x-[calc(100%+32px)] opacity-0": !sidePanelOpen(),
        }}
      >
        <div class="flex h-full flex-col">
          <div class="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
            <div class="flex rounded-full bg-white/[0.045] p-1">
              <button
                type="button"
                class="rounded-full px-3 py-1.5 text-[12px] font-semibold transition"
                classList={{
                  "bg-[#9b6cff] text-white": sidePanelMode() === "web",
                  "text-white/[0.55] hover:text-white": sidePanelMode() !== "web",
                }}
                onClick={() => setSidePanelMode("web")}
              >
                Web view
              </button>
              <button
                type="button"
                class="rounded-full px-3 py-1.5 text-[12px] font-semibold transition"
                classList={{
                  "bg-[#9b6cff] text-white": sidePanelMode() === "files",
                  "text-white/[0.55] hover:text-white": sidePanelMode() !== "files",
                }}
                onClick={() => setSidePanelMode("files")}
              >
                Edited files
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
                <div class="rounded-[18px] border border-white/[0.08] bg-white/[0.035] p-4">
                  <div class="text-[13px] font-semibold text-white">Files Vector touched</div>
                  <p class="mt-2 text-[12px] leading-5 text-white/[0.55]">
                    Vector keeps generated edits in the review flow. Open the session Review panel to inspect exact
                    files, split diffs, and changed lines before trusting the result.
                  </p>
                </div>
                <div class="grid gap-2 text-[12px] text-white/50">
                  <div class="rounded-xl border border-dashed border-white/10 px-3 py-2">Review changed files.</div>
                  <div class="rounded-xl border border-dashed border-white/10 px-3 py-2">
                    Preview running apps beside the conversation.
                  </div>
                </div>
              </div>
            }
          >
            <div class="flex min-h-0 flex-1 flex-col bg-[#0f0f11]">
              <form
                class="flex items-center gap-2 border-b border-white/[0.08] px-4 py-3"
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
                  class="min-w-0 flex-1 rounded-full border border-white/[0.08] bg-white/[0.045] px-3 py-1.5 text-[11px] text-white outline-none transition placeholder:text-white/[0.32] focus:border-[#9b6cff]/60"
                  value={webAddress()}
                  placeholder="http://localhost:5173"
                  onInput={(event) => setWebAddress(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  class="rounded-full bg-white/[0.08] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-[#9b6cff]/35"
                >
                  Open
                </button>
              </form>
              <div class="flex gap-2 border-b border-white/[0.06] px-4 py-2">
                {["5173", "3000", "4173", "8080"].map((port) => (
                  <button
                    type="button"
                    class="rounded-full border border-white/[0.08] px-2.5 py-1 text-[10px] font-medium text-white/[0.55] transition hover:border-[#9b6cff]/50 hover:text-white"
                    onClick={() => openWebView(`http://localhost:${port}`)}
                  >
                    :{port}
                  </button>
                ))}
                <button
                  type="button"
                  class="ml-auto rounded-full border border-white/[0.08] px-2.5 py-1 text-[10px] font-medium text-white/[0.55] transition hover:border-[#9b6cff]/50 hover:text-white"
                  onClick={() => {
                    if (webViewUrl()) setWebFrameKey((key) => key + 1)
                  }}
                >
                  Reload
                </button>
              </div>
              <div class="min-h-0 flex-1 bg-[#08080a]">
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
                        <h2 class="mt-5 text-[18px] font-semibold text-white">Web view</h2>
                        <p class="mt-2 max-w-[290px] text-[12px] leading-5 text-white/[0.52]">
                          Start a dev server, then open its localhost URL here to inspect the running app beside your
                          Vector conversation.
                        </p>
                      </div>
                    </div>
                  }
                >
                  <iframe
                    src={webFrameSrc()}
                    title="Vector web view"
                    class="h-full w-full border-0 bg-white"
                    sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"
                  />
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
