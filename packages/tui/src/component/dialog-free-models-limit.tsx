import { createMemo, createSignal } from "solid-js"
import {
  FREE_MODELS_OWN_KEYS_TERMINAL,
  freeModelsLimitNotice,
  freeModelsLimitTitle,
  freeModelsResetSentence,
  type FreeModelsLimitNotice,
} from "@vectordevai/core/free-model-choice"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { DialogProvider } from "./dialog-provider"

/**
 * Shown when the shared allowance stops a turn: when it is expected to reset, and the user's own provider keys in
 * general. It never asks the user to connect an OpenRouter account (owner decision, 17 October 2026); one already
 * connected can still continue the same turn.
 */
export function DialogFreeModelsLimit(props: { sessionID: string; limit: FreeModelsLimitNotice }) {
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)
  const failed = createMemo(() =>
    (sync.data.message[props.sessionID] ?? []).findLast(
      (message) => message.role === "assistant" && freeModelsLimitNotice(message.error),
    ),
  )
  const openRouter = createMemo(() => sync.data.provider.some((provider) => provider.id === "openrouter"))
  const resume = async () => {
    const message = failed()
    if (busy() || !message || message.role !== "assistant") return
    setBusy(true)
    const result = await sdk.client.session
      .resumeFreeModels({ sessionID: props.sessionID, messageID: message.id, modelID: message.modelID })
      .catch((error: unknown) => ({ error }))
    setBusy(false)
    if (result.error) {
      toast.show({
        variant: "error",
        message: "Could not continue this turn on your OpenRouter account. Check that this is the latest paused turn.",
      })
      return
    }
    local.model.set({ providerID: "openrouter", modelID: message.modelID }, { recent: true })
    route.navigate({ type: "session", sessionID: props.sessionID })
    dialog.clear()
  }
  return (
    <DialogSelect
      title={freeModelsLimitTitle(props.limit)}
      renderFilter={false}
      locked={busy()}
      footer={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text fg={theme.textMuted}>{freeModelsResetSentence(props.limit)}</text>
          <text fg={theme.textMuted}>{FREE_MODELS_OWN_KEYS_TERMINAL}</text>
        </box>
      }
      options={[
        {
          title: "Connect a provider with your own key",
          value: "connect",
          onSelect: () => dialog.replace(() => <DialogProvider />),
        },
        ...(openRouter()
          ? [
              {
                title: "Continue with connected OpenRouter",
                value: "resume",
                disabled: !failed(),
                onSelect: () => {
                  void resume()
                },
              },
            ]
          : []),
        {
          title: "Wait until more free tokens are available",
          value: "wait",
          onSelect: () => dialog.clear(),
        },
      ]}
    />
  )
}
