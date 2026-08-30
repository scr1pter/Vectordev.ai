export type WorkspaceMode = "agent" | "editor"

export const WORKSPACE_MODE_CHANGED_EVENT = "vector:workspace-mode-changed"

export function announceWorkspaceMode(mode: WorkspaceMode) {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_MODE_CHANGED_EVENT, {
      detail: { mode },
    }),
  )
}

export function workspaceModeFromEvent(event: Event) {
  if (!(event instanceof CustomEvent)) return
  const mode = (event.detail as { mode?: unknown } | undefined)?.mode
  if (mode === "agent" || mode === "editor") return mode
}
