import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import type { Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"

export const popularProviders = ["anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]
const popularProviderSet = new Set(popularProviders)
// Only reviewed provider IDs can appear in Vector provider setup.
export { isHiddenProvider } from "@/utils/provider-brand"
import { isHiddenProvider } from "@/utils/provider-brand"

type ProviderInfo = ReturnType<typeof selectProviderCatalog>["all"] extends Map<string, infer T> ? T : never

function connectedProvider(provider: ProviderInfo | undefined): ProviderInfo[] {
  return provider ? [provider] : []
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
        explicit: false,
        directory: value,
        catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
        global: serverSync().data.provider,
      })
    return selectProviderCatalog({
      explicit: false,
      directory: value,
      catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      global: serverSync().data.provider,
    })
  }
  return {
    all: () => new Map([...providers().all].filter(([id]) => !isHiddenProvider(id))),
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        Iterable.filter((p) => !isHiddenProvider(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      return providers()
        .connected.filter((id) => !isHiddenProvider(id))
        .flatMap((id) => connectedProvider(providers().all.get(id)))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [...Iterable.filter(providers().all, ([id]) => connected.has(id) && !isHiddenProvider(id))]
    },
  }
}
