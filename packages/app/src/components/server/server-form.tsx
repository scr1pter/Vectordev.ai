import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { FieldV2 } from "@opencode-ai/ui/v2/field-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createEffect, createMemo, createSignal, createUniqueId, For, on, onMount, Show, untrack } from "solid-js"
import type { useServerManagementController } from "@/components/dialog-select-server"
import { useLanguage } from "@/context/language"
import {
  announcesServerStatus,
  authenticationStartsOpen,
  authenticationSummary,
  CLI_SERVER_USERNAME,
  DEFAULT_SERVER_USERNAME,
  serverFormCopy,
  serverFormStatus,
  serverFormSubmitState,
  type ServerFormSubmitState,
  serverNamePlaceholder,
  splitOptionalLabel,
  templateParts,
} from "./server-form-model"
import "./server-form.css"

export type ServerFormController = Pick<
  ReturnType<typeof useServerManagementController>,
  | "isAddMode"
  | "formBusy"
  | "formValue"
  | "formName"
  | "formUsername"
  | "formPassword"
  | "formError"
  | "formStatus"
  | "formChecking"
  | "submitForm"
  | "handleFormChange"
  | "handleFormNameChange"
  | "handleFormUsernameChange"
  | "handleFormPasswordChange"
>

/** Enter in any field and the primary button both land here, so an empty address never submits. Returns the submit
 *  state, so a refused Enter can say why. */
export function submitServerForm(controller: ServerFormController): ServerFormSubmitState {
  const state = serverFormSubmitState({ value: controller.formValue(), busy: controller.formBusy() })
  if (!state.disabled) controller.submitForm()
  return state
}

/** The redesign's copy for the current locale (see SERVER_FORM_COPY); undefined where it is not translated yet. */
export function useServerFormCopy() {
  const language = useLanguage()
  return () => serverFormCopy(language.locale())
}

const HINT_TOKENS: Record<string, string> = { desktop: DEFAULT_SERVER_USERNAME, cli: CLI_SERVER_USERNAME }

/** Connection fields (address with its live status, name) and the Authentication group, driven by the shared
 *  server management controller. Hosts supply the chrome: the Add/Edit server dialog and the legacy picker. */
export function ServerFormFields(props: {
  controller: ServerFormController
  autofocus?: boolean
  /** Runs first for every key in the fields; call preventDefault to skip the form's own Enter-to-submit. */
  onKeyDown?: (event: KeyboardEvent) => void
}) {
  const language = useLanguage()
  const copy = useServerFormCopy()
  const controller = props.controller
  // Decided once from the values the form opened with, so the group never folds up under the user's cursor.
  const [authOpen, setAuthOpen] = createSignal(
    untrack(() =>
      authenticationStartsOpen({
        mode: controller.isAddMode() ? "add" : "edit",
        username: controller.formUsername(),
        password: controller.formPassword(),
      }),
    ),
  )
  const [revealed, setRevealed] = createSignal(false)
  // Set when Enter is refused for an empty address; any typing in the address clears it.
  const [required, setRequired] = createSignal(false)
  const authId = `server-form-auth-${createUniqueId()}`
  let addressRef: HTMLInputElement | undefined

  createEffect(on(() => controller.formValue(), () => setRequired(false), { defer: true }))

  const status = createMemo(() =>
    serverFormStatus({
      value: controller.formValue(),
      error: controller.formError(),
      checking: controller.formChecking(),
      status: controller.formStatus(),
      required: required(),
    }),
  )
  const statusText = () => {
    switch (status()) {
      case "checking":
        return language.t("dialog.server.add.checking")
      case "reachable":
        return copy()?.reachable ?? language.t("mcp.status.connected")
      case "unreachable":
        return language.t("dialog.server.add.error")
      case "error":
        return controller.formError()
      case "required":
        return copy()?.required ?? language.t("provider.custom.error.required")
      default:
        return copy()?.addressHelper ?? ""
    }
  }

  // The visible line changes on nearly every pause in typing, so screen readers hear only settled results. The last
  // one stays in place while a newer check runs, so a result that has not changed is not read out again.
  const [announcement, setAnnouncement] = createSignal("")
  createEffect(
    on(
      () => [status(), statusText()] as const,
      ([next, text]) => {
        if (next === "checking") return
        setAnnouncement(announcesServerStatus(next) ? text : "")
      },
      { defer: true },
    ),
  )

  const nameLabel = () => splitOptionalLabel(language.t("dialog.server.add.name"))
  const usernameLabel = () => splitOptionalLabel(language.t("dialog.server.add.username"))
  const passwordLabel = () => splitOptionalLabel(language.t("dialog.server.add.password"))
  // The group is marked optional once, with the locale's own word for it.
  const authHint = () => usernameLabel().hint
  // Until "Authentication" is translated, other locales title the group with the field names they already have.
  const authTitle = () => copy()?.auth ?? `${usernameLabel().text} · ${passwordLabel().text}`
  const summary = createMemo(() =>
    authenticationSummary({ username: controller.formUsername(), password: controller.formPassword() }),
  )

  const keyDown = (event: KeyboardEvent) => {
    props.onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    const result = submitServerForm(controller)
    if (!result.disabled || result.reason !== "empty") return
    setRequired(true)
    addressRef?.focus()
  }

  // The fields are disabled while a save checks the server, which drops focus; when that save fails, put the caret
  // back in the address so it can be corrected straight away. The error lands while the save is still pending and
  // the input still disabled, so wait for both: an error, and the fields enabled again.
  const failedSave = () => status() === "error" && !controller.formBusy()
  createEffect(
    on(
      failedSave,
      (failed, wasFailed) => {
        if (!failed || wasFailed) return
        const input = addressRef
        if (!input?.isConnected || input.disabled) return
        if (input.closest(".vx-server-form")?.contains(document.activeElement)) return
        input.focus()
      },
      { defer: true },
    ),
  )

  onMount(() => {
    if (!props.autofocus) return
    // `autofocus` only counts for inputs present at page load; dialogs also honour it, the legacy picker does not.
    requestAnimationFrame(() => {
      const input = addressRef
      if (!input?.isConnected) return
      if (input.closest(".vx-server-form")?.contains(document.activeElement)) return
      input.focus()
    })
  })

  return (
    <div class="vx-server-form">
      <div class="vx-server-form__group">
        <FieldV2 invalid={status() === "error"}>
          <FieldV2.Label>{language.t("dialog.server.add.url")}</FieldV2.Label>
          <TextInputV2
            ref={(el: HTMLInputElement) => (addressRef = el)}
            type="text"
            inputmode="url"
            appearance="large"
            value={controller.formValue()}
            placeholder={language.t("dialog.server.add.placeholder")}
            invalid={status() === "error"}
            disabled={controller.formBusy()}
            autofocus={props.autofocus}
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            onInput={(event) => controller.handleFormChange()(event.currentTarget.value)}
            onKeyDown={keyDown}
          />
          {/* Describes the address (FieldV2 wires aria-describedby); announcements go through the region below. */}
          <FieldV2.Suffix class="vx-server-form__status" data-server-status={status()}>
            <span class="vx-server-form__status-mark" aria-hidden="true">
              <Show when={status() === "checking"} fallback={<span class="vx-server-form__dot" />}>
                <LoaderV2 width={12} height={12} />
              </Show>
            </span>
            <span class="vx-server-form__status-text">{statusText()}</span>
          </FieldV2.Suffix>
        </FieldV2>

        <FieldV2>
          <FieldV2.Label>
            {nameLabel().text}
            <Show when={nameLabel().hint}>
              <span class="vx-server-form__optional">{nameLabel().hint}</span>
            </Show>
          </FieldV2.Label>
          <TextInputV2
            type="text"
            appearance="large"
            value={controller.formName()}
            placeholder={serverNamePlaceholder(
              controller.formValue(),
              language.t("dialog.server.add.namePlaceholder"),
            )}
            disabled={controller.formBusy()}
            autocomplete="off"
            spellcheck={false}
            onInput={(event) => controller.handleFormNameChange()(event.currentTarget.value)}
            onKeyDown={keyDown}
          />
        </FieldV2>
      </div>

      <div class="vx-server-form__auth" data-open={authOpen() ? "" : undefined}>
        <button
          type="button"
          data-slot="server-form-auth-toggle"
          class="vx-server-form__disclosure"
          aria-expanded={authOpen()}
          aria-controls={authOpen() ? authId : undefined}
          onClick={() => setAuthOpen((open) => !open)}
        >
          <ChevronGlyph />
          <span class="vx-server-form__disclosure-title">{authTitle()}</span>
          <Show when={authHint()}>
            <span class="vx-server-form__optional">{authHint()}</span>
          </Show>
          <Show when={!authOpen() && copy()}>
            {(text) => (
              <span class="vx-server-form__summary">
                <Show when={summary().username}>
                  {(username) => (
                    <>
                      <span class="vx-server-form__summary-user">{username()}</span>
                      <span class="vx-server-form__summary-sep" aria-hidden="true">
                        ·
                      </span>
                    </>
                  )}
                </Show>
                <span class="vx-server-form__summary-state">
                  {summary().password ? text().authPasswordSet : text().authNone}
                </span>
              </span>
            )}
          </Show>
        </button>
        <Show when={authOpen()}>
          <div id={authId} class="vx-server-form__auth-body">
            <div class="vx-server-form__grid">
              <FieldV2>
                <FieldV2.Label>{usernameLabel().text}</FieldV2.Label>
                <TextInputV2
                  type="text"
                  appearance="large"
                  value={controller.formUsername()}
                  placeholder={language.t("dialog.server.add.usernamePlaceholder")}
                  disabled={controller.formBusy()}
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                  onInput={(event) => controller.handleFormUsernameChange()(event.currentTarget.value)}
                  onKeyDown={keyDown}
                />
              </FieldV2>
              <FieldV2>
                <FieldV2.Label>{passwordLabel().text}</FieldV2.Label>
                <div class="vx-server-form__secret">
                  <TextInputV2
                    type={revealed() ? "text" : "password"}
                    appearance="large"
                    value={controller.formPassword()}
                    placeholder={language.t("dialog.server.add.passwordPlaceholder")}
                    disabled={controller.formBusy()}
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck={false}
                    onInput={(event) => controller.handleFormPasswordChange()(event.currentTarget.value)}
                    onKeyDown={keyDown}
                  />
                  {/* A toggle: the name stays put and aria-pressed carries the state. */}
                  <button
                    type="button"
                    data-slot="server-form-reveal"
                    class="vx-server-form__reveal"
                    aria-label={copy()?.showPassword ?? passwordLabel().text}
                    aria-pressed={revealed()}
                    disabled={controller.formBusy()}
                    onClick={() => setRevealed((value) => !value)}
                  >
                    <EyeGlyph crossed={revealed()} />
                  </button>
                </div>
              </FieldV2>
            </div>
            <Show when={copy()}>{(text) => <CredentialsHint template={text().authHint} />}</Show>
          </div>
        </Show>
      </div>

      <span class="vx-server-form__sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement()}
      </span>
    </div>
  )
}

/** Cancel plus the primary action. The primary stays disabled until there is an address (the address line says why
 *  once Enter is tried) and shows the save's check while it runs; it is the only place that progress shows. */
export function ServerFormActions(props: { controller: ServerFormController; onCancel: () => void }) {
  const language = useLanguage()
  const copy = useServerFormCopy()
  const controller = props.controller
  const reasonId = `server-form-reason-${createUniqueId()}`
  const submit = createMemo(() =>
    serverFormSubmitState({ value: controller.formValue(), busy: controller.formBusy() }),
  )
  const needsAddress = () => {
    const state = submit()
    return state.disabled && state.reason === "empty"
  }
  const label = () => {
    if (controller.formBusy()) return language.t("dialog.server.add.checking")
    if (controller.isAddMode()) return language.t("dialog.server.add.button")
    return language.t("common.save")
  }

  return (
    <div class="vx-server-form-actions">
      {/* Names the reason for assistive tech only; on screen the empty field and disabled button already say it. */}
      <span id={reasonId} class="vx-server-form__sr-only">
        <Show when={needsAddress()}>{copy()?.required ?? language.t("provider.custom.error.required")}</Show>
      </span>
      <ButtonV2
        variant="ghost"
        class="vx-server-form-actions__cancel"
        disabled={controller.formBusy()}
        onClick={props.onCancel}
      >
        {language.t("common.cancel")}
      </ButtonV2>
      <ButtonV2
        variant="contrast"
        class="vx-server-form-actions__submit"
        disabled={submit().disabled}
        data-busy={controller.formBusy() ? "" : undefined}
        aria-busy={controller.formBusy() ? "true" : undefined}
        aria-describedby={needsAddress() ? reasonId : undefined}
        onClick={() => submitServerForm(controller)}
      >
        <Show when={controller.formBusy()}>
          <LoaderV2 width={14} height={14} />
        </Show>
        {label()}
      </ButtonV2>
    </div>
  )
}

/** The credentials hint, with the default usernames set as code where the sentence places them. */
function CredentialsHint(props: { template: string }) {
  return (
    <p class="vx-server-form__hint">
      <For each={templateParts(props.template)}>
        {(part) =>
          "token" in part ? <code class="vx-server-form__code">{HINT_TOKENS[part.token] ?? part.token}</code> : part.text
        }
      </For>
    </p>
  )
}

/** Two stacked server units: the header tile of the Add/Edit server dialog. */
export function ServerGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.4" stroke="currentColor" stroke-width="1.1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1.4" stroke="currentColor" stroke-width="1.1" />
      <circle cx="5.1" cy="4.75" r="0.8" fill="currentColor" />
      <circle cx="5.1" cy="11.25" r="0.8" fill="currentColor" />
      <path d="M8 4.75H11M8 11.25H11" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
    </svg>
  )
}

function ChevronGlyph() {
  return (
    <svg
      class="vx-server-form__chevron"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

function EyeGlyph(props: { crossed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M1.75 8C3.1 5.3 5.35 3.75 8 3.75C10.65 3.75 12.9 5.3 14.25 8C12.9 10.7 10.65 12.25 8 12.25C5.35 12.25 3.1 10.7 1.75 8Z"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.1" />
      <Show when={props.crossed}>
        <path d="M2.75 13.25L13.25 2.75" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
      </Show>
    </svg>
  )
}
