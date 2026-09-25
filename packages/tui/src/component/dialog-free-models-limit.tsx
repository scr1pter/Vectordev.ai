import { createMemo, createSignal } from "solid-js"
import {
  freeModelsLimitNotice,
  freeModelsLimitTitle,
  freeModelsResetLabel,
  OPENROUTER_ACCOUNT_COPY,
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
import { createDialogProviderOptions } from "./dialog-provider"

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
        message: "Could not continue this turn. Check that OpenRouter is connected and this is the latest paused turn.",
      })
      return
    }
    local.model.set({ providerID: "openrouter", modelID: message.modelID }, { recent: true })
    route.navigate({ type: "session", sessionID: props.sessionID })
    dialog.clear()
  }
  const providers = createDialogProviderOptions({ preferredMethod: "oauth", onConnected: resume })
  return (
    <DialogSelect
      title={freeModelsLimitTitle(props.limit)}
      renderFilter={false}
      locked={busy()}
      footer={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text fg={theme.textMuted}>
            Shared allowance is expected to reset at {freeModelsResetLabel(props.limit)}.
          </text>
          <text fg={theme.textMuted}>{OPENROUTER_ACCOUNT_COPY}</text>
        </box>
      }
      options={[
        {
          title: "Connect OpenRouter",
          value: "connect",
          onSelect: () => {
            void providers()
              .find((provider) => provider.value === "openrouter")
              ?.onSelect()
          },
        },
        {
          title: "Continue with connected OpenRouter",
          value: "resume",
          disabled: !failed(),
          onSelect: () => {
            void resume()
          },
        },
        { title: "Wait for the shared allowance to reset", value: "wait", onSelect: () => dialog.clear() },
      ]}
    />
  )
}
