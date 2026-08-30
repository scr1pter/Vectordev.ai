export type ExternalAgentWorkspaceView = "chat" | "files" | "changes" | "terminal" | "browser" | "activity"

export const externalAgentWorkspaceTabs: { value: ExternalAgentWorkspaceView; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "files", label: "Files" },
  { value: "changes", label: "Changes" },
  { value: "terminal", label: "Terminal" },
  { value: "browser", label: "Browser" },
  { value: "activity", label: "Activity" },
]
