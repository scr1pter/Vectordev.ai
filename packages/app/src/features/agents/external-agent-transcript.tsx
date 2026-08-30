import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { showToast } from "@/utils/toast"
import "./external-agent-chat.css"
import { externalAgentMessages, restartedConversation, type ExternalAgentTurn } from "./external-agent-transcript-model"
export { externalAgentMessages, restartedConversation, type ExternalAgentTurn } from "./external-agent-transcript-model"

export function ExternalAgentTranscript(props: { turns: ExternalAgentTurn[]; runtimeLabel: string }) {
  const [state, setState] = createStore({ copied: "" })

  return (
    <div
      class="vector-agent-transcript"
      data-vector-agent-conversation
      role="log"
      aria-label={`${props.runtimeLabel} conversation`}
    >
      {/* Polling replaces records, not conversations. Key by durable turn IDs so
          streaming updates preserve selection and expanded tool details. */}
      <For each={props.turns.map((turn) => turn.id)}>
        {(id, index) => {
          const turn = createMemo(() => props.turns.find((turn) => turn.id === id)!)
          const messages = createMemo(() => externalAgentMessages(turn()))
          const tools = createMemo(() => turn().activity?.filter((item) => item.kind === "tool") ?? [])
          const working = () => turn().state === "running"
          return (
            <article data-agent-turn={turn().role} data-turn-id={id} class="vector-agent-turn">
              <Show when={turn().role === "agent" && (tools().length || working())}>
                <Show
                  when={tools().length}
                  fallback={
                    <div class="vector-agent-working" role="status">
                      <span />
                      {props.runtimeLabel} is working…
                    </div>
                  }
                >
                  <details data-agent-tool-activity class="vector-agent-tool-activity">
                    <summary>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m6 4 4 4-4 4" />
                      </svg>
                      <span>
                        {tools().length} tool {tools().length === 1 ? "call" : "calls"}
                      </span>
                      <Show when={working()}>
                        <span class="vector-agent-working-dot" />
                      </Show>
                    </summary>
                    <ul>
                      <For each={tools()}>
                        {(tool) => (
                          <li>
                            <span data-state={tool.state} />
                            {tool.label}
                          </li>
                        )}
                      </For>
                    </ul>
                  </details>
                </Show>
              </Show>
              <Show when={restartedConversation(props.turns, index())}>
                <p class="vector-agent-chat-notice">
                  The previous conversation could not be restored. {props.runtimeLabel} continued from the saved
                  summary.
                </p>
              </Show>
              <Show when={turn().role === "agent"} fallback={<p class="vector-agent-user-text">{turn().text}</p>}>
                <For each={messages().map((message) => message.id)}>
                  {(messageID) => (
                    <Markdown
                      class="vector-agent-reply"
                      cacheKey={`${id}:${messageID}`}
                      text={messages().find((message) => message.id === messageID)?.text ?? ""}
                      streaming={working()}
                    />
                  )}
                </For>
                <Show when={turn().state === "failed" || turn().state === "stopped"}>
                  <p class="vector-agent-chat-notice" role="status">
                    {turn().state === "stopped"
                      ? "Stopped. You can send another message when you’re ready."
                      : "This turn couldn’t finish. You can retry with a follow-up."}
                  </p>
                </Show>
                <Show when={!working() && messages().length}>
                  <div class="vector-agent-reply-actions">
                    <span>{props.runtimeLabel}</span>
                    <Show when={turn().cost}>
                      <span>{turn().cost}</span>
                    </Show>
                    <button
                      type="button"
                      aria-label={state.copied === id ? "Reply copied" : "Copy reply"}
                      title={state.copied === id ? "Copied" : "Copy reply"}
                      onClick={async () => {
                        const copied = await navigator.clipboard
                          ?.writeText(
                            messages()
                              .map((message) => message.text)
                              .join("\n\n"),
                          )
                          .then(
                            () => true,
                            () => false,
                          )
                        if (copied) return setState("copied", id)
                        showToast({
                          title: "Couldn’t copy reply",
                          description: "Select the reply text and copy it manually.",
                        })
                      }}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <Show
                          when={state.copied === id}
                          fallback={
                            <>
                              <rect x="5.5" y="5.5" width="7" height="8" rx="1.5" />
                              <path d="M9.5 5.5v-2A1.5 1.5 0 0 0 8 2H3.5A1.5 1.5 0 0 0 2 3.5V9A1.5 1.5 0 0 0 3.5 10.5h2" />
                            </>
                          }
                        >
                          <path d="m3 8 3 3 7-7" />
                        </Show>
                      </svg>
                    </button>
                  </div>
                </Show>
              </Show>
            </article>
          )
        }}
      </For>
    </div>
  )
}
