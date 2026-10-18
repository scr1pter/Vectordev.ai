import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import type { VectorAccountStatus } from "@/vector-account"
import { Show, createSignal, onMount, onCleanup } from "solid-js"
import {
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODELS_SHARED_COPY,
  FREE_MODELS_SIGN_IN,
  FREE_MODELS_TITLE,
} from "@vectordevai/core/free-model-choice"
import { useServerSDK } from "@/context/server-sdk"

/**
 * Free models run on Vector's shared allowance for every signed-in Vector account, so this card offers signing in to
 * Vector and never an OpenRouter account of the user's own (owner decision, 17 October 2026).
 */
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
  const serverSDK = useServerSDK()
  // The one-time acceptance for models that may train on prompts, which the person can withdraw here.
  const [training, setTraining] = createSignal(false)
  onMount(() => {
    void serverSDK()
      .client.provider.freeModels.consent()
      .then((result) => setTraining(result.data?.training === true))
      .catch(() => {})
  })
  const withdraw = () => {
    void serverSDK()
      .client.provider.freeModels.setConsent({ freeModelConsent: { training: false } })
      .then((result) => setTraining(result.data?.training === true))
      .catch(() => {})
  }
  return (
    <section data-component="free-models-card" class="mb-3 rounded-lg border border-border-base p-3 text-text-base">
      <h3 class="text-14-medium">{FREE_MODELS_TITLE}</h3>
      <p class="mt-2 text-12-regular">{FREE_MODELS_SHARED_COPY}</p>
      <Show when={platform.vectorAccount && !status.authenticated}>
        <p class="mt-2 text-12-regular">{FREE_MODELS_SIGN_IN}</p>
      </Show>
      <Show when={training()}>
        <p class="mt-2 text-12-regular" data-slot="free-models-training-consent">
          You accepted that free models labelled "{FREE_MODEL_TRAINING_LABEL}" may receive your prompts. Vector asks
          again after you withdraw.{" "}
          <button type="button" class="underline" onClick={withdraw}>
            Withdraw
          </button>
        </p>
      </Show>
      <Show when={status.error}>
        <p role="alert">{status.error}</p>
      </Show>
      <Show when={status.pending}>
        <p role="status">Finish signing in in your browser, then return to Vector.</p>
      </Show>
      <Show when={platform.vectorAccount && !status.authenticated}>
        <div class="mt-3 flex flex-wrap gap-3 text-12-medium">
          <button type="button" disabled={status.pending} onClick={signIn}>
            Sign in to Vector
          </button>
        </div>
      </Show>
    </section>
  )
}
