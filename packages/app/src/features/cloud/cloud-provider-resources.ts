import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { CloudApi, CloudProviderId, CloudProviderResource } from "./cloud-api"

export function createCloudProviderResources(input: {
  api: () => Pick<CloudApi["providers"], "resources"> | undefined
}) {
  const empty = () => ({ items: [] as CloudProviderResource[], loading: false, loaded: false, error: "" })
  const [state, setState] = createStore({ vercel: empty(), netlify: empty(), supabase: empty() })
  const revisions = { vercel: 0, netlify: 0, supabase: 0 }
  const clear = (provider: CloudProviderId) => {
    revisions[provider]++
    setState(provider, empty())
  }
  onCleanup(() => {
    clear("vercel")
    clear("netlify")
    clear("supabase")
  })

  return {
    state,
    clear,
    refresh: async (provider: CloudProviderId) => {
      const api = input.api()
      if (!api) return
      const revision = ++revisions[provider]
      setState(provider, { loading: true, error: "" })
      try {
        const items = await api.resources(provider)
        if (revisions[provider] !== revision) return
        setState(provider, { items, loaded: true })
      } catch (error) {
        if (revisions[provider] !== revision) return
        setState(provider, "error", error instanceof Error ? error.message : "Could not load projects. Try again.")
      } finally {
        if (revisions[provider] === revision) setState(provider, "loading", false)
      }
    },
  }
}
