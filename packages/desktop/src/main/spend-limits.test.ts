import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SPEND_POLICY,
  SPEND_LEDGER_FILE,
  createSpendLedger,
  localDayKey,
  localMonthKey,
  type SpendSource,
} from "./spend-limits"

const PROJECT = "/tmp/vector-project-a"
const OTHER_PROJECT = "/tmp/vector-project-b"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function newLedger() {
  const directory = await mkdtemp(join(tmpdir(), "vector-spend-"))
  directories.push(directory)
  return { directory, ledger: createSpendLedger({ userDataPath: directory }) }
}

async function persistedState(directory: string) {
  return JSON.parse(await readFile(join(directory, SPEND_LEDGER_FILE), "utf8")) as {
    events: unknown[]
    days: { day: string; projectPath: string; costUsd: number; unmeasuredRuns: number }[]
  }
}

function spender(ledger: Awaited<ReturnType<typeof newLedger>>["ledger"], source: SpendSource = "scheduled") {
  return (input: { runId: string; costUsd?: number; tokens?: number; at: Date; projectPath?: string }) =>
    ledger.recordSpend({
      projectPath: input.projectPath ?? PROJECT,
      runId: input.runId,
      provider: "anthropic",
      model: "claude-sonnet",
      source,
      costUsd: input.costUsd,
      tokens: input.tokens,
      at: input.at,
    })
}

describe("accumulating spend", () => {
  test("crosses the warn threshold, then the hard stop", async () => {
    const { ledger } = await newLedger()
    await ledger.setPolicy({ unattended: { perDay: { usd: 10 } } })
    const at = new Date(2026, 7, 19, 10, 0)
    const spend = spender(ledger)
    const check = () => ledger.checkAllowance({ projectPath: PROJECT, runId: "next", source: "scheduled", at })

    await spend({ runId: "run-1", costUsd: 4, at })
    const ok = await check()
    expect(ok.allowed).toBe(true)
    expect(ok.state).toBe("ok")
    expect(ok.remainingUsd).toBe(6)
    expect(ok.reason).toBeUndefined()

    await spend({ runId: "run-2", costUsd: 4.5, at })
    const warn = await check()
    expect(warn.allowed).toBe(true)
    expect(warn.state).toBe("warn")
    expect(warn.remainingUsd).toBe(1.5)
    expect(warn.reason).toContain("$8.50")
    expect(warn.reason).toContain("$10.00")

    await spend({ runId: "run-3", costUsd: 2, at })
    const blocked = await check()
    expect(blocked.allowed).toBe(false)
    expect(blocked.state).toBe("blocked")
    expect(blocked.remainingUsd).toBe(0)
    expect(blocked.reason).toContain("today")
  })

  test("warns at the threshold the limit chose, not the default", async () => {
    const { ledger } = await newLedger()
    await ledger.setPolicy({ unattended: { perDay: { usd: 10, warnAt: 0.5 } } })
    const at = new Date(2026, 7, 19, 10, 0)
    await spender(ledger)({ runId: "run-1", costUsd: 5, at })
    expect((await ledger.checkAllowance({ projectPath: PROJECT, runId: "next", source: "scheduled", at })).state).toBe(
      "warn",
    )
  })

  test("a per-run cap stops one run without touching the next", async () => {
    const { ledger } = await newLedger()
    await ledger.setPolicy({ unattended: { perRun: { usd: 5 } } })
    const at = new Date(2026, 7, 19, 10, 0)
    await spender(ledger)({ runId: "long-run", costUsd: 6, at })

    const running = await ledger.checkAllowance({ projectPath: PROJECT, runId: "long-run", source: "scheduled", at })
    expect(running.allowed).toBe(false)
    expect(running.reason).toContain("on this run")

    const fresh = await ledger.checkAllowance({ projectPath: PROJECT, runId: "new-run", source: "scheduled", at })
    expect(fresh.allowed).toBe(true)
    expect(fresh.state).toBe("ok")
  })
})

describe("unmeasured runs", () => {
  test("never trip a cap and are reported apart from real spend", async () => {
    const { ledger } = await newLedger()
    await ledger.setPolicy({ unattended: { perDay: { usd: 1 }, perRun: { usd: 1 } } })
    const at = new Date(2026, 7, 19, 10, 0)
    const spend = spender(ledger)
    for (const index of [1, 2, 3, 4, 5]) await spend({ runId: `zen-${index}`, at })

    const allowance = await ledger.checkAllowance({ projectPath: PROJECT, runId: "zen-6", source: "scheduled", at })
    expect(allowance.allowed).toBe(true)
    expect(allowance.state).toBe("ok")
    expect(allowance.unmeasuredRuns).toBe(5)
    expect(allowance.unmeasuredNote).toContain("unmeasured rather than free")

    const summary = await ledger.summary({ at })
    expect(summary.all.day.costUsd).toBe(0)
    expect(summary.all.day.runs).toBe(5)
    expect(summary.all.day.unmeasuredRuns).toBe(5)

    // Real spend still blocks, and the unmeasured runs stay visible beside it
    // rather than being quietly folded into the total that did the blocking.
    await spend({ runId: "paid", costUsd: 1.25, at })
    const blocked = await ledger.checkAllowance({ projectPath: PROJECT, runId: "zen-7", source: "scheduled", at })
    expect(blocked.allowed).toBe(false)
    expect(blocked.unmeasuredRuns).toBe(5)
    expect(blocked.unmeasuredNote).toContain("never blocks a run")
  })

  test("a run that reports late stops counting as unmeasured", async () => {
    const { ledger } = await newLedger()
    const at = new Date(2026, 7, 19, 10, 0)
    const poll = (totalCostUsd?: number) =>
      ledger.recordRunCost({
        projectPath: PROJECT,
        runId: "slow-reporter",
        provider: "anthropic",
        model: "claude-sonnet",
        source: "scheduled",
        totalCostUsd,
        at,
      })

    await poll(undefined)
    await poll(undefined)
    expect((await ledger.summary({ at })).all.day.unmeasuredRuns).toBe(1)

    await poll(2)
    const summary = await ledger.summary({ at })
    expect(summary.all.day.unmeasuredRuns).toBe(0)
    expect(summary.all.day.costUsd).toBe(2)
    expect(summary.all.day.runs).toBe(1)
  })
})

describe("calendar windows", () => {
  test("a new day resets the daily window but not the month", async () => {
    const { ledger } = await newLedger()
    await ledger.setPolicy({ unattended: { perDay: { usd: 10 }, perMonth: { usd: 100 } } })
    const monday = new Date(2026, 7, 17, 22, 0)
    const tuesday = new Date(2026, 7, 18, 9, 0)
    await spender(ledger)({ runId: "run-1", costUsd: 12, at: monday })

    expect(
      (await ledger.checkAllowance({ projectPath: PROJECT, runId: "next", source: "scheduled", at: monday })).allowed,
    ).toBe(false)

    const nextDay = await ledger.checkAllowance({
      projectPath: PROJECT,
      runId: "next",
      source: "scheduled",
      at: tuesday,
    })
    expect(nextDay.allowed).toBe(true)
    expect(nextDay.state).toBe("ok")

    const summary = await ledger.summary({ at: tuesday })
    expect(summary.all.day.costUsd).toBe(0)
    expect(summary.all.month.costUsd).toBe(12)
  })

  // Local-calendar correctness is invisible in UTC, where the local day and the
  // UTC day coincide, so these run against a fixed half-hour-offset zone.
  // process.env.TZ is the only way to move the runtime's local time.
  describe("in a non-UTC timezone", () => {
    const originalTimezone = process.env.TZ

    beforeEach(() => {
      process.env.TZ = "Asia/Kolkata"
    })

    afterEach(() => {
      if (originalTimezone === undefined) {
        delete process.env.TZ
        return
      }
      process.env.TZ = originalTimezone
    })

    test("day and month keys follow the user's midnight, not UTC's", () => {
      expect(localDayKey(new Date(Date.UTC(2026, 6, 31, 19, 0)))).toBe("2026-08-01")
      expect(localMonthKey(new Date(Date.UTC(2026, 6, 31, 19, 0)))).toBe("2026-08")
      expect(localDayKey(new Date(Date.UTC(2026, 6, 31, 18, 0)))).toBe("2026-07-31")
      expect(localMonthKey(new Date(Date.UTC(2026, 6, 31, 18, 0)))).toBe("2026-07")
    })

    test("a month boundary starts the monthly window over", async () => {
      const { ledger } = await newLedger()
      await ledger.setPolicy({ unattended: { perMonth: { usd: 10 } } })
      const lastNightOfJuly = new Date(Date.UTC(2026, 6, 31, 18, 0))
      const firstMinutesOfAugust = new Date(Date.UTC(2026, 6, 31, 19, 0))
      const spend = spender(ledger)

      await spend({ runId: "july-1", costUsd: 7, at: new Date(Date.UTC(2026, 6, 1, 6, 0)) })
      await spend({ runId: "july-2", costUsd: 5, at: lastNightOfJuly })

      const july = await ledger.checkAllowance({
        projectPath: PROJECT,
        runId: "next",
        source: "scheduled",
        at: lastNightOfJuly,
      })
      expect(july.allowed).toBe(false)
      expect(july.reason).toContain("this month")

      // One hour later on the wall clock, and the cap is clear again: these two
      // events are 60 minutes apart but land in different calendar months.
      const august = await ledger.checkAllowance({
        projectPath: PROJECT,
        runId: "next",
        source: "scheduled",
        at: firstMinutesOfAugust,
      })
      expect(august.allowed).toBe(true)
      expect(august.remainingUsd).toBe(10)

      expect((await ledger.summary({ at: lastNightOfJuly })).all.month.costUsd).toBe(12)
      expect((await ledger.summary({ at: firstMinutesOfAugust })).all.month.costUsd).toBe(0)
    })
  })
})

describe("per-project scope", () => {
  test("one project's budget cannot be spent by another", async () => {
    const { ledger } = await newLedger()
    await ledger.setPolicy({ unattended: { perProjectMonth: { usd: 5 } } })
    const at = new Date(2026, 7, 19, 10, 0)
    const spend = spender(ledger)
    await spend({ runId: "a-1", costUsd: 6, at })
    await spend({ runId: "b-1", costUsd: 1, at, projectPath: OTHER_PROJECT })

    expect((await ledger.checkAllowance({ projectPath: PROJECT, runId: "a-2", source: "scheduled", at })).allowed).toBe(
      false,
    )
    const other = await ledger.checkAllowance({
      projectPath: OTHER_PROJECT,
      runId: "b-2",
      source: "scheduled",
      at,
    })
    expect(other.allowed).toBe(true)
    expect(other.remainingUsd).toBe(4)

    const summary = await ledger.summary({ at, projectPath: OTHER_PROJECT })
    expect(summary.all.month.costUsd).toBe(7)
    expect(summary.project?.month.costUsd).toBe(1)
  })

  test("an account-wide daily cap still counts every project", async () => {
    const { ledger } = await newLedger()
    await ledger.setPolicy({ unattended: { perDay: { usd: 5 } } })
    const at = new Date(2026, 7, 19, 10, 0)
    const spend = spender(ledger)
    await spend({ runId: "a-1", costUsd: 3, at })
    await spend({ runId: "b-1", costUsd: 3, at, projectPath: OTHER_PROJECT })

    expect(
      (await ledger.checkAllowance({ projectPath: OTHER_PROJECT, runId: "b-2", source: "scheduled", at })).allowed,
    ).toBe(false)
  })
})

describe("retention", () => {
  test("rolling old events into daily totals preserves every window", async () => {
    const { directory, ledger } = await newLedger()
    const april9 = new Date(2026, 3, 9, 12, 0)
    const april10 = new Date(2026, 3, 10, 12, 0)
    const spend = spender(ledger)
    await spend({ runId: "a-1", costUsd: 1.5, tokens: 12_000, at: april9 })
    await spend({ runId: "a-2", costUsd: 2.25, tokens: 30_000, at: april10 })
    await spend({ runId: "a-3", at: april10 })
    await spend({ runId: "b-1", costUsd: 0.75, tokens: 4_000, at: april10, projectPath: OTHER_PROJECT })

    const beforeDay = await ledger.summary({ at: april10, projectPath: PROJECT })
    const beforeMonth = await ledger.summary({ at: april9 })
    expect((await persistedState(directory)).events).toHaveLength(4)

    // Recording months later is what folds the April events away.
    await spend({ runId: "today", costUsd: 0.1, at: new Date(2026, 7, 19, 12, 0) })

    const persisted = await persistedState(directory)
    expect(persisted.events).toHaveLength(1)
    expect(persisted.days.map((day) => `${day.day} ${day.projectPath}`).sort()).toEqual([
      `2026-04-09 ${PROJECT}`,
      `2026-04-10 ${PROJECT}`,
      `2026-04-10 ${OTHER_PROJECT}`,
    ])

    expect(await ledger.summary({ at: april10, projectPath: PROJECT })).toEqual(beforeDay)
    expect(await ledger.summary({ at: april9 })).toEqual(beforeMonth)
    expect(beforeMonth.all.month.costUsd).toBe(4.5)
    expect(beforeMonth.all.month.tokens).toBe(46_000)
    expect(beforeMonth.all.month.runs).toBe(4)
    expect(beforeMonth.all.month.unmeasuredRuns).toBe(1)
  })

  // Folding completed days does nothing for a flood inside a single day, which
  // is the shape a runaway swarm actually has. Seeding the file is how this
  // reaches the ceiling without four thousand real writes.
  test("a single day past the raw-event ceiling collapses without moving a total", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vector-spend-"))
    directories.push(directory)
    const at = new Date(2026, 7, 19, 12, 0)
    await writeFile(
      join(directory, SPEND_LEDGER_FILE),
      JSON.stringify({
        version: 1,
        days: [],
        policy: DEFAULT_SPEND_POLICY,
        events: Array.from({ length: 4_001 }, (_, index) => ({
          id: `seed-${index}`,
          projectPath: PROJECT,
          runId: `run-${index % 200}`,
          provider: "anthropic",
          model: "claude-sonnet",
          costUsd: index % 200 === 0 ? undefined : 0.01,
          tokens: 10,
          at: new Date(2026, 7, 19, 11, 0).toISOString(),
          source: "parallel",
        })),
      }),
    )

    const ledger = createSpendLedger({ userDataPath: directory })
    await ledger.recordSpend({
      projectPath: PROJECT,
      runId: "run-0",
      provider: "anthropic",
      model: "claude-sonnet",
      source: "parallel",
      costUsd: 1,
      at,
    })

    const persisted = await persistedState(directory)
    expect(persisted.events).toHaveLength(200)
    expect(persisted.days).toHaveLength(0)

    // 4001 seeds: 21 events on run-0 unmeasured, the other 3980 at $0.01, plus
    // the $1 just recorded. Every total has to come out unchanged.
    const summary = await ledger.summary({ at, projectPath: PROJECT })
    expect(summary.all.day.costUsd).toBeCloseTo(3_980 * 0.01 + 1, 6)
    expect(summary.all.day.tokens).toBe(4_001 * 10)
    expect(summary.all.day.runs).toBe(200)
    // run-0 reported real cost at the end, so nothing is left unmeasured.
    expect(summary.all.day.unmeasuredRuns).toBe(0)
    expect(summary.project?.day).toEqual(summary.all.day)

    // The per-run window still reads exactly, which is what the collapse must
    // not cost: run-1 holds 20 events of $0.01.
    await ledger.setPolicy({ interactive: { perRun: { usd: 0.15 } } })
    const spent = await ledger.checkAllowance({ projectPath: PROJECT, runId: "run-1", source: "parallel", at })
    expect(spent.allowed).toBe(false)
    expect(spent.reason).toContain("on this run")
  })

  test("today is never folded, so a running run keeps an exact per-run total", async () => {
    const { directory, ledger } = await newLedger()
    const at = new Date(2026, 7, 19, 12, 0)
    const spend = spender(ledger)
    await spend({ runId: "old", costUsd: 1, at: new Date(2026, 3, 10, 12, 0) })
    await spend({ runId: "live", costUsd: 2, at })
    await spend({ runId: "live", costUsd: 3, at })

    expect((await persistedState(directory)).events).toHaveLength(2)
    await ledger.setPolicy({ unattended: { perRun: { usd: 5 } } })
    const allowance = await ledger.checkAllowance({ projectPath: PROJECT, runId: "live", source: "scheduled", at })
    expect(allowance.allowed).toBe(false)
    expect(allowance.reason).toContain("$5.00")
  })
})

describe("policy", () => {
  test("interactive work ships uncapped and unattended work ships capped", async () => {
    expect(DEFAULT_SPEND_POLICY.interactive.perRun).toBeUndefined()
    expect(DEFAULT_SPEND_POLICY.interactive.perDay).toBeUndefined()
    expect(DEFAULT_SPEND_POLICY.interactive.perMonth).toBeUndefined()
    expect(DEFAULT_SPEND_POLICY.unattended.perRun?.usd).toBeGreaterThan(0)
    expect(DEFAULT_SPEND_POLICY.unattended.perDay?.usd).toBeGreaterThan(0)

    const { ledger } = await newLedger()
    const at = new Date(2026, 7, 19, 10, 0)
    await spender(ledger, "session")({ runId: "session-run", costUsd: 5_000, at })

    const interactive = await ledger.checkAllowance({ projectPath: PROJECT, runId: "next", source: "session", at })
    expect(interactive.allowed).toBe(true)
    expect(interactive.state).toBe("ok")
    expect(interactive.remainingUsd).toBeUndefined()

    // The same ledger, the same spend: the run nobody is watching is the one
    // that gets stopped.
    const unattended = await ledger.checkAllowance({ projectPath: PROJECT, runId: "next", source: "scheduled", at })
    expect(unattended.allowed).toBe(false)
  })

  test("clearing a limit set allows everything again", async () => {
    const { ledger } = await newLedger()
    const at = new Date(2026, 7, 19, 10, 0)
    await ledger.setPolicy({ unattended: { perDay: { usd: 1 } } })
    await spender(ledger)({ runId: "run-1", costUsd: 4, at })
    expect(
      (await ledger.checkAllowance({ projectPath: PROJECT, runId: "next", source: "scheduled", at })).allowed,
    ).toBe(false)

    await ledger.setPolicy({ unattended: {} })
    const cleared = await ledger.checkAllowance({ projectPath: PROJECT, runId: "next", source: "scheduled", at })
    expect(cleared.allowed).toBe(true)
    expect(cleared.state).toBe("ok")
    expect(cleared.remainingUsd).toBeUndefined()
  })

  test("an unusable amount is dropped rather than persisted as a cap", async () => {
    const { ledger } = await newLedger()
    const policy = await ledger.setPolicy({
      unattended: { perDay: { usd: Number.NaN }, perMonth: { usd: -5 }, perRun: { usd: 3, warnAt: 4 } },
    })
    expect(policy.unattended.perDay).toBeUndefined()
    expect(policy.unattended.perMonth).toBeUndefined()
    expect(policy.unattended.perRun).toEqual({ usd: 3, warnAt: 1 })
  })
})

describe("durability", () => {
  test("concurrent agents cannot lose each other's events", async () => {
    const { ledger } = await newLedger()
    const at = new Date(2026, 7, 19, 10, 0)
    const spend = spender(ledger, "parallel")
    await Promise.all(Array.from({ length: 16 }, (_, index) => spend({ runId: `agent-${index}`, costUsd: 0.5, at })))

    const summary = await ledger.summary({ at })
    expect(summary.all.day.runs).toBe(16)
    expect(summary.all.day.costUsd).toBe(8)
  })

  // A run's last poll and its completion record overlap, and both hand over the
  // run's cumulative total rather than a delta.
  test("overlapping reports of one run's total are not counted twice", async () => {
    const { ledger } = await newLedger()
    const at = new Date(2026, 7, 19, 10, 0)
    const report = (totalCostUsd: number) =>
      ledger.recordRunCost({
        projectPath: PROJECT,
        runId: "one-run",
        provider: "anthropic",
        model: "claude-sonnet",
        source: "parallel",
        totalCostUsd,
        totalTokens: 5_000,
        at,
      })

    await Promise.all([report(3), report(3), report(3)])
    const summary = await ledger.summary({ at })
    expect(summary.all.day.costUsd).toBe(3)
    expect(summary.all.day.tokens).toBe(5_000)
    expect(summary.all.day.runs).toBe(1)
  })

  // The reader already refuses to let a corrupt ledger block every run. A row
  // that survives JSON.parse but holds the wrong type has to be refused too:
  // a non-number poisons a total with NaN, and NaN is never over a cap.
  test("a corrupt row neither throws nor quietly switches a cap off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vector-spend-"))
    directories.push(directory)
    const at = new Date(2026, 7, 19, 10, 0)
    await writeFile(
      join(directory, SPEND_LEDGER_FILE),
      JSON.stringify({
        version: 1,
        policy: { interactive: {}, unattended: { perDay: { usd: 25 } } },
        events: [null, "garbage", { id: "x", projectPath: PROJECT, runId: "r", at: "not-a-date", source: "scheduled" }],
        days: [
          null,
          { day: "2026-08-19", projectPath: PROJECT, costUsd: "1000", tokens: 0, runs: 1, unmeasuredRuns: 0 },
        ],
      }),
    )

    const ledger = createSpendLedger({ userDataPath: directory })
    expect((await ledger.summary({ at })).all.day.costUsd).toBe(0)

    await spender(ledger)({ runId: "real", costUsd: 30, at })
    const allowance = await ledger.checkAllowance({ projectPath: PROJECT, runId: "next", source: "scheduled", at })
    expect(allowance.allowed).toBe(false)
    expect(allowance.reason).toContain("$30.00")
  })

  test("spend and limits survive a restart", async () => {
    const { directory, ledger } = await newLedger()
    const at = new Date(2026, 7, 19, 10, 0)
    await ledger.setPolicy({ unattended: { perDay: { usd: 10 } } })
    await spender(ledger)({ runId: "run-1", costUsd: 9.5, at })

    const restarted = createSpendLedger({ userDataPath: directory })
    expect((await restarted.policy()).unattended.perDay?.usd).toBe(10)
    const allowance = await restarted.checkAllowance({ projectPath: PROJECT, runId: "next", source: "scheduled", at })
    expect(allowance.state).toBe("warn")
    expect(allowance.remainingUsd).toBe(0.5)
  })

  test("a ledger that has never been written allows and reports nothing", async () => {
    const { ledger } = await newLedger()
    const at = new Date(2026, 7, 19, 10, 0)
    const allowance = await ledger.checkAllowance({ projectPath: PROJECT, runId: "first", source: "scheduled", at })
    expect(allowance.allowed).toBe(true)
    expect(allowance.state).toBe("ok")
    expect(allowance.unmeasuredRuns).toBe(0)
    expect((await ledger.summary({ at })).all.month.costUsd).toBe(0)
  })
})
