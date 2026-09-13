import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { ServerFormActions, ServerFormFields, ServerGlyph, useServerFormCopy } from "@/components/server/server-form"
import { useLanguage } from "@/context/language"
import { type ServerConnection } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"

export const DialogServerV2: Component<{
  mode: "add" | "edit"
  server?: ServerConnection.Http
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const copy = useServerFormCopy()
  // Escape can close this dialog while a save is still checking the server. When that save lands, the top of the
  // dialog stack is Settings, and closing "the top dialog" would close Settings as well.
  let disposed = false
  const controller = useServerManagementController({
    onSelect: () => {
      if (!disposed) dialog.close()
    },
    navigateOnAdd: false,
  })
  const [opened, setOpened] = createSignal(false)

  onMount(() => {
    if (props.mode === "add") controller.startAdd()
    if (props.mode === "edit" && props.server) controller.startEdit(props.server)
    setOpened(true)
  })

  onCleanup(() => {
    disposed = true
    controller.resetForm()
  })

  createEffect(() => {
    if (!opened()) return
    if (controller.isFormMode()) return
    dialog.close()
  })

  const title = () =>
    props.mode === "add" ? language.t("dialog.server.add.title") : language.t("dialog.server.edit.title")

  const description = () => {
    const text = copy()
    if (!text) return undefined
    return props.mode === "add" ? text.addDescription : text.editDescription
  }

  return (
    <Dialog fit class="settings-v2-server-dialog vx-server-dialog">
      <DialogHeader hideClose={true}>
        <div class="vx-server-dialog__head">
          <span class="vx-server-dialog__glyph" aria-hidden="true">
            <ServerGlyph />
          </span>
          <DialogTitleGroup title={title()} description={description()} />
        </div>
      </DialogHeader>
      {/* Mounted once the controller holds this dialog's values, so the form opens on them. */}
      <Show when={opened()}>
        <DialogBody>
          <ServerFormFields controller={controller} autofocus />
        </DialogBody>
        <DialogFooter>
          <ServerFormActions controller={controller} onCancel={() => dialog.close()} />
        </DialogFooter>
      </Show>
    </Dialog>
  )
}
