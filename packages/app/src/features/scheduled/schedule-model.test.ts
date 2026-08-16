import { describe, expect, test } from "bun:test"
import {
  describeNextRun,
  describeRecurrence,
  filterTasks,
  formatTime,
  nextRun,
  parseTime,
  sortByNextRun,
  type ScheduledTask,
} from "./schedule-model"

// A Friday, 10:00 local time.
const friday10 = new Date(2026, 7, 14, 10, 0, 0, 0)

function task(partial: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    title: "Task",
    prompt: "do it",
    directory: "/repo",
    recurrence: { kind: "daily", time: "08:00" },
    paused: false,
    createdAt: friday10.toISOString(),
    ...partial,
  }
}

describe("parseTime", () => {
  test("parses valid times", () => {
    expect(parseTime("08:00")).toEqual({ hours: 8, minutes: 0 })
    expect(parseTime("23:59")).toEqual({ hours: 23, minutes: 59 })
  })

  test("rejects impossible or malformed times rather than defaulting to midnight", () => {
    for (const bad of ["24:00", "08:60", "8", "", "abc", "08:0"]) expect(parseTime(bad)).toBeUndefined()
  })
})

describe("formatTime", () => {
  test("renders 12-hour time with midnight and noon correct", () => {
    expect(formatTime("08:00")).toBe("8:00 AM")
    expect(formatTime("16:30")).toBe("4:30 PM")
    expect(formatTime("00:15")).toBe("12:15 AM")
    expect(formatTime("12:00")).toBe("12:00 PM")
  })
})

describe("describeRecurrence", () => {
  test("phrases each kind the way the panel reads", () => {
    expect(describeRecurrence({ kind: "daily", time: "08:00" })).toBe("Every day at 8:00 AM")
    expect(describeRecurrence({ kind: "weekdays", time: "08:00" })).toBe("Weekdays at 8:00 AM")
    expect(describeRecurrence({ kind: "weekly", weekday: 5, time: "08:00" })).toBe("Fridays at 8:00 AM")
  })

  test("names an invalid one-shot instead of rendering a bad date", () => {
    expect(describeRecurrence({ kind: "once", at: "not a date" })).toBe("Invalid schedule")
  })
})

describe("nextRun", () => {
  test("daily rolls to tomorrow once today's time has passed", () => {
    const next = nextRun({ kind: "daily", time: "08:00" }, friday10)!
    expect(next.getDate()).toBe(15)
    expect(next.getHours()).toBe(8)
  })

  test("daily stays today when the time is still ahead", () => {
    const next = nextRun({ kind: "daily", time: "18:00" }, friday10)!
    expect(next.getDate()).toBe(14)
  })

  test("weekdays skips the weekend", () => {
    const next = nextRun({ kind: "weekdays", time: "08:00" }, friday10)!
    expect(next.getDay()).toBe(1)
  })

  test("weekly lands on the right weekday a week out", () => {
    const next = nextRun({ kind: "weekly", weekday: 5, time: "08:00" }, friday10)!
    expect(next.getDay()).toBe(5)
    expect(next.getTime()).toBeGreaterThan(friday10.getTime())
  })

  test("is always strictly in the future so a task cannot immediately re-fire", () => {
    const exactly = new Date(2026, 7, 14, 8, 0, 0, 0)
    expect(nextRun({ kind: "daily", time: "08:00" }, exactly)!.getTime()).toBeGreaterThan(exactly.getTime())
  })

  test("a past one-shot has no next run", () => {
    expect(nextRun({ kind: "once", at: new Date(2020, 0, 1).toISOString() }, friday10)).toBeUndefined()
  })

  test("a future one-shot returns its moment", () => {
    const at = new Date(2026, 7, 20, 9, 0).toISOString()
    expect(nextRun({ kind: "once", at }, friday10)!.toISOString()).toBe(at)
  })

  test("an unparseable time yields no run rather than midnight", () => {
    expect(nextRun({ kind: "daily", time: "nope" }, friday10)).toBeUndefined()
  })
})

describe("describeNextRun", () => {
  test("scales the phrasing by distance", () => {
    expect(describeNextRun(new Date(friday10.getTime() + 30 * 60_000), friday10)).toBe("Next run in 30 minutes")
    expect(describeNextRun(new Date(friday10.getTime() + 3 * 3_600_000), friday10)).toBe("Next run in 3 hours")
    expect(describeNextRun(new Date(friday10.getTime() + 6 * 86_400_000), friday10)).toBe("Next run in 6 days")
  })

  test("singularises", () => {
    expect(describeNextRun(new Date(friday10.getTime() + 86_400_000), friday10)).toBe("Next run in 1 day")
  })

  test("handles no run and an overdue run", () => {
    expect(describeNextRun(undefined, friday10)).toBe("No further runs")
    expect(describeNextRun(new Date(friday10.getTime() - 1000), friday10)).toBe("Due now")
  })
})

describe("filterTasks", () => {
  const tasks = [task({ id: "a", title: "Morning brief" }), task({ id: "b", title: "Nightly", paused: true })]

  test("filters by state", () => {
    expect(filterTasks(tasks, "active", "").map((t) => t.id)).toEqual(["a"])
    expect(filterTasks(tasks, "paused", "").map((t) => t.id)).toEqual(["b"])
    expect(filterTasks(tasks, "all", "")).toHaveLength(2)
  })

  test("searches title and prompt, case-insensitively", () => {
    expect(filterTasks(tasks, "all", "MORNING").map((t) => t.id)).toEqual(["a"])
    expect(filterTasks(tasks, "all", "do it")).toHaveLength(2)
    expect(filterTasks(tasks, "all", "nothing")).toEqual([])
  })
})

describe("sortByNextRun", () => {
  test("paused tasks sink below active ones", () => {
    const sorted = sortByNextRun(
      [task({ id: "paused", paused: true, recurrence: { kind: "daily", time: "18:00" } }), task({ id: "active" })],
      friday10,
    )
    expect(sorted.map((t) => t.id)).toEqual(["active", "paused"])
  })

  test("sooner runs come first", () => {
    const sorted = sortByNextRun(
      [
        task({ id: "later", recurrence: { kind: "weekly", weekday: 5, time: "08:00" } }),
        task({ id: "sooner", recurrence: { kind: "daily", time: "18:00" } }),
      ],
      friday10,
    )
    expect(sorted[0]!.id).toBe("sooner")
  })
})
