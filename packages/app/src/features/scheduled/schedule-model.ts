// Recurrence for scheduled tasks, plus the human phrasing the panel shows.
// Pure so the next-run arithmetic — the part that silently goes wrong across
// midnight, week boundaries, and a paused task — is testable.

export type Recurrence =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string }

export type ScheduledTask = {
  id: string
  title: string
  prompt: string
  directory: string
  recurrence: Recurrence
  paused: boolean
  createdAt: string
  lastRunAt?: string
  lastStatus?: "completed" | "failed" | "canceled"
  cloud?: boolean
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// "08:00" -> {hours: 8, minutes: 0}. Invalid input yields undefined so callers
// render "Invalid schedule" instead of silently running at midnight.
export function parseTime(time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return { hours, minutes }
}

export function formatTime(time: string) {
  const parsed = parseTime(time)
  if (!parsed) return time
  const suffix = parsed.hours < 12 ? "AM" : "PM"
  const hour = parsed.hours % 12 === 0 ? 12 : parsed.hours % 12
  return `${hour}:${String(parsed.minutes).padStart(2, "0")} ${suffix}`
}

export function describeRecurrence(recurrence: Recurrence): string {
  if (recurrence.kind === "once") {
    const at = new Date(recurrence.at)
    if (Number.isNaN(at.getTime())) return "Invalid schedule"
    return `Once on ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
  }
  if (recurrence.kind === "daily") return `Every day at ${formatTime(recurrence.time)}`
  if (recurrence.kind === "weekdays") return `Weekdays at ${formatTime(recurrence.time)}`
  return `${WEEKDAY_NAMES[recurrence.weekday] ?? "Sunday"}s at ${formatTime(recurrence.time)}`
}

function atTime(base: Date, time: { hours: number; minutes: number }) {
  const next = new Date(base)
  next.setHours(time.hours, time.minutes, 0, 0)
  return next
}

const isWeekday = (date: Date) => date.getDay() >= 1 && date.getDay() <= 5

// The next moment this task should run, or undefined when it never will again
// (a one-shot already past). Strictly after `from`, so a task that just ran does
// not immediately re-fire.
export function nextRun(recurrence: Recurrence, from: Date): Date | undefined {
  if (recurrence.kind === "once") {
    const at = new Date(recurrence.at)
    if (Number.isNaN(at.getTime()) || at <= from) return undefined
    return at
  }

  const time = parseTime(recurrence.time)
  if (!time) return undefined

  if (recurrence.kind === "daily") {
    const today = atTime(from, time)
    return today > from ? today : atTime(new Date(from.getTime() + 86_400_000), time)
  }

  if (recurrence.kind === "weekdays") {
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = atTime(new Date(from.getTime() + offset * 86_400_000), time)
      if (candidate > from && isWeekday(candidate)) return candidate
    }
    return undefined
  }

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = atTime(new Date(from.getTime() + offset * 86_400_000), time)
    if (candidate > from && candidate.getDay() === recurrence.weekday) return candidate
  }
  return undefined
}

// "Next run in 6 days" / "Next run in 2 hours". Deliberately coarse: a live
// countdown to the minute invites the reader to trust a precision the
// scheduler does not actually guarantee.
export function describeNextRun(next: Date | undefined, now: Date): string {
  if (!next) return "No further runs"
  const ms = next.getTime() - now.getTime()
  if (ms <= 0) return "Due now"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `Next run in ${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Next run in ${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.round(hours / 24)
  return `Next run in ${days} day${days === 1 ? "" : "s"}`
}

export type TaskFilter = "all" | "active" | "paused"

export function filterTasks(tasks: readonly ScheduledTask[], filter: TaskFilter, query: string) {
  const needle = query.trim().toLowerCase()
  return tasks
    .filter((task) => (filter === "all" ? true : filter === "paused" ? task.paused : !task.paused))
    .filter((task) =>
      !needle ? true : `${task.title} ${task.prompt}`.toLowerCase().includes(needle),
    )
}

// Sorted by when they will actually next run, so what is imminent is on top.
// Paused tasks sink below active ones regardless of their nominal schedule.
export function sortByNextRun(tasks: readonly ScheduledTask[], now: Date) {
  return [...tasks].sort((a, b) => {
    if (a.paused !== b.paused) return a.paused ? 1 : -1
    const aNext = nextRun(a.recurrence, now)?.getTime() ?? Infinity
    const bNext = nextRun(b.recurrence, now)?.getTime() ?? Infinity
    return aNext - bNext
  })
}

export type Suggestion = { title: string; schedule: string; description: string; recurrence: Recurrence; prompt: string }

export const SUGGESTIONS: Suggestion[] = [
  {
    title: "Morning repo brief",
    schedule: "Weekdays at 8:00 AM",
    description: "Summarise what changed overnight, open pull requests, and anything failing checks",
    recurrence: { kind: "weekdays", time: "08:00" },
    prompt:
      "Summarise what changed in this repository since yesterday: new commits, open pull requests, and any failing checks. Keep it to a short brief.",
  },
  {
    title: "Dependency check",
    schedule: "Mondays at 9:00 AM",
    description: "Look for outdated or vulnerable dependencies and report what is worth upgrading",
    recurrence: { kind: "weekly", weekday: 1, time: "09:00" },
    prompt:
      "Check this project's dependencies for outdated or vulnerable packages. Report only upgrades worth making and why.",
  },
  {
    title: "Weekly review",
    schedule: "Fridays at 4:00 PM",
    description: "Turn the week's work into a concise status update",
    recurrence: { kind: "weekly", weekday: 5, time: "16:00" },
    prompt: "Review this week's commits and changes in the repository and write a concise status update.",
  },
]
