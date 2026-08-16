import { createMemo, createSignal, For, Show } from "solid-js"
import {
  describeNextRun,
  describeRecurrence,
  filterTasks,
  nextRun,
  sortByNextRun,
  SUGGESTIONS,
  type ScheduledTask,
  type Suggestion,
  type TaskFilter,
} from "./schedule-model"

const FILTERS: TaskFilter[] = ["all", "active", "paused"]

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

export function ScheduledTasks(props: {
  open: boolean
  tasks: ScheduledTask[]
  onClose: () => void
  onCreate: () => void
  onUseSuggestion: (suggestion: Suggestion) => void
  onTogglePause: (id: string, paused: boolean) => void
  onDelete: (id: string) => void
}) {
  const [filter, setFilter] = createSignal<TaskFilter>("all")
  const [query, setQuery] = createSignal("")
  const now = new Date()

  const visible = createMemo(() => sortByNextRun(filterTasks(props.tasks, filter(), query()), now))

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
            onClick={props.onCreate}
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
              {(suggestion) => <SuggestionRow suggestion={suggestion} onUse={props.onUseSuggestion} />}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
