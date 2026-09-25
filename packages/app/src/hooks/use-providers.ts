import { isHiddenProvider } from "@/utils/provider-brand"
import { createEffect } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { takeProviderNotice } from "@/utils/provider-notices"
import { showToast } from "@/utils/toast"
import { providerEnabled } from "@vectordevai/schema/provider-policy"
import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import type { Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"

export const popularProviders = ["anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"].filter(
  providerEnabled,
)
const popularProviderSet = new Set(popularProviders)
// Built-in catalog entries and explicit custom providers can appear in setup.

type ProviderInfo = ReturnType<typeof selectProviderCatalog>["all"] extends Map<string, infer T> ? T : never

function connectedProvider(provider: ProviderInfo | undefined): ProviderInfo[] {
  return provider ? [provider] : []
}

export function useProviders(directory?: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const params = useParams()
  const serverSDK = useServerSDK()
  const language = useLanguage()
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
  createEffect(() => {
    const directory = dir()
    if (directory ? !serverSync().child(directory)[0].provider_ready : !serverSync().data.ready) return
    for (const item of providers().unavailable ?? []) {
      if (!takeProviderNotice(serverSDK().scope, `credential:${item.id}:${item.reason}`)) continue
      showToast({
        title: language.t("provider.unavailable.title", { provider: providers().all.get(item.id)?.name ?? item.id }),
        description: language.t(`provider.unavailable.${item.reason}`, { provider: item.id }),
        duration: 10000,
      })
    }
  })
  return {
    all: () => new Map([...providers().all].filter(([id, provider]) => !isHiddenProvider(id, provider))),
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        Iterable.filter((p) => !isHiddenProvider(p.id, p)),
        (v) => Array.from(v),
      ),
    connected: () => {
      return providers()
        .connected.filter((id) => !isHiddenProvider(id, providers().all.get(id)))
        .flatMap((id) => connectedProvider(providers().all.get(id)))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [
        ...Iterable.filter(providers().all, ([id, provider]) => connected.has(id) && !isHiddenProvider(id, provider)),
      ]
    },
  }
}
