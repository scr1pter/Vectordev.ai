import { createSimpleContext } from "@opencode-ai/ui/context"
import { useLocation } from "@solidjs/router"
import { createEffect, createSignal } from "solid-js"
import { planModeRouteScope, shouldResetPlanMode } from "./plan-mode-scope"

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
    // Plan mode is deliberately ephemeral. Persisting it across launches made
    // ordinary build prompts silently inherit read-only behavior from an old
    // task, which is both surprising and difficult to diagnose.
    const [enabled, setEnabledSignal] = createSignal(false)
    const location = useLocation()
    let activeScope = planModeRouteScope(location.pathname, location.search)

    createEffect(() => {
      const next = planModeRouteScope(location.pathname, location.search)
      if (shouldResetPlanMode(activeScope, next)) setEnabledSignal(false)
      activeScope = next
    })

    return {
      enabled,
      setEnabled: setEnabledSignal,
      toggle: () => setEnabledSignal((value) => !value),
    }
  },
})
