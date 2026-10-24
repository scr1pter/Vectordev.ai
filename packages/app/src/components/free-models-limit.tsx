import { useProviders } from "@/hooks/use-providers"
import { useParams } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import { Card } from "@vectordevai/ui/card"
import { Button } from "@vectordevai/ui/button"
import { useDialog } from "@vectordevai/ui/context/dialog"
import {
  freeModelsLimitTitle,
  freeModelsResetLabel,
  freeModelsTokensRanOut,
  type FreeModelsLimitNotice,
} from "@vectordevai/core/free-model-choice"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

/**
 * Shown when a free-model limit stops a turn: when to try again or when more free tokens are available, and the
 * user's own provider keys in general. It never asks the user to connect an OpenRouter account (owner decision, 17 October 2026); one already
 * connected can still continue the same turn.
 */
export function FreeModelsLimit(props: {
  sessionID: string
  limit: FreeModelsLimitNotice & { messageID: string; modelID: string }
}) {
  const params = useParams()
  const sdk = useSDK()
  const local = useLocal()
  const providers = useProviders(() => sdk().directory)
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ busy: false, error: "", resumed: false })
  const resume = async () => {
    if (state.busy || state.resumed) return
    setState({ busy: true, error: "" })
    const sessionID = props.sessionID
    const modelID = props.limit.modelID
    const result = await sdk()
      .client.session.resumeFreeModels({ sessionID, messageID: props.limit.messageID, modelID })
      .then((result) => {
        if (result.error) throw result.error
        return true
      })
      .catch((error: unknown) => {
        setState("error", formatServerError(error))
        return false
      })
    if (result) {
      if (params.id === sessionID) local.model.set({ providerID: "openrouter", modelID }, { recent: true })
      setState("resumed", true)
    }
    setState("busy", false)
  }
  const ownKey = async () => {
    const directory = sdk().directory
    const { DialogSelectProvider } = await import("./dialog-select-provider")
    dialog.show(() => <DialogSelectProvider directory={() => directory} />)
  }
  return (
    <Card class="error-card" data-free-models-limit="">
      <div class="flex flex-col gap-3">
        <strong>{freeModelsLimitTitle(props.limit)}</strong>
        <p>
          {language.t(freeModelsTokensRanOut(props.limit) ? "freeModels.limit.reset" : "freeModels.limit.retry", {
            time: freeModelsResetLabel(props.limit, language.intl()),
          })}
        </p>
        <p>{language.t("freeModels.limit.ownKeys")}</p>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
        <Show when={!state.resumed} fallback={<p>{language.t("freeModels.limit.resumed")}</p>}>
          <div class="flex flex-wrap gap-2">
            <Button disabled={state.busy} onClick={() => void ownKey()}>
              {language.t("freeModels.limit.addKey")}
            </Button>
            <Show when={providers.connected().some((provider) => provider.id === "openrouter")}>
              <Button variant="ghost" disabled={state.busy} onClick={() => void resume()}>
                {language.t("freeModels.limit.resume")}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
    </Card>
  )
}
