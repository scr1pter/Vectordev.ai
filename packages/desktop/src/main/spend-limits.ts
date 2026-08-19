import { randomUUID } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const SPEND_LEDGER_FILE = "vector-spend-ledger.json"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_WARN_AT = 0.8
// The longest window any limit is evaluated over is the calendar month, so a
// raw event stops being needed once it is two months old. Folding it into a
// per-day, per-project total loses nothing a limit reads: a local calendar day
// never straddles a month boundary, and a run never spans days, so the day,
// month and per-project windows all reproduce exactly from day totals.
const RAW_EVENT_RETENTION_DAYS = 62
// A loop that spends without stopping is exactly what this file exists to
// catch, so raw events also have a hard ceiling. Crossing it folds every
// completed day early and merges what is left per run, so nothing is dropped
// and no total moves.
const MAX_RAW_EVENTS = 4_000
const DAY_TOTAL_RETENTION_DAYS = 400

export type SpendSource = "session" | "parallel" | "scheduled"

// One recorded observation of spend. `costUsd` is absent when the provider
// reported no usage at all — a free or zen model, or a provider that returns
// nothing. Such a run is unmeasured rather than free, so the field is never
// defaulted to 0: a zero would let unknown spend read as proof of cheapness,
// and would let a day of unmeasured runs sit under a cap it never tested.
export type SpendEvent = {
  id: string
  projectPath: string
  runId: string
  provider: string
  model: string
  costUsd?: number
  tokens?: number
  at: string
  source: SpendSource
}

export type SpendDayTotal = {
  day: string
  projectPath: string
  costUsd: number
  tokens: number
  runs: number
  unmeasuredRuns: number
}

export type SpendLimit = {
  // The hard stop. Reaching it blocks new runs and stops running ones.
  usd: number
  // Fraction of `usd` where the state turns to "warn", 0.8 unless set.
  warnAt?: number
}

export type SpendLimitSet = {
  // One run: one prompt-to-idle session turn, one parallel agent, or one
  // scheduled launch.
  perRun?: SpendLimit
  // Calendar day and calendar month in the user's own timezone, counting every
  // project — the provider bill this protects is account-wide.
  perDay?: SpendLimit
  perMonth?: SpendLimit
  // The same calendar month, counting only the project the run belongs to.
  perProjectMonth?: SpendLimit
}

export type SpendPolicy = {
  interactive: SpendLimitSet
  unattended: SpendLimitSet
}

export type SpendAllowanceInput = {
  projectPath: string
  runId: string
  source: SpendSource
  at?: Date
}

export type SpendAllowance = {
  allowed: boolean
  state: "ok" | "warn" | "blocked"
  reason?: string
  // Distance to the nearest configured limit. Absent when nothing is capped.
  remainingUsd?: number
  // Runs inside the evaluated windows that reported no usage at all. Their real
  // cost is unknown, so it is in no total above and can never block anything.
  unmeasuredRuns: number
  unmeasuredNote?: string
}

export type SpendWindowTotal = {
  costUsd: number
  tokens: number
  runs: number
  unmeasuredRuns: number
}

export type SpendSummary = {
  at: string
  day: string
  month: string
  all: { day: SpendWindowTotal; month: SpendWindowTotal }
  project?: { projectPath: string; day: SpendWindowTotal; month: SpendWindowTotal }
  policy: SpendPolicy
}

// Interactive work ships uncapped. The user is sitting in front of the cost
// readout while it runs, and a session that dies mid-task against a number set
// months ago and forgotten destroys work in progress for no safety gain.
// Unattended work ships capped, because a scheduled run spends while nobody is
// watching — a cap that exists only where the user is present is the one cap
// that never gets the chance to fire.
export const DEFAULT_SPEND_POLICY: SpendPolicy = {
  interactive: {},
  unattended: {
    perRun: { usd: 5 },
    perDay: { usd: 25 },
  },
}

// Windows are calendar windows in the user's own timezone: "today" has to reset
// at the user's midnight, not UTC's. Comparing the resulting YYYY-MM-DD keys as
// strings keeps month boundaries and DST shifts correct with no millisecond
// arithmetic anywhere.
export function localDayKey(at: Date) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
}

export function localMonthKey(at: Date) {
  return localDayKey(at).slice(0, 7)
}

export type SpendLedger = ReturnType<typeof createSpendLedger>

export function createSpendLedger(input: { userDataPath: string }) {
  const file = join(input.userDataPath, SPEND_LEDGER_FILE)
  let cached: Promise<SpendLedgerState> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const load = () => (cached ??= readLedger(file))

  // Every mutation runs through one chain. Up to sixteen parallel agents record
  // spend concurrently, and interleaved read-modify-write would drop events —
  // precisely the events a cap exists to count.
  const update = (change: (state: SpendLedgerState) => SpendLedgerState) => {
    const result = queue.then(async () => {
      const next = change(await load())
      cached = Promise.resolve(next)
      // A failed write must not fail the run that recorded the spend. The
      // in-memory state stays authoritative for the rest of this process.
      await writeLedger(file, next).catch(() => undefined)
      return next
    })
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const append = (event: SpendEvent, at: Date) =>
    update((state) => prune({ ...state, events: [...state.events, event] }, at))

  const recordSpend = async (spend: {
    projectPath: string
    runId: string
    provider: string
    model: string
    source: SpendSource
    // Omit for a run that reported nothing. See SpendEvent.
    costUsd?: number
    tokens?: number
    at?: Date
  }) => {
    const at = spend.at ?? new Date()
    const event: SpendEvent = {
      id: randomUUID(),
      projectPath: spend.projectPath,
      runId: spend.runId,
      provider: spend.provider,
      model: spend.model,
      source: spend.source,
      // Spend never runs backwards. A runtime reporting a negative cost is
      // reporting a parse failure, and subtracting it would hand back headroom
      // under a cap that has already been spent.
      costUsd: spend.costUsd === undefined || !Number.isFinite(spend.costUsd) ? undefined : Math.max(spend.costUsd, 0),
      tokens: spend.tokens === undefined || !Number.isFinite(spend.tokens) ? undefined : Math.max(spend.tokens, 0),
      at: at.toISOString(),
    }
    await append(event, at)
    return event
  }

  // Pollers hold a session's running total, not a delta, so this appends only
  // what is new since the last observation and is safe to call on every poll.
  // A total that has not moved appends nothing. An absent total means the
  // provider reported nothing, which is marked unmeasured exactly once — and
  // never once the run has already reported real cost.
  const recordRunCost = async (spend: {
    projectPath: string
    runId: string
    provider: string
    model: string
    source: SpendSource
    totalCostUsd?: number
    totalTokens?: number
    at?: Date
  }) => {
    const at = spend.at ?? new Date()
    const total = Number.isFinite(spend.totalCostUsd) ? spend.totalCostUsd : undefined
    const totalTokens = Number.isFinite(spend.totalTokens) ? spend.totalTokens : undefined
    // The delta is read and written inside the one mutation chain, not before
    // it. A run's last poll and its completion record do overlap in practice,
    // and computing the delta outside the chain lets both read the same base
    // total and each append the whole of it.
    let appended: SpendEvent | undefined
    await update((state) => {
      const recorded = state.events.filter((event) => event.runId === spend.runId)
      if (total === undefined && recorded.length) return state
      const costUsd =
        total === undefined ? undefined : Math.max(total - sum(recorded.map((event) => event.costUsd ?? 0)), 0)
      const tokens =
        total === undefined || totalTokens === undefined
          ? 0
          : Math.max(totalTokens - sum(recorded.map((event) => event.tokens ?? 0)), 0)
      if (costUsd !== undefined && costUsd <= 0 && tokens <= 0) return state
      appended = {
        id: randomUUID(),
        projectPath: spend.projectPath,
        runId: spend.runId,
        provider: spend.provider,
        model: spend.model,
        source: spend.source,
        costUsd,
        tokens: tokens > 0 ? tokens : undefined,
        at: at.toISOString(),
      }
      return prune({ ...state, events: [...state.events, appended] }, at)
    })
    return appended
  }

  const checkAllowance = async (allowance: SpendAllowanceInput): Promise<SpendAllowance> => {
    const state = await load()
    const at = allowance.at ?? new Date()
    // A scheduled run is the unattended case; a session or parallel agent was
    // launched by a user who is watching it.
    const limits = allowance.source === "scheduled" ? state.policy.unattended : state.policy.interactive
    const day = localDayKey(at)
    const month = localMonthKey(at)
    const monthTotal = windowTotal(state, { month })

    const checks = [
      {
        limit: limits.perRun,
        where: "on this run",
        spent: sum(state.events.filter((event) => event.runId === allowance.runId).map((event) => event.costUsd ?? 0)),
      },
      { limit: limits.perDay, where: "today", spent: windowTotal(state, { day }).costUsd },
      { limit: limits.perMonth, where: "this month", spent: monthTotal.costUsd },
      {
        limit: limits.perProjectMonth,
        where: "on this project this month",
        spent: windowTotal(state, { month, projectPath: allowance.projectPath }).costUsd,
      },
    ].filter((check): check is { limit: SpendLimit; where: string; spent: number } => Boolean(check.limit))

    // Unmeasured runs are reported against the widest window a limit can use,
    // so the status is honest about how much of the month it cannot see.
    const unmeasuredRuns = monthTotal.unmeasuredRuns
    const unmeasuredNote = unmeasuredRuns
      ? `${unmeasuredRuns} run${unmeasuredRuns === 1 ? "" : "s"} this month reported no usage. That spend is unmeasured rather than free, so it is in no total here and never blocks a run.`
      : undefined

    const blocked = checks.find((check) => check.spent >= check.limit.usd)
    if (blocked) {
      return {
        allowed: false,
        state: "blocked",
        reason: `Spend limit reached: ${formatUsd(blocked.spent)} spent ${blocked.where} against a ${formatUsd(blocked.limit.usd)} cap. Raise or clear the limit in Settings to continue.`,
        remainingUsd: 0,
        unmeasuredRuns,
        unmeasuredNote,
      }
    }

    const remainingUsd = checks.length ? Math.min(...checks.map((check) => check.limit.usd - check.spent)) : undefined
    const warned = checks.find((check) => check.spent >= check.limit.usd * warnAtOf(check.limit))
    if (warned) {
      return {
        allowed: true,
        state: "warn",
        reason: `Approaching a spend limit: ${formatUsd(warned.spent)} of ${formatUsd(warned.limit.usd)} spent ${warned.where}.`,
        remainingUsd,
        unmeasuredRuns,
        unmeasuredNote,
      }
    }
    return { allowed: true, state: "ok", remainingUsd, unmeasuredRuns, unmeasuredNote }
  }

  const summary = async (scope?: { projectPath?: string; at?: Date }): Promise<SpendSummary> => {
    const state = await load()
    const at = scope?.at ?? new Date()
    const day = localDayKey(at)
    const month = localMonthKey(at)
    return {
      at: at.toISOString(),
      day,
      month,
      all: { day: windowTotal(state, { day }), month: windowTotal(state, { month }) },
      project: scope?.projectPath
        ? {
            projectPath: scope.projectPath,
            day: windowTotal(state, { day, projectPath: scope.projectPath }),
            month: windowTotal(state, { month, projectPath: scope.projectPath }),
          }
        : undefined,
      policy: state.policy,
    }
  }

  return {
    checkAllowance,
    recordSpend,
    recordRunCost,
    summary,
    async policy() {
      return (await load()).policy
    },
    async setPolicy(next: Partial<SpendPolicy>) {
      const state = await update((current) => ({
        ...current,
        policy: {
          interactive: normalizeLimitSet(next.interactive ?? current.policy.interactive),
          unattended: normalizeLimitSet(next.unattended ?? current.policy.unattended),
        },
      }))
      return state.policy
    },
    async recentEvents(limit = 100) {
      return (await load()).events.slice(-limit).reverse()
    },
  }
}

let shared: Promise<SpendLedger> | undefined

// electron is imported here rather than at module scope because the userData
// path is only correct after index.ts has called app.setPath — the same
// constraint store.ts documents — and because it keeps this module importable
// by tests that never boot Electron.
export function spendLedger() {
  shared ??= createShared()
  return shared
}

async function createShared() {
  const { app } = await import("electron")
  return createSpendLedger({ userDataPath: app.getPath("userData") })
}

type SpendLedgerState = {
  version: 1
  events: SpendEvent[]
  days: SpendDayTotal[]
  policy: SpendPolicy
}

const emptyLedger = (): SpendLedgerState => ({
  version: 1,
  events: [],
  days: [],
  policy: DEFAULT_SPEND_POLICY,
})

async function readLedger(file: string): Promise<SpendLedgerState> {
  const raw = await readFile(file, "utf8").catch(() => "")
  if (!raw) return emptyLedger()
  const parsed = (() => {
    try {
      return JSON.parse(raw) as Partial<SpendLedgerState>
    } catch {
      return undefined
    }
  })()
  // An unreadable ledger starts over rather than blocking every run forever.
  // That loses history, which is why writes go through a temp file and a
  // rename: a half-written ledger should never exist to be read.
  if (!parsed) return emptyLedger()
  return {
    version: 1,
    // Rows are checked one by one for the same reason the parse is guarded. A
    // single corrupt row would otherwise either throw out of every allowance
    // check — blocking every run forever — or poison a total with NaN, and a
    // NaN total is never greater than a cap, so the cap silently stops firing.
    events: Array.isArray(parsed.events) ? parsed.events.filter(isSpendEvent) : [],
    days: Array.isArray(parsed.days) ? parsed.days.filter(isSpendDayTotal) : [],
    policy: {
      interactive: normalizeLimitSet(parsed.policy?.interactive ?? DEFAULT_SPEND_POLICY.interactive),
      unattended: normalizeLimitSet(parsed.policy?.unattended ?? DEFAULT_SPEND_POLICY.unattended),
    },
  }
}

const isAmount = (value: unknown) => typeof value === "number" && Number.isFinite(value)

function isSpendEvent(value: unknown): value is SpendEvent {
  if (typeof value !== "object" || value === null) return false
  if (!("runId" in value) || typeof value.runId !== "string") return false
  if (!("projectPath" in value) || typeof value.projectPath !== "string") return false
  // An unparseable date is worse than a missing row: it lands in no window, so
  // it is counted nowhere and folded away never.
  if (!("at" in value) || typeof value.at !== "string" || Number.isNaN(new Date(value.at).getTime())) return false
  if ("costUsd" in value && value.costUsd !== undefined && !isAmount(value.costUsd)) return false
  return !("tokens" in value) || value.tokens === undefined || isAmount(value.tokens)
}

function isSpendDayTotal(value: unknown): value is SpendDayTotal {
  if (typeof value !== "object" || value === null) return false
  if (!("day" in value) || typeof value.day !== "string") return false
  if (!("projectPath" in value) || typeof value.projectPath !== "string") return false
  if (!("costUsd" in value) || !isAmount(value.costUsd)) return false
  if (!("tokens" in value) || !isAmount(value.tokens)) return false
  if (!("runs" in value) || !isAmount(value.runs)) return false
  return "unmeasuredRuns" in value && isAmount(value.unmeasuredRuns)
}

async function writeLedger(file: string, state: SpendLedgerState) {
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(state), "utf8")
  await rename(temp, file)
}

function windowTotal(
  state: SpendLedgerState,
  filter: { day?: string; month?: string; projectPath?: string },
): SpendWindowTotal {
  const matches = (day: string, projectPath: string) =>
    (!filter.day || day === filter.day) &&
    (!filter.month || day.startsWith(filter.month)) &&
    (!filter.projectPath || projectPath === filter.projectPath)

  const days = state.days.filter((total) => matches(total.day, total.projectPath))
  const events = state.events.filter((event) => matches(localDayKey(new Date(event.at)), event.projectPath))
  const runs = new Set(events.map((event) => event.runId))
  const measured = new Set(events.filter((event) => event.costUsd !== undefined).map((event) => event.runId))

  return {
    costUsd: sum(days.map((day) => day.costUsd)) + sum(events.map((event) => event.costUsd ?? 0)),
    tokens: sum(days.map((day) => day.tokens)) + sum(events.map((event) => event.tokens ?? 0)),
    runs: sum(days.map((day) => day.runs)) + runs.size,
    // A run that reported cost even once is measured, so a late-reporting
    // provider retroactively stops counting against the unmeasured tally.
    unmeasuredRuns:
      sum(days.map((day) => day.unmeasuredRuns)) + [...runs].filter((runId) => !measured.has(runId)).length,
  }
}

// Folds completed days out of the raw event list into per-day, per-project
// totals. Today is never folded, so the per-run total of a run that is still
// going always reads from raw events and stays exact.
function prune(state: SpendLedgerState, at: Date): SpendLedgerState {
  const today = localDayKey(at)
  const overCeiling = state.events.length > MAX_RAW_EVENTS
  const foldBefore = overCeiling ? today : localDayKey(new Date(at.getTime() - RAW_EVENT_RETENTION_DAYS * DAY_MS))
  const fold = state.events.filter((event) => localDayKey(new Date(event.at)) < foldBefore)
  if (!fold.length && !overCeiling) return state

  const grouped = fold.reduce((groups, event) => {
    const day = localDayKey(new Date(event.at))
    const key = `${day} ${event.projectPath}`
    const bucket = groups.get(key) ?? { day, projectPath: event.projectPath, events: [] as SpendEvent[] }
    bucket.events.push(event)
    groups.set(key, bucket)
    return groups
  }, new Map<string, { day: string; projectPath: string; events: SpendEvent[] }>())

  const folded = [...grouped.values()].map((group) => {
    const existing = state.days.find((day) => day.day === group.day && day.projectPath === group.projectPath)
    const runs = new Set(group.events.map((event) => event.runId))
    const measured = new Set(group.events.filter((event) => event.costUsd !== undefined).map((event) => event.runId))
    return {
      day: group.day,
      projectPath: group.projectPath,
      costUsd: (existing?.costUsd ?? 0) + sum(group.events.map((event) => event.costUsd ?? 0)),
      tokens: (existing?.tokens ?? 0) + sum(group.events.map((event) => event.tokens ?? 0)),
      runs: (existing?.runs ?? 0) + runs.size,
      unmeasuredRuns: (existing?.unmeasuredRuns ?? 0) + [...runs].filter((runId) => !measured.has(runId)).length,
    }
  })

  const kept = state.events.filter((event) => localDayKey(new Date(event.at)) >= foldBefore)
  const oldestDay = localDayKey(new Date(at.getTime() - DAY_TOTAL_RETENTION_DAYS * DAY_MS))
  return {
    ...state,
    // Folding completed days cannot bound a day that is still going, and a
    // swarm polling sixteen runs crosses the ceiling inside one afternoon.
    // Collapsing the survivors instead keeps the file proportional to the
    // number of runs rather than the number of polls.
    events: overCeiling ? collapse(kept) : kept,
    days: [...state.days.filter((day) => !grouped.has(`${day.day} ${day.projectPath}`)), ...folded]
      .filter((day) => day.day >= oldestDay)
      .sort((a, b) => (a.day === b.day ? a.projectPath.localeCompare(b.projectPath) : a.day.localeCompare(b.day))),
  }
}

// Merges the events that every total already reads as one: same run, same day,
// same project, provider, model and source. Per-run, per-day and per-month
// amounts come out identical, and a run stays unmeasured only when none of its
// merged events reported cost.
function collapse(events: SpendEvent[]) {
  const grouped = events.reduce((groups, event) => {
    // A project path can hold any character a filesystem allows, so the parts
    // join on one none of them can contain.
    const key = [
      localDayKey(new Date(event.at)),
      event.runId,
      event.projectPath,
      event.provider,
      event.model,
      event.source,
    ].join("\u0000")
    const bucket = groups.get(key) ?? []
    bucket.push(event)
    groups.set(key, bucket)
    return groups
  }, new Map<string, SpendEvent[]>())

  return [...grouped.values()]
    .map((group) => {
      const measured = group.filter((event) => event.costUsd !== undefined)
      const counted = group.filter((event) => event.tokens !== undefined)
      return {
        ...group[group.length - 1],
        costUsd: measured.length ? sum(measured.map((event) => event.costUsd ?? 0)) : undefined,
        tokens: counted.length ? sum(counted.map((event) => event.tokens ?? 0)) : undefined,
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at))
}

function normalizeLimitSet(set: SpendLimitSet): SpendLimitSet {
  return {
    perRun: normalizeLimit(set.perRun),
    perDay: normalizeLimit(set.perDay),
    perMonth: normalizeLimit(set.perMonth),
    perProjectMonth: normalizeLimit(set.perProjectMonth),
  }
}

// A limit whose amount is not a real, non-negative number is not a limit.
// Dropping it is the only safe reading: persisting it would block every run
// against a value the user never chose. An explicit 0 is kept, because "spend
// nothing here" is a real instruction.
function normalizeLimit(limit: SpendLimit | undefined): SpendLimit | undefined {
  if (!limit || !Number.isFinite(limit.usd) || limit.usd < 0) return undefined
  const warnAt = limit.warnAt
  if (warnAt === undefined || !Number.isFinite(warnAt)) return { usd: limit.usd }
  return { usd: limit.usd, warnAt: Math.min(Math.max(warnAt, 0), 1) }
}

const warnAtOf = (limit: SpendLimit) =>
  limit.warnAt === undefined || !Number.isFinite(limit.warnAt) ? DEFAULT_WARN_AT : limit.warnAt

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

// Matches the session cost readout: sub-cent amounts keep four decimals so a
// real but tiny spend never renders as $0.00.
const formatUsd = (value: number) => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
