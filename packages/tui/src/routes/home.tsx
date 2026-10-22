import {
  FREE_MODELS_SHARED_COPY,
  FREE_MODELS_SIGN_IN_TERMINAL,
  FREE_MODELS_TITLE,
} from "@vectordevai/core/free-model-choice"
import { DialogProvider } from "../component/dialog-provider"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { HomeSessionDestinationProvider } from "./home/session-destination"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this repository?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <Logo />
          </pluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </pluginRuntime.Slot>
        </box>
        <Show when={freeModelsStartNotice(sync.data)}>
          {(lines) => (
            <box width="100%" maxWidth={promptMaxWidth()} paddingTop={1} gap={1}>
              <text fg={theme.text}>{FREE_MODELS_TITLE}</text>
              <For each={lines()}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
              <text fg={theme.primary} onMouseUp={() => dialog.replace(() => <DialogProvider />)}>
                Connect a provider with your own key
              </text>
            </box>
          )}
        </Show>
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}

/**
 * The free-model notice under the home prompt, between its title and the connect link, shown while no provider is
 * connected: how to start, then the shared-allowance sentence. It holds no disclaimer; the one-time acceptance question
 * is the one place that explains the "May train on your prompts" label. Free models run on Vector's shared allowance
 * for every signed-in Vector account, so the free way to start is signing in to Vector, never connecting an OpenRouter
 * account (owner decision, 17 October 2026). The shared models are listed, still disconnected, while the catalog serves
 * them and nobody is signed in; with none listed, the shared allowance serves nothing right now.
 */
export function freeModelsStartNotice(data: {
  provider: readonly unknown[]
  provider_next: { all: readonly { models: Readonly<Record<string, { freeModel?: { source: string } }>> }[] }
}) {
  if (data.provider.length) return undefined
  const hint = data.provider_next.all.some((provider) =>
    Object.values(provider.models).some((model) => model.freeModel?.source === "shared"),
  )
    ? `${FREE_MODELS_SIGN_IN_TERMINAL} Or use /connect to connect a provider with your own key.`
    : `${FREE_MODELS_TITLE} are unavailable right now. Use /connect to connect a provider with your own key.`
  return [hint, FREE_MODELS_SHARED_COPY]
}
