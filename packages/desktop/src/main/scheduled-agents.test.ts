import { afterEach, describe, expect, test } from "bun:test"

import {
  advanceSchedule,
  createScheduledAgents,
  describeCatchUp,
  pausedStatus,
  scheduledAgentTargets,
  type ScheduledAgentEngine,
  type ScheduledAgentRecord,
} from "./scheduled-agents"

const once = { kind: "once", at: "2026-08-20T10:00:00.000Z" } as const
const daily = { kind: "daily", time: "09:00" } as const
const weekdays = { kind: "weekdays", time: "09:00" } as const
const mondays = { kind: "weekly", weekday: 1, time: "09:00" } as const

// The recurrence arithmetic runs in the process's local zone, so a real DST
// assertion needs a process pinned to a zone that observes one. Bun fixes the
// zone the first time a Date is built — which a sibling test file may already
// have done — so this runs in a fresh process rather than hoping a late
// process.env.TZ still takes.
function inNewYork(script: string): unknown {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      [
        `const { advanceSchedule } = await import(${JSON.stringify(`${import.meta.dir}/scheduled-agents.ts`)})`,
        `console.log(JSON.stringify((() => {${script}})()))`,
      ].join("\n"),
    ],
    cwd: import.meta.dir,
    env: { ...process.env, TZ: "America/New_York" },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return JSON.parse(result.stdout.toString())
}

describe("pausedStatus — pausing", () => {
  test("parks a pending run", () => {
    expect(pausedStatus({ status: "scheduled", recurrence: once }, true)).toBe("canceled")
  })

  test("leaves every other state untouched", () => {
    for (const status of ["running", "completed", "failed", "canceled"] as const) {
      expect(pausedStatus({ status, recurrence: once }, true)).toBe(status)
    }
  })
})

describe("pausedStatus — resuming", () => {
  test("re-arms a run that pausing had parked", () => {
    expect(pausedStatus({ status: "canceled", recurrence: once }, false)).toBe("scheduled")
  })

  test("does NOT resurrect a finished one-shot run", () => {
    // The bug this guards: resuming used to force "scheduled" unconditionally,
    // so a completed or failed one-shot task ran a second time.
    expect(pausedStatus({ status: "completed", recurrence: once }, false)).toBe("completed")
    expect(pausedStatus({ status: "failed", recurrence: once }, false)).toBe("failed")
  })

  test("does not disturb a run that is currently executing", () => {
    expect(pausedStatus({ status: "running", recurrence: once }, false)).toBe("running")
  })

  test("a one-shot task with no recurrence behaves like an explicit once", () => {
    expect(pausedStatus({ status: "completed", recurrence: undefined }, false)).toBe("completed")
    expect(pausedStatus({ status: "canceled", recurrence: undefined }, false)).toBe("scheduled")
  })

  test("re-arms a recurring task even from a terminal state", () => {
    // A pause straddling a run leaves a recurring task "completed" (the
    // completion handler only reschedules when !paused), so resuming has to
    // put it back on the schedule or the task is silently dead forever.
    expect(pausedStatus({ status: "completed", recurrence: daily }, false)).toBe("scheduled")
    expect(pausedStatus({ status: "failed", recurrence: daily }, false)).toBe("scheduled")
    expect(pausedStatus({ status: "canceled", recurrence: daily }, false)).toBe("scheduled")
  })
})

describe("advanceSchedule — recurrence arithmetic", () => {
  test("daily keeps the same wall-clock time across spring forward", () => {
    // Clocks jump forward at 02:00 on 2026-03-08 in New York, so 09:00 the next
    // morning is only 23 real hours away — the proof this is wall-clock
    // arithmetic and not "the last run plus 24 hours".
    const report = inNewYork(`
      const slot = new Date(2026, 2, 7, 9, 0, 0, 0)
      const advanced = advanceSchedule({ kind: "daily", time: "09:00" }, slot, slot)
      return {
        day: advanced.next.getDate(),
        hours: advanced.next.getHours(),
        minutes: advanced.next.getMinutes(),
        elapsedHours: (advanced.next.getTime() - slot.getTime()) / 3600000,
      }
    `)
    expect(report).toEqual({ day: 8, hours: 9, minutes: 0, elapsedHours: 23 })
  })

  test("daily keeps the same wall-clock time across fall back", () => {
    // Clocks go back at 02:00 on 2026-11-01 in New York: a 25-hour day.
    const report = inNewYork(`
      const slot = new Date(2026, 9, 31, 9, 0, 0, 0)
      const advanced = advanceSchedule({ kind: "daily", time: "09:00" }, slot, slot)
      return {
        month: advanced.next.getMonth(),
        day: advanced.next.getDate(),
        hours: advanced.next.getHours(),
        minutes: advanced.next.getMinutes(),
        elapsedHours: (advanced.next.getTime() - slot.getTime()) / 3600000,
      }
    `)
    expect(report).toEqual({ month: 10, day: 1, hours: 9, minutes: 0, elapsedHours: 25 })
  })

  test("a weekly task still lands on its weekday across the same boundary", () => {
    const report = inNewYork(`
      const slot = new Date(2026, 9, 26, 9, 0, 0, 0)
      const advanced = advanceSchedule({ kind: "weekly", weekday: 1, time: "09:00" }, slot, slot)
      return {
        weekday: advanced.next.getDay(),
        month: advanced.next.getMonth(),
        day: advanced.next.getDate(),
        hours: advanced.next.getHours(),
      }
    `)
    expect(report).toEqual({ weekday: 1, month: 10, day: 2, hours: 9 })
  })

  test("weekly picks the right weekday, a whole week on", () => {
    const slot = new Date(2026, 7, 17, 9, 0, 0, 0)
    expect(slot.getDay()).toBe(1)
    const advanced = advanceSchedule(mondays, slot, slot)
    expect(advanced?.next.getDay()).toBe(1)
    expect(advanced?.next.getDate()).toBe(24)
    expect(advanced?.next.getHours()).toBe(9)
  })

  test("weekly from a mid-week slot lands on the next Monday, not seven days out", () => {
    const advanced = advanceSchedule(mondays, new Date(2026, 7, 19, 9, 0, 0, 0), new Date(2026, 7, 19, 9, 0, 0, 0))
    expect(advanced?.next.getDay()).toBe(1)
    expect(advanced?.next.getDate()).toBe(24)
  })

  test("weekdays steps over the weekend", () => {
    const friday = new Date(2026, 7, 21, 9, 0, 0, 0)
    expect(friday.getDay()).toBe(5)
    const advanced = advanceSchedule(weekdays, friday, friday)
    expect(advanced?.next.getDay()).toBe(1)
    expect(advanced?.next.getDate()).toBe(24)
  })

  test("a late or long run does not drag the schedule later", () => {
    // Ran at 09:00, finished at 16:42. Anchoring on the slot instead of the
    // clock is what keeps tomorrow at 09:00 rather than 16:42.
    const advanced = advanceSchedule(daily, new Date(2026, 7, 19, 9, 0, 0, 0), new Date(2026, 7, 19, 16, 42, 0, 0))
    expect(advanced?.next.getDate()).toBe(20)
    expect(advanced?.next.getHours()).toBe(9)
    expect(advanced?.next.getMinutes()).toBe(0)
    expect(advanced?.skipped).toBe(0)
  })

  test("a window missed while the app was closed collapses into one occurrence", () => {
    const advanced = advanceSchedule(daily, new Date(2026, 7, 14, 9, 0, 0, 0), new Date(2026, 7, 19, 10, 0, 0, 0))
    expect(advanced?.next.getDate()).toBe(20)
    expect(advanced?.next.getHours()).toBe(9)
    // 15th, 16th, 17th, 18th and this morning's 19th all elapsed unrun.
    expect(advanced?.skipped).toBe(5)
  })

  test("a one-shot never advances", () => {
    expect(advanceSchedule(once, new Date(once.at), new Date(once.at))).toBeUndefined()
  })
})

describe("describeCatchUp", () => {
  test("stays quiet when nothing was missed", () => {
    expect(describeCatchUp({ missedRuns: undefined })).toBeUndefined()
    expect(describeCatchUp({ missedRuns: 0 })).toBeUndefined()
  })

  test("says how many runs were skipped", () => {
    expect(describeCatchUp({ missedRuns: 4 })).toContain("4 earlier runs were missed")
    expect(describeCatchUp({ missedRuns: 1 })).toContain("1 earlier run was")
  })
})

describe("scheduledAgentTargets", () => {
  test("reads a legacy single-directory record as one target", () => {
    expect(scheduledAgentTargets({ directory: "/repos/alpha" })).toEqual([{ directory: "/repos/alpha" }])
  })

  test("ignores an empty targets array rather than running nowhere", () => {
    expect(scheduledAgentTargets({ directory: "/repos/alpha", targets: [] })).toEqual([{ directory: "/repos/alpha" }])
  })
})

// --- Engine-level harness -------------------------------------------------
// Everything below drives the real scheduler with an injected clock, store and
// engine transport. Nothing sleeps: the injected delay advances the clock,
// which is also what settles the engine's active-session registry.

const ENGINE: ScheduledAgentEngine = { url: "http://127.0.0.1:4096", username: null, password: null }

const started: Array<{ stop: () => void }> = []
afterEach(() => started.splice(0).forEach((runtime) => runtime.stop()))

function harness(options: {
  at: Date
  records?: ScheduledAgentRecord[]
  failing?: string[]
  sessions?: Record<string, string>
  onActivePoll?: () => void
}) {
  const clock = { at: options.at }
  const persisted = { value: JSON.parse(JSON.stringify(options.records ?? [])) as unknown }
  const calls: string[] = []
  const aborted: string[] = []
  const sessionDirectory = new Map(Object.entries(options.sessions ?? {}))
  const promptedAt = new Map<string, number>()
  const created: string[] = []

  const runtime = createScheduledAgents({
    // Round-trips through JSON exactly as electron-store does, so a field this
    // module sets to undefined really does vanish from the stored record.
    store: {
      get: () => JSON.parse(JSON.stringify(persisted.value)),
      set: (_key, value) => {
        persisted.value = JSON.parse(JSON.stringify(value))
      },
    },
    now: () => new Date(clock.at),
    delay: async (milliseconds) => {
      clock.at = new Date(clock.at.getTime() + milliseconds)
    },
    request: async (_engine, path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`)
      if (path === "/api/session") {
        const id = `ses_new_${created.length + 1}`
        created.push(id)
        const body = init?.body as { location?: { directory?: string } } | undefined
        sessionDirectory.set(id, body?.location?.directory ?? "")
        return { data: { id } }
      }
      if (path === "/api/session/active") {
        options.onActivePoll?.()
        // A prompted session stays in the registry until the clock moves, which
        // it only does inside the injected delay — so every run is observed
        // active exactly once and then settles.
        return {
          data: Object.fromEntries(
            [...promptedAt].filter(([, at]) => clock.at.getTime() <= at).map(([id]) => [id, {}]),
          ),
        }
      }
      const match = /^\/api\/session\/([^/]+)\/([a-z]+)/.exec(path)
      const sessionId = decodeURIComponent(match?.[1] ?? "")
      if (match?.[2] === "prompt") {
        promptedAt.set(sessionId, clock.at.getTime())
        return {}
      }
      if (match?.[2] === "abort") {
        aborted.push(sessionId)
        promptedAt.delete(sessionId)
        return undefined
      }
      const failed = options.failing?.includes(sessionDirectory.get(sessionId) ?? "")
      return {
        data: [
          {
            info: {
              role: "assistant",
              error: failed ? { message: `boom in ${sessionDirectory.get(sessionId)}` } : undefined,
            },
          },
        ],
      }
    },
  })

  runtime.start(async () => ENGINE)
  started.push(runtime)
  return {
    runtime,
    clock,
    calls,
    aborted,
    created,
    record: (id = "task-1") => runtime.list().find((item) => item.id === id),
  }
}

function scheduledRecord(overrides: Partial<ScheduledAgentRecord>): ScheduledAgentRecord {
  return {
    id: "task-1",
    prompt: "Summarise what changed overnight.",
    directory: "/repos/alpha",
    runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
    status: "scheduled",
    createdAt: new Date(2026, 7, 1, 9, 0, 0, 0).toISOString(),
    ...overrides,
  }
}

describe("catching up after the app was closed", () => {
  test("runs once for the whole missed window and says how much it skipped", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10, 0, 0, 0),
      // Last fired five days ago; the machine was asleep since.
      records: [scheduledRecord({ recurrence: daily, runAt: new Date(2026, 7, 14, 9, 0, 0, 0).toISOString() })],
    })

    await harnessed.runtime.tick()

    expect(harnessed.calls.filter((call) => call === "POST /api/session")).toHaveLength(1)
    expect(harnessed.calls.filter((call) => call.endsWith("/prompt"))).toHaveLength(1)

    const record = harnessed.record()
    expect(record?.status).toBe("scheduled")
    expect(record?.missedRuns).toBe(5)
    expect(describeCatchUp(record ?? {})).toContain("5 earlier runs were missed")
    const next = new Date(record?.runAt ?? 0)
    expect(next.getDate()).toBe(20)
    expect(next.getHours()).toBe(9)
  })

  test("a second tick right afterwards does not fire the backlog again", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily, runAt: new Date(2026, 7, 14, 9, 0, 0, 0).toISOString() })],
    })

    await harnessed.runtime.tick()
    await harnessed.runtime.tick()
    await harnessed.runtime.tick()

    expect(harnessed.calls.filter((call) => call === "POST /api/session")).toHaveLength(1)
  })

  test("four late runs in a row never drag the daily time off 09:00", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily })],
    })

    const landed: number[] = []
    for (const _day of [1, 2, 3, 4]) {
      // Ticks are 20s apart and a run takes minutes, so every real run starts
      // late. "now + interval" scheduling would walk the time forward daily.
      harnessed.clock.at = new Date(Date.parse(harnessed.record()?.runAt ?? "") + 37 * 60_000)
      await harnessed.runtime.tick()
      landed.push(new Date(harnessed.record()?.runAt ?? 0).getHours())
    }

    expect(landed).toEqual([9, 9, 9, 9])
    expect(new Date(harnessed.record()?.runAt ?? 0).getMinutes()).toBe(0)
    expect(harnessed.record()?.missedRuns).toBeUndefined()
  })
})

describe("running across repositories", () => {
  const multiRepo = scheduledRecord({
    directory: "/repos/alpha",
    targets: [{ directory: "/repos/alpha" }, { directory: "/repos/beta" }, { directory: "/repos/gamma" }],
    recurrence: daily,
  })

  test("records one result per repository and one failure does not fail the rest", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [multiRepo],
      failing: ["/repos/beta"],
    })

    await harnessed.runtime.tick()

    const record = harnessed.record()
    expect(record?.results?.map((result) => [result.directory, result.status])).toEqual([
      ["/repos/alpha", "completed"],
      ["/repos/beta", "failed"],
      ["/repos/gamma", "completed"],
    ])
    // The whole task is not condemned by one repository, but the failure is
    // still on the record for the tray and the panel to show.
    expect(record?.status).toBe("scheduled")
    expect(record?.error).toBe("/repos/beta: boom in /repos/beta")
    expect(record?.results?.[1]?.error).toBe("boom in /repos/beta")
  })

  test("the healthy repositories are not blocked by the failing one", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [multiRepo],
      failing: ["/repos/alpha"],
    })

    await harnessed.runtime.tick()

    expect(harnessed.created).toHaveLength(3)
    expect(harnessed.calls.filter((call) => call.endsWith("/prompt"))).toHaveLength(3)
    expect(harnessed.record()?.results?.filter((result) => result.status === "completed")).toHaveLength(2)
  })

  test("every repository failing still keeps the schedule, carrying the error", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [multiRepo],
      failing: ["/repos/alpha", "/repos/beta", "/repos/gamma"],
    })

    await harnessed.runtime.tick()

    const record = harnessed.record()
    // A daily task that dies on one bad morning is not a schedule, so it goes
    // back to "scheduled" carrying the error rather than ending as "failed".
    expect(record?.status).toBe("scheduled")
    expect(record?.error).toContain("/repos/gamma: boom in /repos/gamma")
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(20)
  })

  test("a one-shot fan-out that fails everywhere ends failed", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ ...multiRepo, recurrence: undefined })],
      failing: ["/repos/alpha", "/repos/beta", "/repos/gamma"],
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.status).toBe("failed")
  })

  test("shows up under every repository it targets", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0), records: [multiRepo] })

    expect(harnessed.runtime.list({ directory: "/repos/gamma" })).toHaveLength(1)
    expect(harnessed.runtime.list({ directory: "/repos/delta" })).toHaveLength(0)
  })
})

describe("targeting an existing session", () => {
  test("continues the thread instead of opening a new session", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [
        scheduledRecord({
          recurrence: daily,
          targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }],
        }),
      ],
    })

    await harnessed.runtime.tick()

    expect(harnessed.created).toHaveLength(0)
    expect(harnessed.calls).not.toContain("POST /api/session")
    expect(harnessed.calls).toContain("POST /api/session/ses_established/prompt")
    expect(harnessed.record()?.results?.[0]?.sessionId).toBe("ses_established")
    expect(harnessed.record()?.sessionId).toBe("ses_established")
  })

  test("mixes an established thread with a fresh session in another repository", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [
        scheduledRecord({
          targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }, { directory: "/repos/beta" }],
        }),
      ],
    })

    await harnessed.runtime.tick()

    expect(harnessed.created).toEqual(["ses_new_1"])
    expect(harnessed.record()?.results?.map((result) => result.sessionId)).toEqual(["ses_established", "ses_new_1"])
  })

  test("create() keeps the session pin on a single-target task", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0) })

    const record = harnessed.runtime.create({
      prompt: "Keep the release notes up to date.",
      targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }],
      runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
      recurrence: daily,
    })

    expect(record.directory).toBe("/repos/alpha")
    expect(record.targets).toEqual([{ directory: "/repos/alpha", sessionId: "ses_established" }])
  })
})

describe("legacy single-directory records", () => {
  const legacy: ScheduledAgentRecord = {
    id: "task-legacy",
    title: "Morning brief",
    prompt: "Summarise what changed overnight.",
    directory: "/repos/legacy",
    recurrence: daily,
    paused: false,
    runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
    status: "scheduled",
    createdAt: "2026-08-01T12:00:00.000Z",
  }

  test("load and run without a migration step", async () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 9, 0, 0, 0), records: [legacy] })

    expect(harnessed.runtime.list({ directory: "/repos/legacy" })).toHaveLength(1)
    await harnessed.runtime.tick()

    const record = harnessed.record("task-legacy")
    expect(harnessed.created).toEqual(["ses_new_1"])
    expect(record?.directory).toBe("/repos/legacy")
    expect(record?.results?.map((result) => [result.directory, result.status])).toEqual([
      ["/repos/legacy", "completed"],
    ])
    expect(record?.status).toBe("scheduled")
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(20)
  })

  test("create() still writes the old shape for a plain one-directory task", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0) })

    const record = harnessed.runtime.create({
      prompt: "Check the dependencies.",
      directory: "/repos/legacy",
      runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
    })

    expect(record.directory).toBe("/repos/legacy")
    expect(record.targets).toBeUndefined()
  })

  test("a record left running by a crash is failed, and a recurring one is re-armed", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 12, 0, 0, 0),
      records: [{ ...legacy, status: "running", startedAt: legacy.runAt }],
    })

    const record = harnessed.runtime.list().at(0)
    expect(record?.error).toContain("Interrupted by app restart")
    expect(record?.status).toBe("scheduled")
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(20)
  })
})

describe("pause, resume and cancel", () => {
  test("a paused task does not run, and resuming re-arms it in the future", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily })],
    })

    expect(harnessed.runtime.setPaused("task-1", true).status).toBe("canceled")
    await harnessed.runtime.tick()
    expect(harnessed.calls).toHaveLength(0)
    expect(harnessed.runtime.workState().armedTasks).toBe(0)

    const resumed = harnessed.runtime.setPaused("task-1", false)
    expect(resumed.status).toBe("scheduled")
    // 09:00 today is already gone, so resuming must not park it in the past.
    expect(Date.parse(resumed.runAt)).toBeGreaterThan(harnessed.clock.at.getTime())
    await harnessed.runtime.tick()
    expect(harnessed.calls).toHaveLength(0)
    expect(harnessed.runtime.workState().armedTasks).toBe(1)
  })

  test("cancelling a scheduled task stops it from ever running", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily })],
    })

    expect((await harnessed.runtime.cancel("task-1"))?.status).toBe("canceled")
    await harnessed.runtime.tick()

    expect(harnessed.calls).toHaveLength(0)
  })

  test("cancelling mid-run aborts every repository's session and does not reschedule", async () => {
    const cancel = { fire: () => {} }
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [
        scheduledRecord({
          recurrence: daily,
          targets: [{ directory: "/repos/alpha" }, { directory: "/repos/beta" }],
        }),
      ],
      onActivePoll: () => cancel.fire(),
    })
    cancel.fire = () => void harnessed.runtime.cancel("task-1")

    await harnessed.runtime.tick()

    expect([...new Set(harnessed.aborted)].sort()).toEqual(["ses_new_1", "ses_new_2"])
    const record = harnessed.record()
    expect(record?.status).toBe("canceled")
    // Still the original slot: a cancelled run must not roll the task forward.
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(19)
  })

  test("removing a task drops it from the store", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0), records: [scheduledRecord({})] })

    expect(harnessed.runtime.remove("task-1")).toHaveLength(0)
    expect(harnessed.runtime.list()).toHaveLength(0)
  })
})

describe("manual runs and reporting", () => {
  test("running a task by hand does not shift its recurrence off 09:00", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 14, 30, 0, 0),
      records: [scheduledRecord({ recurrence: daily, runAt: new Date(2026, 7, 20, 9, 0, 0, 0).toISOString() })],
    })

    const pulled = harnessed.runtime.runNext()
    expect(pulled?.scheduledFor).toBe(new Date(2026, 7, 20, 9, 0, 0, 0).toISOString())
    await harnessed.runtime.tick()

    const next = new Date(harnessed.record()?.runAt ?? 0)
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
    // Tomorrow's occurrence is the one that was pulled forward, so the schedule
    // resumes the day after — never at 14:30.
    expect(next.getDate()).toBe(21)
    expect(harnessed.record()?.scheduledFor).toBeUndefined()
  })

  test("announces each finished run once, with the failure attached", async () => {
    const finished: Array<string | undefined> = []
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ targets: [{ directory: "/repos/alpha" }, { directory: "/repos/beta" }] })],
      failing: ["/repos/beta"],
    })
    harnessed.runtime.onRunFinished((record) => finished.push(record.error))

    await harnessed.runtime.tick()

    expect(finished).toEqual(["/repos/beta: boom in /repos/beta"])
  })

  test("work state counts armed tasks and the soonest run", () => {
    const soon = new Date(2026, 7, 19, 9, 0, 0, 0)
    const harnessed = harness({
      at: new Date(2026, 7, 19, 8, 0, 0, 0),
      records: [
        scheduledRecord({ id: "task-1", runAt: new Date(2026, 7, 19, 11, 0, 0, 0).toISOString() }),
        scheduledRecord({ id: "task-2", runAt: soon.toISOString() }),
      ],
    })

    expect(harnessed.runtime.workState().armedTasks).toBe(2)
    expect(harnessed.runtime.workState().nextRunAt).toBe(soon.getTime())
    expect(harnessed.runtime.workState().inFlightRuns).toBe(0)
  })
})
