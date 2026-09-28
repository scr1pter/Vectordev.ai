export * as SpendGuard from "./spend-guard"

// What a run may spend and when it must stop. A run belongs to a root session; subagent sessions link to it, so
// their spend counts against the root. The guard counts money as it is spent and never reads session.cost, so a
// revert cannot lower what a run has spent. The rules are pure; the service keeps one run per root in memory.
// Vectorscope shares costKindOf and priceOf, so a review and the run guard agree on which models can be priced.

import { Context, Effect, Layer, Ref } from "effect"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import type { SessionID } from "@vectordevai/schema/session-id"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { NEXT_STEP_SLACK, nextStepCostUsd, type ReviewPrice } from "./review/plan"
import type { CostKind } from "./review/types"

export type { CostKind }

// review/types stays import-free for the desktop renderer, so its CostKind is held equal to the schema's here.
const costKindMatchesSchema: [CostKind] extends [RunBudget.CostKind]
  ? [RunBudget.CostKind] extends [CostKind]
    ? true
    : never
  : never = true

export const WARN_AT = 0.8
export const UNPRICED_STEPS = 40
export const LOOP_REPEATS = 3
export const LOOP_WINDOW = 8
export const ERROR_STREAK = 3
// Finished runs kept for snapshot(); the oldest is dropped first.
export const LAST_RUNS = 200

// The order matters: a free model with a catalog price is still free, and an OAuth plan with a catalog price is
// billed by the plan, not per token.
export function costKindOf(input: { free: boolean; listed: boolean; oauthPlan: boolean }): CostKind {
  if (input.free) return "free"
  if (input.oauthPlan) return "plan"
  if (input.listed) return "priced"
  return "unknown"
}

// Catalog rates in USD per million tokens. A model with no input and no output rate has no price.
export function priceOf(cost: {
  input: number
  output: number
  cache?: { read?: number; write?: number }
}): ReviewPrice | undefined {
  if (cost.input === 0 && cost.output === 0) return undefined
  return {
    input: cost.input,
    output: cost.output,
    ...((cost.cache?.read ?? 0) > 0 ? { cacheRead: cost.cache?.read } : {}),
    ...((cost.cache?.write ?? 0) > 0 ? { cacheWrite: cost.cache?.write } : {}),
  }
}

export type Sig = { readonly tool: string; readonly input: string }
export type Estimate = { readonly lowUsd: number; readonly highUsd: number }
export type Stop = { readonly reason: RunBudget.StopReason; readonly message: string }
type Streak = { readonly tool: string; readonly error: string; readonly count: number }
// The loop detector's memory for one session of the run. Each session keeps its own, so parallel subagents that
// run the same tool once each are not one loop, and a patch in one session does not clear another's.
export type Loop = { readonly ring: readonly Sig[]; readonly errorStreak: Streak }

export type Run = {
  readonly rootID: SessionID
  readonly budget: RunBudget.Info
  readonly spentUsd: number
  readonly steps: number
  readonly unpricedSteps: number
  // The cost kind of the latest step, for the spend snapshot.
  readonly costKind?: CostKind
  readonly stopped?: Stop
  readonly warned: boolean
  readonly loops: ReadonlyMap<SessionID, Loop>
  // Off for a root that polices its own loops; see ignoreLoops.
  readonly loopRules: boolean
}

export type Step = {
  readonly costUsd?: number
  readonly costKind: CostKind
  readonly price?: ReviewPrice
  // The step's whole context, and the part of it the provider reported as cache reads.
  readonly contextTokens: number
  readonly cachedTokens: number
  // Whether another provider step follows this one.
  readonly continues: boolean
  readonly tools: readonly { readonly tool: string; readonly input: string; readonly error?: string }[]
  // Whether the step changed a file, which clears the loop detector's memory.
  readonly patched: boolean
}

export type Verdict =
  | {
      readonly state: "ok" | "warn"
      readonly reason?: undefined
      readonly message?: string
      readonly estimate?: Estimate
    }
  | (Stop & { readonly state: "stopped"; readonly estimate?: Estimate })

export type StopDetail = {
  readonly estimate?: Estimate
  readonly loop?: { readonly tool: string; readonly kind: "repeat" | "error" }
}

export function start(rootID: SessionID, budget: RunBudget.Info, loopRules = true): Run {
  return {
    rootID,
    budget,
    spentUsd: 0,
    steps: 0,
    unpricedSteps: 0,
    warned: false,
    loops: new Map(),
    loopRules,
  }
}

// Called after every provider step of any session in the run, with the session that took the step. Spend and steps
// count against the run; loops are detected per session. A stopped run keeps counting what in-flight steps spent,
// and answers stop to every later step, which is how a stop reaches the rest of the lineage.
export function afterStep(run: Run, step: Step, sessionID = run.rootID): { run: Run; verdict: Verdict } {
  const counted = {
    ...run,
    steps: run.steps + 1,
    spentUsd: run.spentUsd + (step.costKind === "priced" ? Math.max(step.costUsd ?? 0, 0) : 0),
    unpricedSteps: run.unpricedSteps + (step.costKind === "unknown" ? 1 : 0),
    costKind: step.costKind,
  }
  if (run.stopped) return { run: counted, verdict: { state: "stopped", ...run.stopped } }
  const limits = checkLimits(counted, step)
  if (limits.state === "stopped") return stop(counted, limits)
  const loops = counted.loopRules
    ? checkLoops(counted, step, sessionID)
    : { run: counted, verdict: { state: "ok" } satisfies Verdict }
  if (loops.verdict.state === "stopped") return stop(loops.run, loops.verdict)
  if (limits.state === "warn") return { run: { ...loops.run, warned: true }, verdict: limits }
  return { run: loops.run, verdict: limits }
}

// The text a stopped run shows everywhere: the CLI, the TUI, the app and desktop logs.
export function stopMessage(reason: RunBudget.StopReason, run: Run, detail: StopDetail = {}): string {
  const cap = formatUsd(run.budget.usd ?? 0)
  if (reason === "cap")
    return `Spend cap reached: ${formatUsd(run.spentUsd)} spent against a ${cap} cap for this run. Vector stopped after the step that crossed it.`
  if (reason === "predicted")
    return `Stopped before the next step: ${formatUsd(run.spentUsd)} spent of a ${cap} cap, and the next step was estimated at ${formatRange(detail.estimate ?? { lowUsd: 0, highUsd: 0 })} at catalog list prices.`
  if (reason === "unpriced")
    return `Stopped after ${run.unpricedSteps} unpriced steps: this model has no catalog price, so Vector cannot count its spend against your ${cap} cap.`
  if (reason === "steps")
    return `Step limit reached: ${run.steps} of ${run.budget.steps ?? run.steps} steps used for this run.`
  const tool = detail.loop?.tool ?? "a tool"
  if (detail.loop?.kind === "error")
    return `Paused a repeating loop: \`${tool}\` failed with the same error ${ERROR_STREAK} times in a row.`
  return `Paused a repeating loop: \`${tool}\` ran with the same input ${LOOP_REPEATS} times with no file changes in between.`
}

export function warnMessage(run: Run) {
  return `Approaching the spend cap: ${formatUsd(run.spentUsd)} of ${formatUsd(run.budget.usd ?? 0)} spent on this run.`
}

// Two decimals, or "<$0.01" for a positive amount that would round to zero.
export function formatUsd(usd: number) {
  const fixed = usd.toFixed(2)
  if (usd > 0 && fixed === "0.00") return "<$0.01"
  return `$${fixed}`
}

function formatRange(estimate: Estimate) {
  const low = formatUsd(estimate.lowUsd)
  const high = formatUsd(estimate.highUsd)
  // Without a cache-read price the low and high estimates are the same.
  if (low === high) return low
  return `${low}–${high}`
}

function stop(run: Run, verdict: Stop & Verdict) {
  return { run: { ...run, stopped: { reason: verdict.reason, message: verdict.message } }, verdict }
}

// Step and dollar limits. Dollars are checked only with a dollar cap and a priced or unpriced model: plan and free
// models are not billed per token. The next step is predicted from this step's context, like Vectorscope does.
function checkLimits(run: Run, step: Step): Verdict {
  if (run.budget.steps !== undefined && run.steps >= run.budget.steps)
    return { state: "stopped", reason: "steps", message: stopMessage("steps", run) }
  const usd = run.budget.usd
  if (usd === undefined || (step.costKind !== "priced" && step.costKind !== "unknown")) return { state: "ok" }
  if (run.spentUsd >= usd) return { state: "stopped", reason: "cap", message: stopMessage("cap", run) }
  if (step.costKind === "unknown" && run.unpricedSteps >= (run.budget.unpricedSteps ?? UNPRICED_STEPS))
    return { state: "stopped", reason: "unpriced", message: stopMessage("unpriced", run) }
  const estimate =
    step.continues && step.price
      ? {
          lowUsd: nextStepCostUsd(step.contextTokens + NEXT_STEP_SLACK, step.price, step.cachedTokens),
          highUsd: nextStepCostUsd(step.contextTokens + NEXT_STEP_SLACK, step.price, 0),
        }
      : undefined
  if (estimate && run.spentUsd + estimate.lowUsd > usd)
    return { state: "stopped", reason: "predicted", message: stopMessage("predicted", run, { estimate }), estimate }
  const near =
    run.spentUsd >= usd * (run.budget.warnAt ?? WARN_AT) || (estimate && run.spentUsd + estimate.highUsd > usd)
  if (near && !run.warned) return { state: "warn", message: warnMessage(run), ...(estimate ? { estimate } : {}) }
  return { state: "ok", ...(estimate ? { estimate } : {}) }
}

// A tool with the same input LOOP_REPEATS times in the last LOOP_WINDOW calls, with no file change in between, or
// the same tool failing with the same error ERROR_STREAK calls in a row.
function checkLoops(run: Run, step: Step, sessionID: SessionID): { run: Run; verdict: Verdict } {
  const loop = run.loops.get(sessionID) ?? { ring: [], errorStreak: { tool: "", error: "", count: 0 } }
  const ring = [
    ...(step.patched ? [] : loop.ring),
    ...step.tools.map((item) => ({ tool: item.tool, input: item.input })),
  ].slice(-LOOP_WINDOW)
  const streaks = step.tools.reduce<Streak[]>((all, item) => {
    const previous = all.at(-1) ?? loop.errorStreak
    if (item.error === undefined) return [...all, { tool: "", error: "", count: 0 }]
    if (item.tool === previous.tool && item.error === previous.error)
      return [...all, { ...previous, count: previous.count + 1 }]
    return [...all, { tool: item.tool, error: item.error, count: 1 }]
  }, [])
  const next = {
    ...run,
    loops: new Map(run.loops).set(sessionID, { ring, errorStreak: streaks.at(-1) ?? loop.errorStreak }),
  }
  const failing = streaks.find((streak) => streak.count >= ERROR_STREAK)
  if (failing)
    return {
      run: next,
      verdict: {
        state: "stopped",
        reason: "loop",
        message: stopMessage("loop", next, { loop: { tool: failing.tool, kind: "error" } }),
      },
    }
  const repeated = ring.find(
    (sig) => ring.filter((other) => other.tool === sig.tool && other.input === sig.input).length >= LOOP_REPEATS,
  )
  if (repeated)
    return {
      run: next,
      verdict: {
        state: "stopped",
        reason: "loop",
        message: stopMessage("loop", next, { loop: { tool: repeated.tool, kind: "repeat" } }),
      },
    }
  return { run: next, verdict: { state: "ok" } }
}

export interface Interface {
  // Sets the budget for the root of `sessionID`: replaces an active run's budget, or holds it for begin().
  readonly arm: (sessionID: SessionID, budget: RunBudget.Info) => Effect.Effect<void>
  // Starts a run for a root session with the armed budget, else `fallback`. A no-op while the run is active.
  readonly begin: (rootID: SessionID, fallback?: RunBudget.Info) => Effect.Effect<void>
  // Turns the loop rules off for a root that polices itself, such as a Vectorscope specialist: it has its own step,
  // cost and time limits, never edits files (so nothing would ever reset the loop window), and must account for
  // every stop it gets. Spend, step and cap checks still apply.
  readonly ignoreLoops: (rootID: SessionID) => Effect.Effect<void>
  readonly link: (childID: SessionID, parentID: SessionID) => Effect.Effect<void>
  readonly rootOf: (sessionID: SessionID) => Effect.Effect<SessionID>
  // Applies one provider step to the run of `sessionID`'s root and publishes session.spend. A root with no active
  // run is ignored. A linked subagent still stepping after its root's run ended, such as a background task, counts
  // against that finished run until the root begins another, so it keeps its cap, loop rules and stop.
  readonly record: (sessionID: SessionID, step: Step) => Effect.Effect<Verdict>
  readonly stopped: (sessionID: SessionID) => Effect.Effect<Stop | undefined>
  // Moves the run into the finished runs, and drops a budget armed for a run that never began.
  readonly end: (rootID: SessionID) => Effect.Effect<void>
  // The active run of `sessionID`'s root, else its last finished run.
  readonly snapshot: (sessionID: SessionID) => Effect.Effect<Run | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SpendGuard") {}

type State = {
  readonly runs: ReadonlyMap<SessionID, Run>
  readonly roots: ReadonlyMap<SessionID, SessionID>
  readonly armed: ReadonlyMap<SessionID, RunBudget.Info>
  readonly last: ReadonlyMap<SessionID, Run>
  readonly quiet: ReadonlySet<SessionID>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const state = yield* Ref.make<State>({
      runs: new Map(),
      roots: new Map(),
      armed: new Map(),
      last: new Map(),
      quiet: new Set(),
    })
    const rootIn = (current: State, sessionID: SessionID) => current.roots.get(sessionID) ?? sessionID
    // The run a session's steps count against: its root's active run, else, for a linked subagent, the root's
    // finished run.
    const runOf = (current: State, sessionID: SessionID) => {
      const rootID = rootIn(current, sessionID)
      const active = current.runs.get(rootID)
      if (active) return { rootID, run: active, active: true }
      if (rootID === sessionID) return undefined
      const finished = current.last.get(rootID)
      if (finished) return { rootID, run: finished, active: false }
      return undefined
    }

    return Service.of({
      arm: Effect.fn("SpendGuard.arm")(function* (sessionID, budget) {
        yield* Ref.update(state, (current) => {
          const rootID = rootIn(current, sessionID)
          const run = current.runs.get(rootID)
          if (!run) return { ...current, armed: new Map(current.armed).set(rootID, budget) }
          // A new cap may warn again.
          const warned = run.warned && run.budget.usd === budget.usd
          return { ...current, runs: new Map(current.runs).set(rootID, { ...run, budget, warned }) }
        })
      }),
      begin: Effect.fn("SpendGuard.begin")(function* (rootID, fallback) {
        yield* Ref.update(state, (current) => {
          if (current.runs.has(rootID)) return current
          const armed = new Map(current.armed)
          armed.delete(rootID)
          const run = start(rootID, current.armed.get(rootID) ?? fallback ?? {}, !current.quiet.has(rootID))
          return { ...current, armed, runs: new Map(current.runs).set(rootID, run) }
        })
      }),
      ignoreLoops: Effect.fn("SpendGuard.ignoreLoops")(function* (rootID) {
        yield* Ref.update(state, (current) => {
          const quiet = new Set(current.quiet).add(rootID)
          const run = current.runs.get(rootID)
          if (!run) return { ...current, quiet }
          return { ...current, quiet, runs: new Map(current.runs).set(rootID, { ...run, loopRules: false }) }
        })
      }),
      link: Effect.fn("SpendGuard.link")(function* (childID, parentID) {
        yield* Ref.update(state, (current) => ({
          ...current,
          roots: new Map(current.roots).set(childID, rootIn(current, parentID)),
        }))
      }),
      rootOf: Effect.fn("SpendGuard.rootOf")(function* (sessionID) {
        return rootIn(yield* Ref.get(state), sessionID)
      }),
      record: Effect.fn("SpendGuard.record")(function* (sessionID, step) {
        const result = yield* Ref.modify(state, (current) => {
          const found = runOf(current, sessionID)
          if (!found) return [undefined, current] as const
          const next = afterStep(found.run, step, sessionID)
          if (found.active)
            return [next, { ...current, runs: new Map(current.runs).set(found.rootID, next.run) }] as const
          return [next, { ...current, last: new Map(current.last).set(found.rootID, next.run) }] as const
        })
        if (!result) return { state: "ok" } satisfies Verdict
        yield* events.publish(SessionStatusEvent.Spend, {
          sessionID: result.run.rootID,
          state: result.verdict.state,
          reason: result.verdict.reason,
          message: result.verdict.message,
          spentUsd: result.run.spentUsd,
          capUsd: result.run.budget.usd,
          steps: result.run.steps,
          unpricedSteps: result.run.unpricedSteps,
          costKind: step.costKind,
          estimate: result.verdict.estimate,
        })
        return result.verdict
      }),
      stopped: Effect.fn("SpendGuard.stopped")(function* (sessionID) {
        return runOf(yield* Ref.get(state), sessionID)?.run.stopped
      }),
      end: Effect.fn("SpendGuard.end")(function* (rootID) {
        yield* Ref.update(state, (current) => {
          const armed = new Map(current.armed)
          armed.delete(rootID)
          const run = current.runs.get(rootID)
          if (!run) return { ...current, armed }
          const runs = new Map(current.runs)
          runs.delete(rootID)
          const last = new Map(current.last)
          last.delete(rootID)
          last.set(rootID, run)
          // A root whose finished run falls out of `last` also loses its subagent links, unless it runs again.
          const dropped = new Set([...last.keys()].slice(0, -LAST_RUNS).filter((id) => !runs.has(id)))
          return {
            ...current,
            armed,
            runs,
            roots: new Map([...current.roots].filter((entry) => !dropped.has(entry[1]))),
            quiet: new Set([...current.quiet].filter((id) => !dropped.has(id))),
            last: new Map([...last].slice(-LAST_RUNS)),
          }
        })
      }),
      snapshot: Effect.fn("SpendGuard.snapshot")(function* (sessionID) {
        const current = yield* Ref.get(state)
        const rootID = rootIn(current, sessionID)
        return current.runs.get(rootID) ?? current.last.get(rootID)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node] })
