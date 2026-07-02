import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import type { Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

type ProviderInfo = ReturnType<typeof selectProviderCatalog>["all"] extends Map<string, infer T> ? T : never

function costInput(cost: unknown): number {
  if (Array.isArray(cost)) return Math.max(0, ...cost.map((item) => costInput(item)))
  if (!cost || typeof cost !== "object" || !("input" in cost)) return 0
  const value = (cost as { input?: unknown }).input
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function withPublicVectorModels(provider: ProviderInfo, connected: boolean) {
  if (connected || provider.id !== "opencode") return provider
  const freeModels = Object.fromEntries(
    Object.entries(provider.models).filter(([, model]) => costInput(model.cost) === 0),
  )
  if (Object.keys(freeModels).length === 0) return
  return { ...provider, name: "Vector", models: freeModels }
}

export function useProviders(directory?: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))
  const providers = () => {
    const value = dir()
    const projectStore = value ? serverSync().child(value)[0] : undefined
    if (directory)
      return selectProviderCatalog({
        explicit: true,
        directory: value,
        catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      })
    return selectProviderCatalog({
      explicit: false,
      directory: value,
      catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      global: serverSync().data.provider,
    })
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return Array.from(providers().all.values()).flatMap((provider) => {
        const item = withPublicVectorModels(provider, connected.has(provider.id))
        return item ? [item] : []
      })
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "opencode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
    },
  }
}
