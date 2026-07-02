import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createSignal, onMount } from "solid-js"

const STORAGE_KEY = "vector.plan-mode.enabled"

export const PLAN_MODE_INSTRUCTION = [
  "PLAN MODE is ON.",
  "Do not create, edit, delete, rename, or overwrite files.",
  "Do not run shell commands or use tools that mutate the workspace.",
  "You may inspect the request, reason about the repository, identify relevant files, list risks, and propose a concise implementation plan.",
  "If the user asks for code changes, explain exactly what you would change and wait for the user to exit Plan Mode before making edits.",
].join(" ")

export const { use: usePlanMode, provider: PlanModeProvider } = createSimpleContext({
  name: "PlanMode",
  gate: false,
  init: () => {
    const [enabled, setEnabledSignal] = createSignal(false)

    onMount(() => {
      setEnabledSignal(globalThis.localStorage?.getItem(STORAGE_KEY) === "1")
    })

    createEffect(() => {
      globalThis.localStorage?.setItem(STORAGE_KEY, enabled() ? "1" : "0")
    })

    return {
      enabled,
      setEnabled: setEnabledSignal,
      toggle: () => setEnabledSignal((value) => !value),
    }
  },
})
