import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import type { VectorAccountStatus } from "@/vector-account"
import { Show, onMount, onCleanup } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { FREE_MODELS_TITLE, OPENROUTER_ACCOUNT_COPY } from "@vectordevai/core/free-model-choice"
import { useProviders } from "@/hooks/use-providers"
import { DialogConnectProvider } from "./dialog-connect-provider"

/** No fallback list or remembered client flag can enable this card. */
export function FreeModelsCard() {
  const platform = usePlatform()
  const [status, setStatus] = createStore<VectorAccountStatus>({ authenticated: false, pending: false })
  onMount(() => {
    const account = platform.vectorAccount
    if (!account) return
    onCleanup(account.onChange(setStatus))
    void account
      .status()
      .then(setStatus)
      .catch(() => {})
  })
  const signIn = () => {
    void platform.vectorAccount
      ?.start()
      .then(setStatus)
      .catch(() => setStatus("error", "Could not start sign-in. Try again in Settings → Providers."))
  }
  const providers = useProviders()
  const dialog = useDialog()
  const enabled = () =>
    [...providers.all().values()].some((provider) => Object.values(provider.models).some((model) => model.freeModel))
  return (
    <Show when={enabled()}>
      <section data-component="free-models-card" class="mb-3 rounded-lg border border-border-base p-3 text-text-base">
        <h3 class="text-14-medium">{FREE_MODELS_TITLE}</h3>
        <p class="mt-2 text-12-regular">
          Start with a shared allowance by signing in to Vector, or connect your own OpenRouter account. OpenRouter and
          its model providers process your prompts.
        </p>
        <p class="mt-2 text-12-regular">{OPENROUTER_ACCOUNT_COPY}</p>
        <Show when={status.error}>
          <p role="alert">{status.error}</p>
        </Show>
        <Show when={status.pending}>
          <p role="status">Finish signing in in your browser, then return to Vector.</p>
        </Show>
        <div class="mt-3 flex flex-wrap gap-3 text-12-medium">
          <Show when={platform.vectorAccount && !status.authenticated}>
            <button type="button" disabled={status.pending} onClick={signIn}>
              Sign in to Vector
            </button>
          </Show>
          <button
            type="button"
            onClick={() => dialog.show(() => <DialogConnectProvider provider="openrouter" preferredMethod="oauth" />)}
          >
            Connect OpenRouter
          </button>
        </div>
      </section>
    </Show>
  )
}
