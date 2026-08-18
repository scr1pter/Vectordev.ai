import { createMemo, createSignal, For, Show } from "solid-js"
import {
  describeNextRun,
  describeRecurrence,
  filterTasks,
  buildRecurrence,
  nextRun,
  sortByNextRun,
  SUGGESTIONS,
  type Recurrence,
  type ScheduledTask,
  type Suggestion,
  type TaskFilter,
} from "./schedule-model"

const FILTERS: TaskFilter[] = ["all", "active", "paused"]

const REPEATS = [
  { kind: "once", label: "Once" },
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Weekly" },
] as const

type RepeatKind = (typeof REPEATS)[number]["kind"]

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time. toISOString() would
// shift by the timezone offset and schedule the task at the wrong hour.
function localDateTimeValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export type ScheduleRequest = {
  title: string
  prompt: string
  recurrence: Recurrence
  runAt: string
}

function StatusDot(props: { task: ScheduledTask }) {
  return (
    <span
      class="mt-[3px] size-3.5 shrink-0 rounded-full border"
      classList={{
        "border-white/25": !props.task.paused,
        "border-white/15 bg-white/[0.04]": props.task.paused,
      }}
      aria-hidden="true"
    />
  )
}

function SuggestionRow(props: { suggestion: Suggestion; onUse: (suggestion: Suggestion) => void }) {
  return (
    <button
      type="button"
      class="flex w-full items-start gap-3 rounded-[8px] px-2 py-2.5 text-left transition hover:bg-white/[0.035]"
      onClick={() => props.onUse(props.suggestion)}
    >
      <span class="mt-0.5 grid size-4 shrink-0 place-items-center text-[color:var(--vx-purple-bright)]">
        <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
          <rect x="2.4" y="3.2" width="11.2" height="10.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.15" />
          <path d="M5.4 2v2.4M10.6 2v2.4M2.4 6.4h11.2" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" />
        </svg>
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex flex-wrap items-baseline gap-2">
          <span class="text-[13px] font-medium text-white">{props.suggestion.title}</span>
          <span class="text-[12.5px] text-white/40">{props.suggestion.schedule}</span>
        </span>
        <span class="mt-0.5 block text-[12.5px] leading-relaxed text-white/45">{props.suggestion.description}</span>
      </span>
    </button>
  )
}


function CreateForm(props: {
  seed?: Suggestion
  onCancel: () => void
  onSchedule: (input: ScheduleRequest) => void
}) {
  const [title, setTitle] = createSignal(props.seed?.title ?? "")
  const [prompt, setPrompt] = createSignal(props.seed?.prompt ?? "")
  const seeded = props.seed?.recurrence
  const [kind, setKind] = createSignal<RepeatKind>(seeded?.kind ?? "once")
  const [at, setAt] = createSignal(
    seeded?.kind === "once" ? localDateTimeValue(new Date(seeded.at)) : localDateTimeValue(new Date(Date.now() + 3_600_000)),
  )
  const [time, setTime] = createSignal(seeded && seeded.kind !== "once" ? seeded.time : "09:00")
  const [weekday, setWeekday] = createSignal(seeded?.kind === "weekly" ? seeded.weekday : 1)

  const recurrence = createMemo(() => buildRecurrence({ kind: kind(), at: at(), time: time(), weekday: weekday() }))
  // A one-shot in the past has no next run, so nextRun returns undefined and
  // the task would be created already dead. Block it at the form instead.
  const runAt = createMemo(() => {
    const value = recurrence()
    if (!value) return undefined
    return nextRun(value, new Date())?.toISOString()
  })
  const ready = createMemo(() => Boolean(prompt().trim() && recurrence() && runAt()))

  const submit = (event: Event) => {
    event.preventDefault()
    const value = recurrence()
    const when = runAt()
    if (!prompt().trim() || !value || !when) return
    props.onSchedule({
      title: title().trim() || prompt().trim().split("\n")[0]?.slice(0, 80) || "Scheduled run",
      prompt: prompt().trim(),
      recurrence: value,
      runAt: when,
    })
  }

  const field = "w-full rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.045] px-3 py-2 text-[13.5px] text-white outline-none placeholder:text-white/35 focus:border-[color:var(--vx-purple)]"

  return (
    <form class="mt-5 rounded-[12px] border border-[color:var(--vx-line)] bg-white/[0.025] p-4" onSubmit={submit}>
      <label class="block text-[12px] font-medium uppercase tracking-wide text-white/45" for="scheduled-prompt">
        What should Vector do?
      </label>
      <textarea
        id="scheduled-prompt"
        rows={3}
        value={prompt()}
        placeholder="Summarise what changed in this repository since yesterday"
        class={`mt-1.5 resize-y ${field}`}
        onInput={(event) => setPrompt(event.currentTarget.value)}
      />

      <label class="mt-3 block text-[12px] font-medium uppercase tracking-wide text-white/45" for="scheduled-title">
        Name <span class="normal-case text-white/30">(optional)</span>
      </label>
      <input
        id="scheduled-title"
        value={title()}
        placeholder="Morning repo brief"
        class={`mt-1.5 ${field}`}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />

      <div class="mt-3 flex flex-wrap gap-3">
        <div class="min-w-[150px] flex-1">
          <label class="block text-[12px] font-medium uppercase tracking-wide text-white/45" for="scheduled-repeat">
            Repeat
          </label>
          <select
            id="scheduled-repeat"
            value={kind()}
            class={`mt-1.5 ${field}`}
            onChange={(event) => setKind(event.currentTarget.value as RepeatKind)}
          >
            <For each={REPEATS}>{(item) => <option value={item.kind}>{item.label}</option>}</For>
          </select>
        </div>

        <Show when={kind() === "weekly"}>
          <div class="min-w-[150px] flex-1">
            <label class="block text-[12px] font-medium uppercase tracking-wide text-white/45" for="scheduled-weekday">
              Day
            </label>
            <select
              id="scheduled-weekday"
              value={String(weekday())}
              class={`mt-1.5 ${field}`}
              onChange={(event) => setWeekday(Number(event.currentTarget.value))}
            >
              <For each={WEEKDAYS}>{(name, index) => <option value={String(index())}>{name}</option>}</For>
            </select>
          </div>
        </Show>

        <div class="min-w-[170px] flex-1">
          <label class="block text-[12px] font-medium uppercase tracking-wide text-white/45" for="scheduled-when">
            {kind() === "once" ? "When" : "Time"}
          </label>
          <Show
            when={kind() === "once"}
            fallback={
              <input
                id="scheduled-when"
                type="time"
                value={time()}
                class={`mt-1.5 ${field}`}
                onInput={(event) => setTime(event.currentTarget.value)}
              />
            }
          >
            <input
              id="scheduled-when"
              type="datetime-local"
              value={at()}
              class={`mt-1.5 ${field}`}
              onInput={(event) => setAt(event.currentTarget.value)}
            />
          </Show>
        </div>
      </div>

      <div class="mt-4 flex items-center justify-between gap-3">
        <span class="text-[12.5px] text-white/40">
          {recurrence() && runAt()
            ? `${describeRecurrence(recurrence()!)} · first run ${describeNextRun(new Date(runAt()!), new Date())}`
            : kind() === "once"
              ? "Pick a time in the future."
              : "Pick a valid time."}
        </span>
        <div class="flex shrink-0 gap-2">
          <button
            type="button"
            class="rounded-full px-3.5 py-1.5 text-[13px] text-white/55 transition hover:text-white"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready()}
            class="rounded-full bg-white/[0.12] px-4 py-1.5 text-[13px] font-medium text-white transition enabled:hover:bg-white/[0.18] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Schedule
          </button>
        </div>
      </div>
    </form>
  )
}

export function ScheduledTasks(props: {
  open: boolean
  tasks: ScheduledTask[]
  onClose: () => void
  onSchedule: (input: ScheduleRequest) => void
  onTogglePause: (id: string, paused: boolean) => void
  onDelete: (id: string) => void
}) {
  const [filter, setFilter] = createSignal<TaskFilter>("all")
  const [query, setQuery] = createSignal("")
  const [composing, setComposing] = createSignal(false)
  const [seed, setSeed] = createSignal<Suggestion | undefined>(undefined)
  const now = new Date()

  const visible = createMemo(() => sortByNextRun(filterTasks(props.tasks, filter(), query()), now))

  const compose = (suggestion?: Suggestion) => {
    setSeed(suggestion)
    setComposing(true)
  }

  return (
    <Show when={props.open}>
      <div
        data-vector-scheduled-tasks
        role="dialog"
        aria-modal="true"
        aria-label="Scheduled tasks"
        class="fixed inset-0 z-[90] overflow-y-auto bg-[color:var(--vx-canvas)]"
      >
        <div class="flex justify-end px-6 pt-5">
          <button
            type="button"
            class="rounded-full border border-[color:var(--vx-line)] bg-white/[0.04] px-4 py-1.5 text-[13px] font-medium text-white transition hover:bg-white/[0.08]"
            onClick={() => compose(undefined)}
          >
            Create
          </button>
          <button
            type="button"
            aria-label="Close scheduled tasks"
            class="ml-2 grid size-8 place-items-center rounded-full text-white/45 transition hover:bg-white/[0.06] hover:text-white"
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
              <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div class="mx-auto w-full max-w-[760px] px-6 pb-16 pt-6">
          <h1 class="text-[34px] font-semibold leading-tight text-white">Scheduled tasks</h1>
          <p class="mt-2 text-[15px] text-white/45">
            Ask Vector to schedule tasks, set reminders, or watch a repository for changes
          </p>

          <Show when={composing()}>
            <CreateForm
              seed={seed()}
              onCancel={() => setComposing(false)}
              onSchedule={(input) => {
                props.onSchedule(input)
                setComposing(false)
              }}
            />
          </Show>

          <div class="relative mt-6">
            <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/35">
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path d="M7.1 12.1a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm3.55-1.45 3 3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
            </span>
            <input
              value={query()}
              placeholder="Search scheduled tasks"
              aria-label="Search scheduled tasks"
              class="h-12 w-full rounded-full border border-[color:var(--vx-line)] bg-white/[0.045] pl-11 pr-4 text-[14px] text-white outline-none placeholder:text-white/35 focus:border-[color:var(--vx-purple)]"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>

          <div class="mt-5 flex gap-1">
            <For each={FILTERS}>
              {(value) => (
                <button
                  type="button"
                  class="rounded-full px-3.5 py-1.5 text-[13.5px] capitalize transition"
                  classList={{
                    "bg-white/[0.09] text-white": filter() === value,
                    "text-white/45 hover:text-white": filter() !== value,
                  }}
                  onClick={() => setFilter(value)}
                >
                  {value}
                </button>
              )}
            </For>
          </div>

          <div class="mt-4">
            <Show
              when={visible().length}
              fallback={
                <p class="px-2 py-6 text-[13.5px] text-white/40">
                  {props.tasks.length ? "No tasks match this filter." : "No scheduled tasks yet."}
                </p>
              }
            >
              <For each={visible()}>
                {(task) => (
                  <div class="group flex items-start gap-3 rounded-[8px] px-2 py-3 transition hover:bg-white/[0.03]">
                    <StatusDot task={task} />
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-baseline gap-2">
                        <span class="text-[14.5px] font-medium text-white">{task.title}</span>
                        <Show when={task.paused}>
                          <span class="rounded-full bg-white/[0.07] px-1.5 py-px text-[9.5px] uppercase tracking-wide text-white/45">
                            paused
                          </span>
                        </Show>
                      </div>
                      <div class="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-white/40">
                        <span>{describeRecurrence(task.recurrence)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{task.paused ? "Paused" : describeNextRun(nextRun(task.recurrence, now), now)}</span>
                        <Show when={task.cloud}>
                          <span aria-hidden="true">·</span>
                          <span class="inline-flex items-center gap-1">
                            <svg viewBox="0 0 16 16" class="size-3.5" aria-hidden="true">
                              <path d="M4.4 12.2a2.9 2.9 0 0 1-.3-5.78 3.6 3.6 0 0 1 6.94-1.2 2.9 2.9 0 0 1 .56 5.75l-.3.03H4.4Z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" />
                            </svg>
                            Cloud scheduled task
                          </span>
                        </Show>
                      </div>
                    </div>
                    <div class="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        class="rounded-[6px] px-2 py-1 text-[12px] text-white/55 transition hover:text-white"
                        onClick={() => props.onTogglePause(task.id, !task.paused)}
                      >
                        {task.paused ? "Resume" : "Pause"}
                      </button>
                      <button
                        type="button"
                        class="rounded-[6px] px-2 py-1 text-[12px] text-white/45 transition hover:text-rose-300"
                        onClick={() => props.onDelete(task.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div class="mt-8 border-t border-[color:var(--vx-line)] pt-6">
            <h2 class="mb-2 text-[15px] font-medium text-white/70">Suggestions</h2>
            <For each={SUGGESTIONS}>
              {(suggestion) => <SuggestionRow suggestion={suggestion} onUse={compose} />}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
