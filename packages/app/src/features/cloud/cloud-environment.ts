import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { CloudApi, CloudEnvVar, CloudEnvVisibility } from "./cloud-api"

type Scope = { projectPath: string; taskId?: string }
type EnvironmentApi = Pick<CloudApi, "env">
type Notice = { tone: "success" | "error"; text: string }

export function createCloudEnvironment(input: {
  api: () => EnvironmentApi | undefined
  notice: (notice: Notice) => void
}) {
  const [state, setState] = createStore({
    variables: [] as CloudEnvVar[],
    key: "",
    value: "",
    // Empty lets the desktop decide from the name: a browser-visible prefix
    // such as VITE_ means public, anything else is server-only.
    visibility: "" as "" | CloudEnvVisibility,
    revealedKey: "",
    busy: "",
    loaded: false,
  })
  const lifecycle = { scope: { projectPath: "" } as Scope, revision: 0 }
  const isCurrent = (scope: Scope) => lifecycle.scope === scope
  const changeScope = (projectPath: string, taskId?: string) => {
    if (lifecycle.scope.projectPath === projectPath && lifecycle.scope.taskId === taskId) return
    lifecycle.scope = { projectPath, taskId }
    lifecycle.revision++
    setState({ variables: [], key: "", value: "", visibility: "", revealedKey: "", busy: "", loaded: false })
  }
  onCleanup(() => {
    lifecycle.scope = { projectPath: "" }
    lifecycle.revision++
    setState({ variables: [], key: "", value: "", visibility: "", revealedKey: "", busy: "", loaded: false })
  })

  const refresh = async () => {
    const api = input.api()
    const scope = lifecycle.scope
    const revision = lifecycle.revision
    if (!api || !scope.projectPath) return
    try {
      const variables = await api.env.list(scope.projectPath, scope.taskId)
      if (isCurrent(scope) && revision === lifecycle.revision) setState({ variables, loaded: true })
    } catch (error) {
      if (!isCurrent(scope) || revision !== lifecycle.revision) return
      input.notice({ tone: "error", text: error instanceof Error ? error.message : "Could not load variables." })
    }
  }

  // A completed operation belongs to the original view, including after switching away and back.
  const perform = async <T>(
    operation: string,
    action: (api: EnvironmentApi, scope: Scope) => Promise<T>,
    commit: (result: T) => void,
  ) => {
    const api = input.api()
    const scope = lifecycle.scope
    if (!api || !scope.projectPath || state.busy) return
    lifecycle.revision++
    setState("busy", operation)
    try {
      const result = await action(api, scope)
      if (isCurrent(scope)) commit(result)
    } catch (error) {
      if (!isCurrent(scope)) return
      input.notice({ tone: "error", text: error instanceof Error ? error.message : "Could not update variables." })
    } finally {
      if (isCurrent(scope)) {
        lifecycle.revision++
        setState("busy", "")
      }
    }
  }

  return {
    state,
    changeScope,
    scope: () => lifecycle.scope,
    isCurrent,
    refresh,
    setKey: (key: string) => setState("key", key),
    setValue: (value: string) => setState("value", value),
    setVisibility: (visibility: "" | CloudEnvVisibility) => setState("visibility", visibility),
    reveal: (key: string) => setState("revealedKey", state.revealedKey === key ? "" : key),
    hide: () => setState("revealedKey", ""),
    save: async () => {
      const key = state.key.trim()
      const value = state.value
      const visibility = state.visibility || undefined
      if (!key) return
      await perform(
        "save",
        (api, scope) => api.env.set(scope.projectPath, scope.taskId, key, value, visibility),
        (variables) => {
          setState({ variables, loaded: true })
          if (state.key.trim() === key && state.value === value) setState({ key: "", value: "", visibility: "" })
        },
      )
    },
    remove: (key: string) =>
      perform(
        "remove",
        (api, scope) => api.env.remove(scope.projectPath, scope.taskId, key),
        (variables) => {
          setState({ variables, loaded: true })
          if (state.revealedKey === key) setState("revealedKey", "")
        },
      ),
    apply: () => {
      if (!state.loaded) return
      const count = state.variables.length
      return perform(
        "apply",
        (api, scope) => api.env.apply(scope.projectPath, scope.taskId),
        (result) =>
          input.notice({
            tone: "success",
            text: count
              ? `Wrote ${count} ${count === 1 ? "variable" : "variables"} to ${result.written} in your project.`
              : `Cleared Vector's managed variables from ${result.written} in your project.`,
          }),
      )
    },
  }
}
