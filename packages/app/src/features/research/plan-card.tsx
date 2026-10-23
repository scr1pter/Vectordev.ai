import { For, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import type { QuestionRequest } from "@vectordevai/sdk/v2"
import type { Research } from "@vectordevai/schema/research"
import { Button } from "@vectordevai/ui/button"
import { DockPrompt } from "@vectordevai/session-ui/dock-prompt"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import {
  PREVIEW,
  SCOPES,
  draftOf,
  planProblem,
  planReply,
  searchLine,
  site,
  type Draft,
  type PlanCardData,
  type Remembered,
} from "./research-model"
import "./research.css"

const FORMATS: readonly { value: Research.Format; label: string }[] = [
  { value: "brief", label: "Brief" },
  { value: "report", label: "Report" },
  { value: "table", label: "Table" },
  { value: "memo", label: "Memo" },
]

const SETUP =
  "To search the web, add a SearXNG server (with its JSON format turned on) or an Exa or Parallel key to research.search in your user config. Changing config restarts Vector's engine, which stops running sessions, so set it up between runs."

/**
 * The research_plan question as a plan card (section 8.2): every field of the plan can be changed before Start, Start
 * deep or Cancel, and a typed reply steers the plan instead. The card answers as research_plan reads it: the button's
 * label when nothing changed, else `vector-plan:{json}` with the edited fields.
 */
export function ResearchPlanCard(props: { request: QuestionRequest; data: PlanCardData; onSubmit: () => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const proposed = () => props.data.plan
  const card = () => props.data.card
  const [draft, setDraft] = createStore<Draft>(draftOf(props.data.plan))
  const [always, setAlways] = createStore<Record<Remembered, boolean>>({
    prefer_domains: false,
    avoid_domains: false,
    format: false,
  })
  const [adding, setAdding] = createStore({ prefer: "", avoid: "" })
  const [steer, setSteer] = createSignal("")
  const [setup, setSetup] = createSignal(false)
  const problem = createMemo(() => planProblem(draft))
  const learned = createMemo(
    () => new Set([...(card()?.preferences.prefer ?? []), ...(card()?.preferences.avoid ?? [])]),
  )
  const edited = (key: Remembered) => {
    if (key === "format") return draft.format !== proposed().format
    const before = proposed()[key] ?? []
    return draft[key].length !== before.length || draft[key].some((item, index) => item !== before[index])
  }

  const reply = useMutation(() => ({
    mutationFn: (text: string) => sdk().client.question.reply({ requestID: props.request.id, answers: [[text]] }),
    onMutate: () => props.onSubmit(),
    onError: (error: unknown) =>
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))
  const dismiss = useMutation(() => ({
    mutationFn: () => sdk().client.question.reject({ requestID: props.request.id }),
    onMutate: () => props.onSubmit(),
  }))
  const sending = () => reply.isPending || dismiss.isPending

  const answer = (action: "start" | "start-deep" | "cancel") => {
    if (sending() || (action !== "cancel" && problem())) return
    reply.mutate(
      planReply({
        action,
        proposed: proposed(),
        draft,
        always: (Object.keys(always) as Remembered[]).filter((key) => always[key] && edited(key)),
      }),
    )
  }

  const addSite = (key: "prefer" | "avoid") => {
    const value = site(adding[key])
    setAdding(key, "")
    if (!value) return
    const field = key === "prefer" ? "prefer_domains" : "avoid_domains"
    if (draft[field].includes(value)) return
    setDraft(field, [...draft[field], value].slice(0, 50))
  }

  const Sites = (input: { key: "prefer" | "avoid"; label: string }) => {
    const field = input.key === "prefer" ? "prefer_domains" : "avoid_domains"
    return (
      <div data-slot="research-field">
        <span data-slot="research-label">{input.label}</span>
        <div data-slot="research-row">
          <For each={draft[field]}>
            {(item) => (
              <span
                data-slot="research-tag"
                data-learned={learned().has(item) ? "true" : undefined}
                title={learned().has(item) ? "From your preferences" : undefined}
              >
                {item}
                <Show when={learned().has(item)}>
                  <span data-slot="research-muted">from your preferences</span>
                </Show>
                <button
                  type="button"
                  aria-label={`Remove ${item}`}
                  disabled={sending()}
                  onClick={() => setDraft(field, (list) => list.filter((entry) => entry !== item))}
                >
                  ×
                </button>
              </span>
            )}
          </For>
          <input
            data-slot="research-input"
            style={{ width: "180px" }}
            placeholder="Add a site, such as arxiv.org"
            aria-label={`Add a site to ${input.label.toLowerCase()}`}
            value={adding[input.key]}
            disabled={sending()}
            onInput={(event) => setAdding(input.key, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              addSite(input.key)
            }}
            onBlur={() => addSite(input.key)}
          />
        </div>
        <Always field={field} />
      </div>
    )
  }

  const Always = (input: { field: Remembered }) => (
    <Show when={edited(input.field)}>
      <label data-slot="research-always">
        <input
          type="checkbox"
          checked={always[input.field]}
          disabled={sending()}
          onChange={(event) => setAlways(input.field, event.currentTarget.checked)}
        />
        Always
      </label>
    </Show>
  )

  return (
    <div data-component="research-plan-card">
      <DockPrompt
        kind="question"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return
          event.preventDefault()
          if (!sending()) dismiss.mutate()
        }}
        header={
          <>
            <div data-slot="question-header-title">
              Research plan <span data-component="research-preview-label">{PREVIEW}</span>
            </div>
            <div data-slot="question-header-actions">
              <span data-slot="research-muted">
                {proposed().depth === "deep"
                  ? "Deep: up to 4 researchers and a judge"
                  : "Focused: one agent, plus up to 2 researchers when the question has independent parts"}
              </span>
            </div>
          </>
        }
        footer={
          <>
            <Button variant="ghost" size="large" disabled={sending()} onClick={() => answer("cancel")}>
              Cancel
            </Button>
            <div data-slot="question-footer-actions">
              <Show when={card()?.deep}>
                <Button
                  variant="secondary"
                  size="large"
                  disabled={sending() || !!problem()}
                  onClick={() => answer("start-deep")}
                  title={card()?.deepEstimate}
                >
                  Start deep
                </Button>
              </Show>
              <Button
                variant="primary"
                size="large"
                disabled={sending() || !!problem()}
                onClick={() => answer("start")}
              >
                Start
              </Button>
            </div>
          </>
        }
      >
        <div data-component="research-card">
          <div data-slot="research-field">
            <span data-slot="research-label">Question</span>
            <textarea
              data-slot="research-input"
              rows={2}
              value={draft.question}
              disabled={sending()}
              aria-label="Question"
              onInput={(event) => setDraft("question", event.currentTarget.value)}
            />
          </div>

          <div data-slot="research-field">
            <span data-slot="research-label">Sub-questions</span>
            <For each={draft.subquestions}>
              {(item, index) => (
                <div data-slot="research-subquestion">
                  <span>{index() + 1}.</span>
                  <input
                    data-slot="research-input"
                    value={item}
                    disabled={sending()}
                    aria-label={`Sub-question ${index() + 1}`}
                    onInput={(event) => setDraft("subquestions", index(), event.currentTarget.value)}
                  />
                  <button
                    type="button"
                    data-slot="research-button"
                    aria-label={`Delete sub-question ${index() + 1}`}
                    disabled={sending() || draft.subquestions.length <= 1}
                    onClick={() => setDraft("subquestions", (list) => list.filter((_, at) => at !== index()))}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
            <div data-slot="research-row">
              <button
                type="button"
                data-slot="research-button"
                disabled={sending() || draft.subquestions.length >= 8}
                onClick={() => setDraft("subquestions", (list) => [...list, ""])}
              >
                Add sub-question
              </button>
            </div>
          </div>

          <Show when={props.data.estimate}>
            <div data-slot="research-notice">
              <div>{props.data.estimate}</div>
              <Show when={card()?.deep && card()?.deepEstimate}>
                <div>Start deep: {card()!.deepEstimate}</div>
              </Show>
            </div>
          </Show>

          <Show when={searchLine(card())}>
            {(line) => (
              <div data-slot="research-row">
                <span data-slot="research-muted">{line()}</span>
                <Show when={card()?.search.provider === "none" && draft.scope !== "brain" && !card()?.offline}>
                  <button type="button" data-slot="research-button" onClick={() => setSetup((open) => !open)}>
                    Set up
                  </button>
                  <button
                    type="button"
                    data-slot="research-button"
                    disabled={sending()}
                    onClick={() => setDraft("scope", "brain")}
                  >
                    Brain and files only
                  </button>
                </Show>
              </div>
            )}
          </Show>
          <Show when={setup()}>
            <div data-slot="research-notice">
              <div>{card()?.search.reason ?? SETUP}</div>
              <Show when={card()?.search.reason}>
                <div>{SETUP}</div>
              </Show>
            </div>
          </Show>

          <div data-slot="research-pair">
            <div data-slot="research-field">
              <span data-slot="research-label">Scope</span>
              <div data-slot="research-segments" role="group" aria-label="Scope">
                <For each={SCOPES}>
                  {(item) => (
                    <button
                      type="button"
                      aria-pressed={draft.scope === item.value}
                      disabled={sending() || card()?.offline}
                      onClick={() => setDraft("scope", item.value)}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
              <Show when={card()?.offline}>
                <span data-slot="research-muted">
                  Vector Local's Web access is None, so this research uses your brain and files.
                </span>
              </Show>
            </div>
            <div data-slot="research-field">
              <span data-slot="research-label">Format</span>
              <div data-slot="research-segments" role="group" aria-label="Format">
                <For each={FORMATS}>
                  {(item) => (
                    <button
                      type="button"
                      aria-pressed={draft.format === item.value}
                      disabled={sending()}
                      onClick={() => setDraft("format", item.value)}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
              <Always field="format" />
            </div>
          </div>

          <div data-slot="research-pair">
            <Sites key="prefer" label="Prefer" />
            <Sites key="avoid" label="Avoid" />
          </div>

          <div data-slot="research-field">
            <span data-slot="research-label">Time window</span>
            <input
              data-slot="research-input"
              placeholder="Any time, or such as since 2023"
              value={draft.time_window}
              disabled={sending()}
              aria-label="Time window"
              onInput={(event) => setDraft("time_window", event.currentTarget.value)}
            />
          </div>

          <Show when={problem()}>
            {(text) => (
              <div data-slot="research-notice" data-tone="warning">
                {text()}
              </div>
            )}
          </Show>

          <div data-slot="research-field">
            <span data-slot="research-label">Or reply instead</span>
            <div data-slot="research-row">
              <textarea
                data-slot="research-input"
                rows={1}
                style={{ flex: "1 1 220px" }}
                placeholder="Tell Vector what to change in this plan"
                value={steer()}
                disabled={sending()}
                aria-label="Reply to the plan"
                onInput={(event) => setSteer(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return
                  event.preventDefault()
                  if (steer().trim()) reply.mutate(steer().trim())
                }}
              />
              <button
                type="button"
                data-slot="research-button"
                disabled={sending() || !steer().trim()}
                onClick={() => reply.mutate(steer().trim())}
              >
                Send reply
              </button>
            </div>
          </div>
        </div>
      </DockPrompt>
    </div>
  )
}
