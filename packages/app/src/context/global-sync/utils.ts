import type { Agent, Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { isHiddenProvider } from "@/utils/provider-brand"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

/** Drop retired providers and deprecated models at the shared ingestion boundary. */
export function normalizeProviderList(input: ProviderListResponse): NormalizedProviderListResponse {
  return {
    ...input,
    connected: input.connected.filter((id) => !isHiddenProvider(id)),
    default: Object.fromEntries(Object.entries(input.default).filter(([id]) => !isHiddenProvider(id))),
    all: new Map(
      input.all
        .filter((provider) => !isHiddenProvider(provider.id))
        .map(
          (provider) =>
            [
              provider.id,
              {
                ...provider,
                models: Object.fromEntries(
                  Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
                ),
              },
            ] as const,
        ),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
