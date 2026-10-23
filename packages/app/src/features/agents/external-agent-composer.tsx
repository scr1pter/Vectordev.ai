import { createEffect, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelSelectorPopoverV2, type ModelSelectorModelState } from "@/components/dialog-select-model"
import "./external-agent-chat.css"

export function ExternalAgentComposer(props: {
  runtimeLabel: string
  /** The runtime's own CLI models, in Vector's picker. */
  model: ModelSelectorModelState
  modelLabel: string
  value: string
  running: boolean
  sending: boolean
  resumable: boolean
  hasConversation: boolean
  onInput: (value: string) => void
  onSend: () => void
  onStop: () => void
}) {
  const [state, setState] = createStore({ field: undefined as HTMLTextAreaElement | undefined })
  const canSend = () => Boolean(props.value.trim()) && !props.running && !props.sending
  createEffect(() => {
    props.value
    const field = state.field
    if (!field) return
    field.style.height = "auto"
    field.style.height = `${Math.min(200, Math.max(64, field.scrollHeight))}px`
  })

  return (
    <form
      data-agent-chat-composer
      class="vector-agent-composer-wrap"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSend()) props.onSend()
      }}
    >
      <div class="vector-agent-composer">
        <textarea
          ref={(field) => setState("field", field)}
          aria-label={`Follow up with ${props.runtimeLabel}`}
          placeholder="Ask a follow-up, or describe what to change…"
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
            event.preventDefault()
            if (canSend()) props.onSend()
          }}
        />
        <div class="vector-agent-composer-toolbar">
          <span class="vector-agent-runtime-label">
            <span />
            {props.runtimeLabel}
          </span>
          {/* Stays usable while a turn runs: that turn keeps its model, and the choice applies from the next one. */}
          <ModelSelectorPopoverV2
            model={props.model}
            fixedCatalog
            triggerAs="button"
            triggerProps={{
              type: "button",
              class: "vector-agent-model-chip",
              "data-action": "external-agent-model",
              "aria-label": `${props.runtimeLabel} model: ${props.modelLabel}`,
              title: props.running
                ? `Choose the ${props.runtimeLabel} model for your next message`
                : `Choose the ${props.runtimeLabel} model`,
            }}
          >
            <span class="vector-agent-model-chip-name">{props.modelLabel}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
            </svg>
          </ModelSelectorPopoverV2>
          <span class="vector-agent-composer-hint">
            {props.running ? "Working · draft your next message" : "Shift ↵ for a new line"}
          </span>
          <Show
            when={props.running}
            fallback={
              <button
                type="submit"
                class="vector-agent-send"
                disabled={!canSend()}
                aria-label={`Send follow-up to ${props.runtimeLabel}`}
                title={props.sending ? "Sending…" : "Send message"}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 15V5m-4 4 4-4 4 4" />
                </svg>
              </button>
            }
          >
            <button
              type="button"
              class="vector-agent-send vector-agent-stop"
              onClick={props.onStop}
              aria-label={`Stop ${props.runtimeLabel}`}
              title={`Stop ${props.runtimeLabel}`}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="6" y="6" width="8" height="8" rx="1.5" />
              </svg>
            </button>
          </Show>
        </div>
      </div>
      <Show when={props.hasConversation && !props.resumable && !props.running}>
        <p class="vector-agent-composer-warning">
          The next message will use a saved summary because the previous conversation couldn’t be restored.
        </p>
      </Show>
    </form>
  )
}
