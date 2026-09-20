import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import type { Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"

export const popularProviders = [
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)
// OpenCode Zen's keyless gateway is not Vector's to serve: those requests run
// against OpenCode's endpoint. The engine no longer loads it without a key of the
// user's own (ZEN_PUBLIC_GATEWAY in opencode/src/provider/provider.ts), and these
// entries keep it out of the connect dialog and the provider lists as well.
const hiddenProviderSet = new Set<string>(["opencode", "opencode-zen", "opencode-go"])

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
    all: () => providers().all,
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        Iterable.filter((p) => !hiddenProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      return providers().connected
        .filter((id) => !hiddenProviderSet.has(id))
        .flatMap((id) => connectedProvider(providers().all.get(id)))
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
