import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { CloudApi, CloudBuildSettings } from "./cloud-api"

export type CloudBuildDraft = Omit<CloudBuildSettings, "source" | "updatedAt">
type Scope = { projectPath: string; taskId?: string }

function buildDraft(settings?: CloudBuildSettings | null): CloudBuildDraft {
  return {
    framework: settings?.framework ?? "",
    packageManager: settings?.packageManager ?? "npm",
    installCommand: settings?.installCommand ?? "",
    testCommand: settings?.testCommand ?? "",
    buildCommand: settings?.buildCommand ?? "",
    outputDirectory: settings?.outputDirectory ?? "",
    nodeVersion: settings?.nodeVersion ?? "",
    healthPath: settings?.healthPath ?? "/",
    requiredChecks: settings
      ? { ...settings.requiredChecks }
      : { test: false, secrets: true, health: true, browser: true },
  }
}

export function createCloudBuild(input: {
  api: () => CloudApi["build"] | undefined
  notice: (notice: { tone: "success" | "error"; text: string }) => void
}) {
  const [state, setState] = createStore({
    settings: null as CloudBuildSettings | null,
    draft: buildDraft(),
    busy: "",
  })
  const lifecycle = { scope: { projectPath: "" } as Scope, revision: 0 }
  const reset = () => {
    lifecycle.revision++
    setState({ settings: null, draft: buildDraft(), busy: "" })
  }
  onCleanup(reset)

  const perform = async (operation: "detect" | "save") => {
    const api = input.api()
    const scope = lifecycle.scope
    if (!api || !scope.projectPath || state.busy) return
    const revision = ++lifecycle.revision
    setState("busy", operation)
    try {
      const settings = await (operation === "detect"
        ? api.detect(scope.projectPath, scope.taskId)
        : api.set(scope.projectPath, scope.taskId, { ...state.draft, requiredChecks: { ...state.draft.requiredChecks } }))
      if (revision !== lifecycle.revision) return
      setState("settings", settings)
      if (operation === "detect") setState("draft", buildDraft(settings))
      input.notice({
        tone: "success",
        text: operation === "detect"
          ? `Detected ${settings.framework} with ${settings.packageManager}. Review the commands, then save.`
          : "Build and runtime settings saved for this project session.",
      })
    } catch (error) {
      if (revision !== lifecycle.revision) return
      input.notice({ tone: "error", text: error instanceof Error ? error.message : `Could not ${operation} build settings.` })
    } finally {
      if (revision === lifecycle.revision) setState("busy", "")
    }
  }

  return {
    state,
    changeScope: (projectPath: string, taskId?: string) => {
      if (lifecycle.scope.projectPath === projectPath && lifecycle.scope.taskId === taskId) return
      lifecycle.scope = { projectPath, taskId }
      reset()
    },
    setDraft: (update: (current: CloudBuildDraft) => CloudBuildDraft) => {
      if (state.busy) return
      lifecycle.revision++
      setState("draft", update(state.draft))
    },
    refresh: async () => {
      const api = input.api()
      const scope = lifecycle.scope
      if (!api || !scope.projectPath || state.busy) return
      const revision = ++lifecycle.revision
      try {
        const settings = await api.get(scope.projectPath, scope.taskId)
        if (revision !== lifecycle.revision) return
        setState({ settings, draft: buildDraft(settings) })
      } catch (error) {
        if (revision !== lifecycle.revision) return
        input.notice({ tone: "error", text: error instanceof Error ? error.message : "Could not load build settings." })
      }
    },
    detect: () => perform("detect"),
    save: () => perform("save"),
  }
}
