import { For, Match, Show, Switch } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Icon } from "@vectordevai/ui/v2/icon"
import type { ImageAttachmentPart } from "@/context/prompt"
import { PASTE_CHIP, PASTE_HINT, chipHint, chipLabel, documentKind, offer, type Offer } from "./remember"

const chipClass =
  "inline-flex items-center gap-1 h-6 max-w-full px-2 rounded-md border text-12-regular transition-colors"
const offClass = "border-border-base text-text-weak hover:text-text-strong hover:border-border-strong-base"
const onClass = "border-border-strong-base text-text-strong bg-surface-base"

// The composer's memory choices for attached documents: the Remember chip (off until the user turns it on), the
// "Remember instead" suggestion for a document too large to send whole, office files remembered with Undo, and the
// "Remember this text" chip for long pasted prose.
export function PromptRemember(props: {
  attachments: ImageAttachmentPart[]
  onMode: (id: string, mode: ImageAttachmentPart["remember"]) => void
  onRemove: (id: string) => void
  paste?: { name: string; busy: boolean }
  onPasteKeep: () => void
  onPasteDismiss: () => void
}) {
  const documents = () =>
    props.attachments.flatMap((attachment) => {
      const kind = documentKind(attachment)
      return kind
        ? [{ attachment, offer: offer({ ...attachment, bytes: attachment.bytes ?? 0 }, attachment.probe) }]
        : []
    })

  return (
    <Show when={documents().length > 0 || props.paste}>
      <div class="flex flex-col gap-1.5 px-3 pt-2" data-component="prompt-remember">
        <For each={documents()}>
          {(item) => (
            <Switch
              fallback={
                <div class="flex items-center gap-1.5 min-w-0">
                  <button
                    type="button"
                    data-action="prompt-remember"
                    aria-pressed={item.attachment.remember === "keep"}
                    title={chipHint(item.attachment.remember === "keep" ? "keep" : undefined)}
                    class={`${chipClass} ${item.attachment.remember === "keep" ? onClass : offClass}`}
                    onClick={() =>
                      props.onMode(item.attachment.id, item.attachment.remember === "keep" ? undefined : "keep")
                    }
                  >
                    <Icon name={item.attachment.remember === "keep" ? "check" : "plus"} class="size-3.5 shrink-0" />
                    <span class="truncate">
                      {chipLabel(item.attachment.remember === "keep" ? "keep" : undefined)} {item.attachment.filename}
                    </span>
                  </button>
                </div>
              }
            >
              <Match when={item.offer.type === "office" || item.attachment.remember === "instead"}>
                <div class="flex flex-wrap items-center gap-1.5 min-w-0" data-slot="prompt-remember-instead">
                  <span
                    data-action="prompt-remember"
                    aria-pressed="true"
                    title={chipHint("instead")}
                    class={`${chipClass} ${onClass}`}
                  >
                    <Icon name="check" class="size-3.5 shrink-0" />
                    <span class="truncate">
                      {chipLabel("instead")}: {item.attachment.filename}
                    </span>
                  </span>
                  <Show when={item.offer.type === "office" && item.offer.message}>
                    {(message) => <span class="text-12-regular text-text-weak">{message()}</span>}
                  </Show>
                  <ButtonV2
                    size="small"
                    variant="ghost"
                    data-action="prompt-remember-undo"
                    onClick={() =>
                      // An office file cannot be sent as it is, so undoing takes it off the message.
                      item.offer.type === "office"
                        ? props.onRemove(item.attachment.id)
                        : props.onMode(item.attachment.id, undefined)
                    }
                  >
                    Undo
                  </ButtonV2>
                </div>
              </Match>
              <Match when={item.attachment.remember === undefined && suggestion(item.offer)}>
                {(message) => (
                  <div
                    class="flex flex-wrap items-center gap-2 rounded-md border border-border-base bg-surface-base px-2.5 py-1.5"
                    data-slot="prompt-remember-suggest"
                    role="status"
                  >
                    <span class="text-12-regular text-text-strong min-w-0 flex-1 basis-[240px]">{message()}</span>
                    <ButtonV2
                      size="small"
                      variant="outline"
                      data-action="prompt-remember-instead"
                      onClick={() => props.onMode(item.attachment.id, "instead")}
                    >
                      Remember instead
                    </ButtonV2>
                    <ButtonV2
                      size="small"
                      variant="ghost"
                      data-action="prompt-remember-send"
                      onClick={() => props.onMode(item.attachment.id, "send")}
                    >
                      Send anyway
                    </ButtonV2>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </For>
        <Show when={props.paste}>
          {(paste) => (
            <div class="flex items-center gap-1.5 min-w-0" data-slot="prompt-remember-paste">
              <button
                type="button"
                data-action="prompt-remember-paste"
                title={PASTE_HINT}
                disabled={paste().busy}
                class={`${chipClass} ${offClass}`}
                onClick={props.onPasteKeep}
              >
                <Icon name="plus" class="size-3.5 shrink-0" />
                <span class="truncate">
                  {PASTE_CHIP}: {paste().name}
                </span>
              </button>
              <button
                type="button"
                data-action="prompt-remember-paste-dismiss"
                aria-label="Dismiss"
                class="size-5 flex items-center justify-center text-text-weak hover:text-text-strong"
                onClick={props.onPasteDismiss}
              >
                <Icon name="xmark-small" class="size-3.5" />
              </button>
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}

function suggestion(value: Offer) {
  return value.type === "suggest" ? value.message : undefined
}
