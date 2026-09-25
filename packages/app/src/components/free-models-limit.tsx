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
  OPENROUTER_ACCOUNT_COPY,
  type FreeModelsLimitNotice,
} from "@vectordevai/core/free-model-choice"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { DialogConnectProvider } from "./dialog-connect-provider"

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
  const target = () => ({
    client: sdk().client,
    directory: sdk().directory,
    sessionID: props.sessionID,
    messageID: props.limit.messageID,
    modelID: props.limit.modelID,
  })
  const resume = async (input = target()) => {
    if (state.busy || state.resumed) return
    setState({ busy: true, error: "" })
    const sessionID = input.sessionID
    const modelID = input.modelID
    const result = await input.client.session
      .resumeFreeModels({ sessionID, messageID: input.messageID, modelID })
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
  return (
    <Card class="error-card" data-free-models-limit="">
      <div class="flex flex-col gap-3">
        <strong>{freeModelsLimitTitle(props.limit)}</strong>
        <p>{language.t("freeModels.limit.reset", { time: freeModelsResetLabel(props.limit, language.intl()) })}</p>
        <p>{OPENROUTER_ACCOUNT_COPY}</p>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
        <Show when={!state.resumed} fallback={<p>{language.t("freeModels.limit.resumed")}</p>}>
          <div class="flex flex-wrap gap-2">
            <Button
              disabled={state.busy}
              onClick={() => {
                const input = target()
                dialog.show(() => (
                  <DialogConnectProvider
                    provider="openrouter"
                    preferredMethod="oauth"
                    directory={() => input.directory}
                    onConnected={() => resume(input)}
                  />
                ))
              }}
            >
              {language.t("freeModels.connect")}
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
