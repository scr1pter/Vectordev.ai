import { useMutation } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2/client"

type AddMcpInput = {
  name: string
  config: McpLocalConfig | McpRemoteConfig
}

export function useMcpAdd() {
  const sync = useSync()
  const language = useLanguage()

  return useMutation(() => ({
    mutationFn: (input: AddMcpInput) => sync().mcp.add(input.name, input.config),
    // The add succeeds as a request even when the server fails to start, so report the
    // real post-connect status: only claim "connected" when the tools are actually live,
    // otherwise the agent silently has no browser/tool access despite a success toast.
    onSuccess: (status: McpStatus | undefined, input) => {
      if (status?.status === "connected") {
        showToast({
          variant: "success",
          title: "MCP connected",
          description: `${input.name} is now available to Vector.`,
        })
        return
      }
      if (status?.status === "needs_auth" || status?.status === "needs_client_registration") {
        showToast({
          variant: "default",
          title: "Authorization required",
          description: `${input.name} was added. Finish authorizing it to start using it.`,
        })
        return
      }
      showToast({
        variant: "error",
        title: "MCP not connected",
        description:
          (status && "error" in status && status.error) ||
          `${input.name} was added but failed to start. Check its command and that its requirements (e.g. Node/npx, Google Chrome) are installed.`,
      })
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))
}

export function useMcpToggle() {
  const sync = useSync()
  const language = useLanguage()

  return useMutation(() => ({
    mutationFn: sync().mcp.toggle,
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))
}
