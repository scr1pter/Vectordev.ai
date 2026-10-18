import { createEffect, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { VectorAccountStatus } from "@/vector-account"

/**
 * The composer's first-run state while no connected provider offers a model. Free models run on Vector's shared
 * allowance for every signed-in Vector account, so the free path is signing in to Vector, never connecting an
 * OpenRouter account (owner decision, 17 October 2026); the other path is a key the user already has. Once signed in,
 * the shared models load and this card unmounts; it stays only when the shared allowance serves nothing. The draft
 * stays in the editor throughout, and `nudge` moves focus here when a send is attempted.
 */
export function FreeModelStart(props: { directory: string; nudge: number }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const [account, setAccount] = createStore<VectorAccountStatus>({ authenticated: false, pending: false })
  let action: HTMLButtonElement | undefined

  onMount(() => {
    const vectorAccount = platform.vectorAccount
    if (!vectorAccount) return
    onCleanup(vectorAccount.onChange(setAccount))
    void vectorAccount
      .status()
      .then(setAccount)
      .catch(() => {})
  })

  createEffect(
    on(
      () => props.nudge,
      () => action?.focus(),
      { defer: true },
    ),
  )

  // Signing in from here needs the desktop app; elsewhere the engine is signed in with `vector login`.
  const canSignIn = () => !!platform.vectorAccount && !account.authenticated
  const signIn = () => {
    void platform.vectorAccount
      ?.start()
      .then(setAccount)
      .catch(() => setAccount("error", language.t("freeModels.start.signInFailed")))
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
        <p>
          {account.authenticated
            ? language.t("freeModels.start.unavailableShared")
            : language.t("freeModels.start.signIn")}
        </p>
        <Show when={account.pending}>
          <p role="status">{language.t("freeModels.start.signingIn")}</p>
        </Show>
        <Show when={account.error}>
          <p role="alert">{account.error}</p>
        </Show>
      </div>
      <div class="vector-model-start__actions">
        <Show
          when={canSignIn()}
          fallback={
            <button
              type="button"
              data-variant="primary"
              data-action="own-api-key"
              ref={(el) => (action = el)}
              onClick={ownKey}
            >
              {language.t("freeModels.start.ownKey")}
            </button>
          }
        >
          <button
            type="button"
            data-variant="primary"
            data-action="free-model-sign-in"
            disabled={account.pending}
            ref={(el) => (action = el)}
            onClick={signIn}
          >
            {language.t("freeModels.start.signInAction")}
          </button>
          <button type="button" data-variant="secondary" data-action="own-api-key" onClick={ownKey}>
            {language.t("freeModels.start.ownKey")}
          </button>
        </Show>
      </div>
      <Show when={!account.authenticated}>
        <p class="vector-model-start__note">{language.t("freeModels.start.note")}</p>
      </Show>
    </section>
  )
}
