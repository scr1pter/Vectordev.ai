import { createEffect, on, Show } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ProviderIcon } from "@vectordevai/ui/provider-icon"
import type { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { bestOwnFreeModel } from "@/utils/free-model"
import { modelDisplayName } from "@/utils/provider-brand"

/**
 * The composer's first-run state while no connected provider offers a model: one free path through
 * the user's own OpenRouter account, and one for a key they already have. The draft stays in the
 * editor throughout, and `nudge` moves focus here when a send is attempted.
 */
export function FreeModelStart(props: {
  directory: string
  model: ReturnType<typeof useLocal>["model"]
  nudge: number
  onReady: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const providers = useProviders(() => props.directory)
  const free = () => providers.all().has("openrouter")
  let action: HTMLButtonElement | undefined

  createEffect(
    on(
      () => props.nudge,
      () => action?.focus(),
      { defer: true },
    ),
  )

  const startFree = async () => {
    // This card unmounts as soon as a model exists, so the callback keeps what it needs.
    const directory = props.directory
    const model = props.model
    const ready = props.onReady
    const { DialogConnectProvider } = await import("../dialog-connect-provider")
    dialog.show(() => (
      <DialogConnectProvider
        provider="openrouter"
        preferredMethod="oauth"
        directory={() => directory}
        onConnected={() => {
          const best = bestOwnFreeModel(model.list())
          if (!best) return language.t("freeModels.start.unavailable")
          model.set({ providerID: "openrouter", modelID: best.id }, { recent: true })
          ready()
          return language.t("freeModels.start.ready", { model: modelDisplayName(best) })
        }}
      />
    ))
  }

  const ownKey = async () => {
    const directory = props.directory
    const { DialogSelectProvider } = await import("../dialog-select-provider")
    dialog.show(() => <DialogSelectProvider directory={() => directory} />)
  }

  return (
    <section
      data-component="free-model-start"
      data-nudge={props.nudge === 0 ? undefined : props.nudge % 2 ? "odd" : "even"}
      aria-label={language.t("freeModels.start.label")}
      class="vector-model-start"
    >
      <div class="vector-model-start__copy">
        <h2>{language.t("freeModels.start.title")}</h2>
        <p>{free() ? language.t("freeModels.start.description") : language.t("freeModels.start.fallback")}</p>
      </div>
      <div class="vector-model-start__actions">
        <Show
          when={free()}
          fallback={
            <button type="button" data-variant="primary" ref={(el) => (action = el)} onClick={ownKey}>
              {language.t("freeModels.start.ownKey")}
            </button>
          }
        >
          <button
            type="button"
            data-variant="primary"
            data-action="free-model-start"
            ref={(el) => (action = el)}
            onClick={startFree}
          >
            <ProviderIcon id="openrouter" class="size-4 shrink-0" />
            {language.t("freeModels.start.free")}
          </button>
          <button type="button" data-variant="secondary" data-action="own-api-key" onClick={ownKey}>
            {language.t("freeModels.start.ownKey")}
          </button>
        </Show>
      </div>
      <Show when={free()}>
        <p class="vector-model-start__note">{language.t("freeModels.start.note")}</p>
      </Show>
    </section>
  )
}
