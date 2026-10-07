import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { CloudApi, CloudSupabaseServices } from "./cloud-api"

type Scope = { projectPath: string; taskId?: string }

export function createCloudServices(input: { api: () => Pick<CloudApi["services"], "supabase"> | undefined }) {
  const [state, setState] = createStore({
    snapshot: undefined as CloudSupabaseServices | undefined,
    busy: false,
    loaded: false,
    error: "",
  })
  const lifecycle = { scope: { projectPath: "" } as Scope, revision: 0 }
  const reset = () => {
    lifecycle.revision++
    setState({ snapshot: undefined, busy: false, loaded: false, error: "" })
  }
  onCleanup(reset)

  return {
    state,
    reset,
    changeScope: (projectPath: string, taskId?: string) => {
      if (lifecycle.scope.projectPath === projectPath && lifecycle.scope.taskId === taskId) return
      lifecycle.scope = { projectPath, taskId }
      reset()
    },
    refresh: async () => {
      const api = input.api()
      const scope = lifecycle.scope
      if (!api || !scope.projectPath || state.busy) return
      const revision = ++lifecycle.revision
      setState({ busy: true, error: "" })
      try {
        const snapshot = await api.supabase(scope.projectPath, scope.taskId)
        if (revision !== lifecycle.revision) return
        setState("snapshot", snapshot)
      } catch (error) {
        if (revision !== lifecycle.revision) return
        setState("error", error instanceof Error ? error.message : "Could not load Supabase services. Try again.")
      } finally {
        if (revision === lifecycle.revision) setState({ busy: false, loaded: true })
      }
    },
  }
}
