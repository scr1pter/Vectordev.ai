import { pathKey } from "./path-key"

export const WORKSPACE_FILE_SAVED_EVENT = "vector:workspace-file-saved"

export type WorkspaceFileSavedDetail = {
  directory: string
  path: string
}

export function workspaceFileSavedDetail(event: Event) {
  if (!("detail" in event)) return
  const detail = event.detail
  if (!detail || typeof detail !== "object") return
  if (!("directory" in detail) || typeof detail.directory !== "string" || !detail.directory) return
  if (!("path" in detail) || typeof detail.path !== "string" || !detail.path) return
  return { directory: detail.directory, path: detail.path } satisfies WorkspaceFileSavedDetail
}

export function workspaceFileSavedMatchesDirectory(event: Event, directory: string) {
  const detail = workspaceFileSavedDetail(event)
  return !!detail && pathKey(detail.directory) === pathKey(directory)
}

export function notifyWorkspaceFileSaved(
  detail: WorkspaceFileSavedDetail,
  target: EventTarget | undefined = globalThis.window,
) {
  target?.dispatchEvent(new CustomEvent(WORKSPACE_FILE_SAVED_EVENT, { detail }))
}
