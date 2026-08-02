import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { Icon } from "@opencode-ai/ui/icon"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { type LocalProject, getAvatarColors } from "@/context/layout"
import { getFilename } from "@opencode-ai/core/util/path"
import { Avatar } from "@opencode-ai/ui/avatar"
import { useLanguage } from "@/context/language"
import { getProjectAvatarSource } from "@/pages/layout/helpers"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { showToast } from "@/utils/toast"

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const MAX_ICON_UPLOAD_BYTES = 8 * 1024 * 1024
const MAX_ICON_DIMENSION = 256

export function DialogEditProject(props: { project: LocalProject; server: ServerConnection.Any }) {
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const serverCtx = createMemo(() => global.ensureServerCtx(props.server))
  const serverSDK = () => serverCtx().sdk
  const serverSync = () => serverCtx().sync

  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())

  const [store, setStore] = createStore({
    name: defaultName(),
    color: props.project.icon?.color,
    iconOverride: props.project.icon?.override,
    startup: props.project.commands?.start ?? "",
    dragOver: false,
    iconHover: false,
  })

  let iconInput: HTMLInputElement | undefined

  function handleFileSelect(file: File) {
    if (!file.type.startsWith("image/")) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("dialog.project.edit.icon.error.type"),
      })
      return
    }
    if (file.size > MAX_ICON_UPLOAD_BYTES) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("dialog.project.edit.icon.error.size"),
      })
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      const raw = e.target?.result
      if (typeof raw !== "string") return
      const img = new Image()
      img.onload = () => {
        // Downscale on a canvas so a multi-megabyte photo doesn't get stored
        // as a giant data URL and mirrored into the sync store on every load.
        const scale = Math.min(1, MAX_ICON_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight))
        const width = Math.max(1, Math.round(img.naturalWidth * scale))
        const height = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d")
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height)
          setStore("iconOverride", canvas.toDataURL("image/png"))
        } else {
          setStore("iconOverride", raw)
        }
        setStore("iconHover", false)
      }
      img.onerror = () => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: language.t("dialog.project.edit.icon.error.type"),
        })
      }
      img.src = raw
    }
    reader.readAsDataURL(file)
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    setStore("dragOver", false)
    const file = e.dataTransfer?.files[0]
    if (file) handleFileSelect(file)
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault()
    setStore("dragOver", true)
  }

  function handleDragLeave() {
    setStore("dragOver", false)
  }

  function handleInputChange(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) handleFileSelect(file)
  }

  function clearIcon() {
    setStore("iconOverride", "")
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async () => {
      const name = store.name.trim() === folderName() ? "" : store.name.trim()
      const start = store.startup.trim()
      const metadata = {
        name,
        icon: { color: store.color || undefined, override: store.iconOverride || undefined },
        commands: { start: start || undefined },
      }

      if (props.project.id && props.project.id !== "global") {
        await serverSDK().client.project.update({
          projectID: props.project.id,
          directory: props.project.worktree,
          name,
          icon: { color: store.color || "", override: store.iconOverride || "" },
          commands: { start },
        })
        // Keep the local project list in sync while the server event catches up.
        // The sidebar and home screen are derived from this per-workspace metadata.
        serverSync().project.meta(props.project.worktree, metadata)
        serverSync().project.icon(props.project.worktree, store.iconOverride || undefined)
        dialog.close()
        return
      }

      serverSync().project.meta(props.project.worktree, metadata)
      dialog.close()
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (saveMutation.isPending) return
    saveMutation.mutate()
  }

  return (
    <Dialog title={language.t("dialog.project.edit.title")} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={handleSubmit} class="flex flex-col gap-6 p-6 pt-0">
        <div class="flex flex-col gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("dialog.project.edit.name")}
            placeholder={folderName()}
            value={store.name}
            onChange={(v) => setStore("name", v)}
          />

          <div class="flex flex-col gap-2">
            <label class="text-12-medium text-text-weak">{language.t("dialog.project.edit.icon")}</label>
            <div class="flex gap-3 items-start">
              <div
                class="relative"
                onMouseEnter={() => setStore("iconHover", true)}
                onMouseLeave={() => setStore("iconHover", false)}
              >
                <button
                  type="button"
                  aria-label={language.t("dialog.project.edit.icon.upload")}
                  class="relative size-16 rounded-md border border-dashed transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(147,116,236,0.55)]"
                  classList={{
                    "border-[rgba(147,116,236,0.55)] bg-[rgba(147,116,236,0.1)]": store.dragOver,
                    "border-[rgba(178,140,255,0.16)] hover:border-[rgba(178,140,255,0.35)]": !store.dragOver,
                    "overflow-hidden": !!store.iconOverride,
                  }}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onClick={() => {
                    if (store.iconOverride && store.iconHover) {
                      clearIcon()
                    } else {
                      iconInput?.click()
                    }
                  }}
                >
                  <Show
                    when={getProjectAvatarSource(props.project.id, {
                      color: store.color,
                      url: props.project.icon?.url,
                      override: store.iconOverride,
                    })}
                    fallback={
                      <div class="size-full flex items-center justify-center">
                        <Avatar
                          fallback={store.name || defaultName()}
                          {...getAvatarColors(store.color)}
                          class="size-full text-[32px]"
                        />
                      </div>
                    }
                  >
                    {(src) => (
                      <img
                        src={src()}
                        alt={language.t("dialog.project.edit.icon.alt")}
                        class="size-full object-cover"
                      />
                    )}
                  </Show>
                </button>
                <div
                  class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-[6px] z-10 pointer-events-none flex items-center justify-center transition-opacity"
                  classList={{
                    "opacity-100": store.iconHover && !store.iconOverride,
                    "opacity-0": !(store.iconHover && !store.iconOverride),
                  }}
                >
                  <Icon name="cloud-upload" size="large" class="text-icon-on-interactive-base drop-shadow-sm" />
                </div>
                <div
                  class="absolute inset-0 size-16 bg-surface-raised-stronger-non-alpha/90 rounded-[6px] z-10 pointer-events-none flex items-center justify-center transition-opacity"
                  classList={{
                    "opacity-100": store.iconHover && !!store.iconOverride,
                    "opacity-0": !(store.iconHover && !!store.iconOverride),
                  }}
                >
                  <Icon name="trash" size="large" class="text-icon-on-interactive-base drop-shadow-sm" />
                </div>
              </div>
              <input
                id="icon-upload"
                ref={(el) => {
                  iconInput = el
                }}
                type="file"
                accept="image/*"
                class="hidden"
                onChange={handleInputChange}
              />
              <div class="flex flex-col gap-1.5 text-12-regular text-text-weak self-center">
                <span>{language.t("dialog.project.edit.icon.hint")}</span>
                <span>{language.t("dialog.project.edit.icon.recommended")}</span>
                <Show when={store.iconOverride}>
                  <button
                    type="button"
                    class="w-fit text-left text-12-medium text-[rgba(201,176,255,0.9)] transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:text-text-base"
                    onClick={clearIcon}
                  >
                    {language.t("dialog.project.edit.icon.remove")}
                  </button>
                </Show>
              </div>
            </div>
          </div>

          <Show when={!store.iconOverride}>
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{language.t("dialog.project.edit.color")}</label>
              <div class="flex gap-1.5">
                <For each={AVATAR_COLOR_KEYS}>
                  {(color) => (
                    <button
                      type="button"
                      aria-label={language.t("dialog.project.edit.color.select", { color })}
                      aria-pressed={store.color === color}
                      classList={{
                        "flex items-center justify-center size-10 p-0.5 rounded-lg overflow-hidden transition-[box-shadow,border-color] duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] cursor-pointer":
                          true,
                        "bg-transparent border border-[rgba(147,116,236,0.55)] shadow-[0_0_0_2px_rgba(147,116,236,0.5)]":
                          store.color === color,
                        "bg-transparent border border-transparent hover:border-[rgba(178,140,255,0.35)]":
                          store.color !== color,
                      }}
                      onClick={() => {
                        if (store.color === color && !props.project.icon?.url) return
                        setStore("color", store.color === color ? undefined : color)
                      }}
                    >
                      <Avatar
                        fallback={store.name || defaultName()}
                        {...getAvatarColors(color)}
                        class="size-full rounded"
                      />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <TextField
            multiline
            label={language.t("dialog.project.edit.worktree.startup")}
            description={language.t("dialog.project.edit.worktree.startup.description")}
            placeholder={language.t("dialog.project.edit.worktree.startup.placeholder")}
            value={store.startup}
            onChange={(v) => setStore("startup", v)}
            spellcheck={false}
            class="min-h-[96px] max-h-[200px] w-full overflow-y-auto font-mono text-[13px]"
          />
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
