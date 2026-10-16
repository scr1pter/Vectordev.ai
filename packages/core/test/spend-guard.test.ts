import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { SessionID } from "@vectordevai/schema/session-id"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import { testEffect } from "./lib/effect"

describe("SpendGuard cost kind and price", () => {
  test("costKindOf puts free before plan before priced", () => {
    expect(SpendGuard.costKindOf({ free: true, oauthPlan: true, listed: true })).toBe("free")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: true, listed: true })).toBe("plan")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: true })).toBe("priced")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: false })).toBe("unknown")
  })

  test("priceOf has no price for all-zero rates", () => {
    expect(SpendGuard.priceOf({ input: 0, output: 0, cache: { read: 0.5, write: 1 } })).toBeUndefined()
    expect(SpendGuard.priceOf({ input: 0, output: 0 })).toBeUndefined()
  })

  test("priceOf keeps cache rates only when they are listed", () => {
    expect(SpendGuard.priceOf({ input: 1.25, output: 10, cache: { read: 0.125, write: 0 } })).toEqual({
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
    })
    expect(SpendGuard.priceOf({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    })
  })
})

const root = SessionID.make("ses_root")
const child = SessionID.make("ses_child")
const sibling = SessionID.make("ses_sibling")

const step = (input: Partial<SpendGuard.Step> = {}): SpendGuard.Step => ({
  costKind: "priced",
  contextTokens: 1_000,
  cachedTokens: 0,
  continues: false,
  tools: [],
  patched: false,
  ...input,
})

// Applies steps in order and returns the final run and every verdict. `sessions[i]` took step i, else the root.
const play = (budget: RunBudget.Info, steps: SpendGuard.Step[], sessions: SessionID[] = []) =>
  steps.reduce(
    (acc, item, index) => {
      const next = SpendGuard.afterStep(acc.run, item, sessions[index])
      return { run: next.run, verdicts: [...acc.verdicts, next.verdict] }
    },
    { run: SpendGuard.start(root, budget), verdicts: [] as SpendGuard.Verdict[] },
  )

const bash = (input: string, error?: string) => ({ tool: "bash", input, ...(error === undefined ? {} : { error }) })
// A call with what it returned, for the loop rules.
const call = (tool: string, input: string, output: string) => step({ tools: [{ tool, input, output }] })
const reads = (count: number) =>
  Array.from({ length: count }, (_, index) => step({ tools: [{ tool: "read", input: `src/${index}.ts` }] }))

describe("SpendGuard.afterStep", () => {
  test("warns once at 80% of the cap", () => {
    const result = play({ usd: 5 }, [step({ costUsd: 4.1 }), step({ costUsd: 0.1 })])
    expect(result.verdicts[0]).toEqual({
      state: "warn",
      message: "Approaching the spend cap: $4.10 of $5.00 spent on this run.",
    })
    expect(result.verdicts[1]).toEqual({ state: "ok" })
  })

  test("stops with cap on the step that crosses it", () => {
    const result = play({ usd: 5 }, [step({ costUsd: 4.1 }), step({ costUsd: 0.92 })])
    expect(result.verdicts[1]).toEqual({
      state: "stopped",
      reason: "cap",
      message:
        "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it.",
    })
    expect(result.run.stopped?.reason).toBe("cap")
  })

  test("stops before a next step estimated to cross the cap", () => {
    // 320k tokens of next-step input at $3/M, 207k of them cached at $0.30/M, plus 600 output tokens at $15/M.
    const predicted = step({
      costUsd: 4.62,
      continues: true,
      contextTokens: 317_000,
      cachedTokens: 207_000,
      price: { input: 3, output: 15, cacheRead: 0.3 },
    })
    const verdict = play({ usd: 5 }, [predicted]).verdicts[0]
    expect(verdict?.state).toBe("stopped")
    expect(verdict?.reason).toBe("predicted")
    expect(verdict?.message).toBe(
      "Stopped before the next step: $4.62 spent of a $5.00 cap, and the next step was estimated at $0.41–$0.97 at catalog list prices.",
    )
    expect(verdict?.estimate?.lowUsd).toBeLessThanOrEqual(verdict?.estimate?.highUsd ?? 0)
  })

  test("shows one figure when the estimate has no cache-read range", () => {
    const predicted = step({
      costUsd: 4.62,
      continues: true,
      contextTokens: 317_000,
      cachedTokens: 207_000,
      price: { input: 3, output: 15 },
    })
    expect(play({ usd: 5 }, [predicted]).verdicts[0]?.message).toBe(
      "Stopped before the next step: $4.62 spent of a $5.00 cap, and the next step was estimated at $0.97 at catalog list prices.",
    )
  })

  test("warns once when the high estimate would cross the cap below 80%", () => {
    // 500k tokens of next-step input at $3/M, 400k of them cached at $0.30/M: low $0.43, high $1.51.
    const near = (costUsd: number) =>
      step({
        costUsd,
        continues: true,
        contextTokens: 497_000,
        cachedTokens: 400_000,
        price: { input: 3, output: 15, cacheRead: 0.3 },
      })
    const result = play({ usd: 5 }, [near(3.9), near(0.01)])
    expect(result.verdicts[0]).toMatchObject({
      state: "warn",
      message: "Approaching the spend cap: $3.90 of $5.00 spent on this run.",
    })
    expect(result.verdicts[0]?.estimate?.lowUsd).toBeCloseTo(0.429, 6)
    expect(result.verdicts[0]?.estimate?.highUsd).toBeCloseTo(1.509, 6)
    expect(result.verdicts[1]?.state).toBe("ok")
    expect(result.verdicts[1]?.estimate?.highUsd).toBeCloseTo(1.509, 6)
  })

  test("does not predict when no step follows", () => {
    const last = step({
      costUsd: 4.62,
      contextTokens: 317_000,
      cachedTokens: 207_000,
      price: { input: 3, output: 15, cacheRead: 0.3 },
    })
    const verdict = play({ usd: 5 }, [last]).verdicts[0]
    expect(verdict?.state).toBe("warn")
    expect(verdict?.estimate).toBeUndefined()
  })

  test("stops an unpriced model after 40 steps while spending nothing", () => {
    const result = play(
      { usd: 5 },
      Array.from({ length: 40 }, () => step({ costKind: "unknown", costUsd: 3 })),
    )
    expect(result.verdicts.slice(0, 39).every((verdict) => verdict.state === "ok")).toBe(true)
    expect(result.verdicts[39]).toEqual({
      state: "stopped",
      reason: "unpriced",
      message:
        "Stopped after 40 unpriced steps: this model has no catalog price, so Vector cannot count its spend against your $5.00 cap.",
    })
    expect(result.run.spentUsd).toBe(0)
  })

  test("never stops plan or free models on dollars, but does on steps", () => {
    const kinds = Array.from({ length: 60 }, (_, index) => step({ costKind: index % 2 ? "plan" : "free", costUsd: 10 }))
    const result = play({ usd: 1, steps: 60 }, kinds)
    expect(result.verdicts.slice(0, 59).every((verdict) => verdict.state === "ok")).toBe(true)
    expect(result.verdicts[59]).toEqual({
      state: "stopped",
      reason: "steps",
      message: "Step limit reached: 60 of 60 steps used for this run.",
    })
    expect(result.run.spentUsd).toBe(0)
  })

  test("counts priced dollars and unpriced steps separately in a mixed run", () => {
    const result = play({ usd: 5 }, [
      step({ costUsd: 0.5 }),
      step({ costKind: "unknown", costUsd: 2 }),
      step({ costUsd: 0.25 }),
    ])
    expect(result.run.spentUsd).toBe(0.75)
    expect(result.run.unpricedSteps).toBe(1)
    expect(result.run.steps).toBe(3)
  })

  test("pauses the same input three times with no file change in between", () => {
    const repeated = play({}, [
      step({ tools: [bash("bun test")] }),
      step({ tools: [bash("bun test")] }),
      step({ tools: [bash("bun test")] }),
    ])
    expect(repeated.verdicts[2]).toEqual({
      state: "stopped",
      reason: "loop",
      message:
        "Paused a repeating loop: `bash` returned the same result for the same input 3 times, with no new results or file changes in between.",
    })

    const patched = play({}, [
      step({ tools: [bash("bun test")] }),
      step({ tools: [{ tool: "edit", input: "src/a.ts" }], patched: true }),
      step({ tools: [bash("bun test")] }),
      step({ tools: [bash("bun test")] }),
    ])
    expect(patched.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
  })

  test("a run with loop rules off never pauses a loop, but still stops on its cap", () => {
    const quiet = [
      step({ tools: [bash("git diff")], costUsd: 0.2 }),
      step({ tools: [bash("git diff")], costUsd: 0.2 }),
      step({ tools: [bash("git diff")], costUsd: 0.2 }),
      step({ tools: [bash("git diff")], costUsd: 0.5 }),
    ].reduce(
      (acc, item) => {
        const next = SpendGuard.afterStep(acc.run, item)
        return { run: next.run, verdicts: [...acc.verdicts, next.verdict] }
      },
      { run: SpendGuard.start(root, { usd: 1 }, false), verdicts: [] as SpendGuard.Verdict[] },
    )
    expect(quiet.verdicts.slice(0, 3).map((verdict) => verdict.state)).toEqual(["ok", "ok", "ok"])
    expect(quiet.verdicts[3]).toMatchObject({ state: "stopped", reason: "cap" })
  })

  test("lets a page observed between clicks run on", () => {
    const observe = (page: string) => call("browser", JSON.stringify({ action: "observe" }), page)
    const click = (selector: string) => call("browser", JSON.stringify({ action: "click", selector }), "clicked")
    const changing = play({}, [observe("home"), click("#a"), observe("form"), click("#b"), observe("done")])
    expect(changing.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)

    // Different clicks that leave the page as it was are still different calls.
    const unchanged = play({}, [observe("home"), click("#a"), observe("home"), click("#b"), observe("home")])
    expect(unchanged.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)

    // The same click on Next with a new page each time is a walk through the pages, not a loop.
    const pages = play({}, [
      observe("page 1"),
      click("#next"),
      observe("page 2"),
      click("#next"),
      observe("page 3"),
      click("#next"),
      observe("page 4"),
    ])
    expect(pages.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)

    const stuck = play({}, [observe("home"), observe("home"), observe("home")])
    expect(stuck.verdicts[2]).toMatchObject({ state: "stopped", reason: "loop" })
  })

  test("lets git status run between add and commit", () => {
    const git = (command: string, output: string) => call("bash", JSON.stringify({ command }), output)
    const result = play({}, [
      git("git status", "modified: src/a.ts"),
      git("git add -A", ""),
      git("git status", "staged: src/a.ts"),
      git("git commit -m fix", "[main 1a2b3c] fix"),
      git("git status", "nothing to commit, working tree clean"),
    ])
    expect(result.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
  })

  test("pauses a cycle of calls that keep getting the same answers", () => {
    const read = call("read", "src/a.ts", "same")
    const test = call("bash", "bun test", "1 fail")
    const result = play({}, [read, test, read, test, read, test])
    expect(result.verdicts.slice(0, 5).every((verdict) => verdict.state === "ok")).toBe(true)
    expect(result.verdicts[5]).toMatchObject({ state: "stopped", reason: "loop" })

    // A call that returns something new between the repeats is progress.
    const learning = play({}, [
      test,
      call("read", "src/a.ts", "a"),
      test,
      call("read", "src/b.ts", "b"),
      test,
      call("read", "src/c.ts", "c"),
      test,
    ])
    expect(learning.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
  })

  test("treats a call last seen more than 8 calls back as new", () => {
    const cycle = (length: number, rounds: number) =>
      Array.from({ length: length * rounds }, (_, index) => call("read", `src/${index % length}.ts`, "same"))
    expect(play({}, cycle(9, 3)).verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
    expect(play({}, cycle(3, 3)).verdicts.at(-1)?.reason).toBe("loop")
  })

  test("detects loops per session, not across the lineage", () => {
    // Three subagents each read the same file once.
    const read = () => step({ tools: [{ tool: "read", input: "src/a.ts" }] })
    const parallel = play({}, [read(), read(), read()], [root, child, sibling])
    expect(parallel.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)

    // A patch in one session does not clear another session's repeats.
    const stuck = play(
      {},
      [
        step({ tools: [bash("bun test")] }),
        step({ tools: [bash("bun test")] }),
        step({ tools: [{ tool: "edit", input: "src/a.ts" }], patched: true }),
        step({ tools: [bash("bun test")] }),
      ],
      [child, child, sibling, child],
    )
    expect(stuck.verdicts.at(-1)?.reason).toBe("loop")

    // Failures in another session neither break nor build a session's streak.
    const built = play(
      {},
      [
        step({ tools: [bash("bun run a", "exit 1")] }),
        step({ tools: [bash("bun run b", "exit 1")] }),
        step({ tools: [bash("bun run c", "exit 1")] }),
      ],
      [child, sibling, child],
    )
    expect(built.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
    const unbroken = play(
      {},
      [
        step({ tools: [bash("bun run a", "exit 1")] }),
        step({ tools: [bash("bun run b", "exit 1")] }),
        step({ tools: [bash("bun run c")] }),
        step({ tools: [bash("bun run d", "exit 1")] }),
      ],
      [child, child, sibling, child],
    )
    expect(unbroken.verdicts.at(-1)?.message).toBe(
      "Paused a repeating loop: `bash` failed with the same error 3 times in a row.",
    )
  })

  test("pauses the same error three times in a row", () => {
    const result = play({}, [
      step({ tools: [bash("bun run a", "exit 1")] }),
      step({ tools: [bash("bun run b", "exit 1")] }),
      step({ tools: [bash("bun run c", "exit 1")] }),
    ])
    expect(result.verdicts[2]).toEqual({
      state: "stopped",
      reason: "loop",
      message: "Paused a repeating loop: `bash` failed with the same error 3 times in a row.",
    })

    const broken = play({}, [
      step({ tools: [bash("bun run a", "exit 1")] }),
      step({ tools: [bash("bun run b")] }),
      step({ tools: [bash("bun run c", "exit 1"), bash("bun run d", "exit 1")] }),
    ])
    expect(broken.verdicts.every((verdict) => verdict.state === "ok")).toBe(true)
  })

  test("answers stop to every step after a stop, and keeps counting spend", () => {
    const result = play({ usd: 1 }, [step({ costUsd: 1.5 }), step({ costKind: "free" }), step({ costUsd: 0.25 })])
    expect(result.verdicts.map((verdict) => verdict.state)).toEqual(["stopped", "stopped", "stopped"])
    expect(result.verdicts.map((verdict) => verdict.reason)).toEqual(["cap", "cap", "cap"])
    expect(result.run.spentUsd).toBe(1.75)
  })

  test("formats money with two decimals, or <$0.01 for less than a cent", () => {
    expect(SpendGuard.formatUsd(0.004)).toBe("<$0.01")
    expect(SpendGuard.formatUsd(0)).toBe("$0.00")
    expect(SpendGuard.formatUsd(25)).toBe("$25.00")
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([SpendGuard.node, EventV2.node])))

describe("SpendGuard service", () => {
  it.effect("counts a linked child against its root, raises a cap on arm, and keeps the last run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const events = yield* EventV2.Service
      const published = yield* events
        .subscribe(SessionStatusEvent.Spend)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* guard.arm(root, { usd: 1 })
      yield* guard.begin(root)
      yield* guard.link(child, root)
      expect(yield* guard.rootOf(child)).toBe(root)

      expect((yield* guard.record(child, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0.5)
      expect([...(yield* Fiber.join(published))][0]?.data).toMatchObject({
        sessionID: root,
        state: "ok",
        spentUsd: 0.5,
        capUsd: 1,
        costKind: "priced",
      })

      yield* guard.arm(child, { usd: 10 })
      expect((yield* guard.record(root, step({ costUsd: 0.6 }))).state).toBe("ok")
      expect(yield* guard.stopped(child)).toBeUndefined()

      yield* guard.end(root)
      const last = yield* guard.snapshot(root)
      expect(last?.spentUsd).toBe(1.1)
      expect(last?.budget.usd).toBe(10)
      expect((yield* guard.record(root, step({ costUsd: 5 }))).state).toBe("ok")
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(1.1)
    }),
  )

  it.effect("unlinks a session so its steps count against a run of its own", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const owner = SessionID.make("ses_unlink_root")
      const helper = SessionID.make("ses_unlink_helper")
      yield* guard.begin(owner, { usd: 1 })
      yield* guard.link(helper, owner)
      yield* guard.record(owner, step({ costUsd: 2 }))
      yield* guard.end(owner)
      expect((yield* guard.stopped(helper))?.reason).toBe("cap")

      yield* guard.unlink(helper)
      expect(yield* guard.rootOf(helper)).toBe(helper)
      expect(yield* guard.stopped(helper)).toBeUndefined()
      yield* guard.begin(helper, { usd: 3 })
      expect((yield* guard.record(helper, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.snapshot(helper))?.spentUsd).toBe(0.5)
      expect((yield* guard.snapshot(owner))?.spentUsd).toBe(2)
      yield* guard.end(helper)
    }),
  )

  it.effect("turns the loop rules off for a root marked before or during its run", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const before = SessionID.make("ses_quiet_before")
      yield* guard.ignoreLoops(before)
      yield* guard.begin(before)
      const during = SessionID.make("ses_quiet_during")
      yield* guard.begin(during)
      yield* guard.ignoreLoops(during)
      for (const id of [before, during]) {
        const verdicts = yield* Effect.forEach([1, 2, 3], () => guard.record(id, step({ tools: [bash("git diff")] })))
        expect(verdicts.map((verdict) => verdict.state)).toEqual(["ok", "ok", "ok"])
      }
      yield* guard.begin(root)
      const looping = yield* Effect.forEach([1, 2, 3], () => guard.record(root, step({ tools: [bash("git diff")] })))
      expect(looping[2]).toMatchObject({ state: "stopped", reason: "loop" })
    }),
  )

  it.effect("exempts a linked session that polices its own loops, while the rest of its run is still checked", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const reviewer = SessionID.make("ses_quiet_child")
      yield* guard.begin(root, { usd: 1 })
      yield* guard.link(reviewer, root)
      yield* guard.ignoreLoops(reviewer)
      const quiet = yield* Effect.forEach([1, 2, 3], () =>
        guard.record(reviewer, step({ costUsd: 0.1, tools: [bash("cat src/a.ts")] })),
      )
      expect(quiet.map((verdict) => verdict.state)).toEqual(["ok", "ok", "ok"])
      // Its spend still counts against the run it is linked to.
      expect((yield* guard.snapshot(root))?.spentUsd).toBeCloseTo(0.3, 6)
      const looping = yield* Effect.forEach([1, 2, 3], () =>
        guard.record(root, step({ tools: [bash("cat src/a.ts")] })),
      )
      expect(looping[2]).toMatchObject({ state: "stopped", reason: "loop" })
    }),
  )

  it.effect("waits for a step's real file change only when the guess would pause it as a loop", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const asked: number[] = []
      const confirm = (index: number, changed: boolean) => Effect.sync(() => asked.push(index)).pipe(Effect.as(changed))
      yield* guard.begin(root)
      // A command that writes a file each time is not a loop, but nothing in the step says so until its patch lands.
      for (const index of [1, 2, 3])
        expect(
          (yield* guard.record(root, step({ tools: [bash("bun run generate")] }), confirm(index, true))).state,
        ).toBe("ok")
      expect(asked).toEqual([3])
      // Once it changes nothing, the call that changed the files and the two after it are a loop.
      expect((yield* guard.record(root, step({ tools: [bash("bun run generate")] }), confirm(4, false))).state).toBe(
        "ok",
      )
      const verdict = yield* guard.record(root, step({ tools: [bash("bun run generate")] }), confirm(5, false))
      expect(verdict).toMatchObject({ state: "stopped", reason: "loop" })
      expect(asked).toEqual([3, 5])
    }),
  )

  it.effect("forgets a session's loop memory when its files change after its step was counted", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root)
      yield* guard.link(child, root)
      yield* guard.record(child, step({ tools: [bash("bun test")] }))
      yield* guard.record(child, step({ tools: [bash("bun test")] }))
      yield* guard.record(root, step({ tools: [bash("bun test")] }))
      yield* guard.record(root, step({ tools: [bash("bun test")] }))
      yield* guard.changed(child)
      expect((yield* guard.record(child, step({ tools: [bash("bun test")] }))).state).toBe("ok")
      // Another session's change leaves the root's memory alone.
      expect((yield* guard.record(root, step({ tools: [bash("bun test")] }))).reason).toBe("loop")
    }),
  )

  it.effect("says whether the root of a session has a run going", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.link(child, root)
      expect(yield* guard.running(child)).toBe(false)
      yield* guard.begin(root)
      expect(yield* guard.running(child)).toBe(true)
      expect(yield* guard.running(root)).toBe(true)
      yield* guard.end(root)
      expect(yield* guard.running(child)).toBe(false)
    }),
  )

  it.effect(
    "holds a linked child still stepping after its root's run ended to that run, until the root begins again",
    () =>
      Effect.gen(function* () {
        const guard = yield* SpendGuard.Service
        yield* guard.begin(root, { usd: 1 })
        yield* guard.link(child, root)
        expect((yield* guard.record(root, step({ costUsd: 1.2 }))).state).toBe("stopped")
        yield* guard.end(root)

        // A background child keeps the finished run's stop and has its spend counted.
        expect((yield* guard.stopped(child))?.reason).toBe("cap")
        expect((yield* guard.record(child, step({ costUsd: 0.3 }))).state).toBe("stopped")
        expect((yield* guard.snapshot(root))?.spentUsd).toBeCloseTo(1.5, 6)
        // The root itself only ever steps inside a run of its own.
        expect(yield* guard.stopped(root)).toBeUndefined()

        yield* guard.begin(root, { usd: 1 })
        expect(yield* guard.stopped(child)).toBeUndefined()
        expect((yield* guard.record(child, step({ costUsd: 0.1 }))).state).toBe("ok")
        expect((yield* guard.snapshot(root))?.spentUsd).toBeCloseTo(0.1, 6)
      }),
  )

  it.effect("holds a linked child to its root's finished run with no stop, and counts its spend there", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 1 })
      yield* guard.link(child, root)
      yield* guard.end(root)
      expect((yield* guard.record(child, step({ costUsd: 0.5 }))).state).toBe("ok")
      expect((yield* guard.record(child, step({ costUsd: 0.6 }))).state).toBe("stopped")
      expect((yield* guard.stopped(child))?.reason).toBe("cap")
      expect((yield* guard.snapshot(root))?.spentUsd).toBeCloseTo(1.1, 6)
    }),
  )

  it.effect("publishes a stop to the lineage with its reason and message", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      const events = yield* EventV2.Service
      const published = yield* events
        .subscribe(SessionStatusEvent.Spend)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* guard.begin(root, { usd: 5 })
      yield* guard.link(child, root)
      yield* guard.record(root, step({ costUsd: 4.1 }))
      expect((yield* guard.record(child, step({ costUsd: 0.92 }))).state).toBe("stopped")

      const message =
        "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it."
      expect([...(yield* Fiber.join(published))].map((event) => event.data)).toMatchObject([
        { sessionID: root, state: "warn", message: "Approaching the spend cap: $4.10 of $5.00 spent on this run." },
        { sessionID: root, state: "stopped", reason: "cap", message, spentUsd: 5.02, capUsd: 5 },
      ])
      expect(yield* guard.stopped(child)).toEqual({ reason: "cap", message })
    }),
  )

  it.effect("warns again only when a new cap is armed", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root, { usd: 5 })
      expect((yield* guard.record(root, step({ costUsd: 4.1 }))).state).toBe("warn")
      yield* guard.arm(root, { usd: 5 })
      expect((yield* guard.record(root, step({ costUsd: 0.01 }))).state).toBe("ok")
      yield* guard.arm(root, { usd: 4.5 })
      expect(yield* guard.record(root, step({ costUsd: 0.01 }))).toEqual({
        state: "warn",
        message: "Approaching the spend cap: $4.12 of $4.50 spent on this run.",
      })
    }),
  )

  it.effect("drops a budget armed for a run that never began", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.arm(root, { usd: 1 })
      yield* guard.end(root)
      yield* guard.begin(root, { usd: 9 })
      expect((yield* guard.snapshot(root))?.budget.usd).toBe(9)
    }),
  )

  it.effect("keeps the last 200 finished runs, and drops the links of older ones", () =>
    Effect.gen(function* () {
      const guard = yield* SpendGuard.Service
      yield* guard.begin(root)
      yield* guard.link(child, root)
      yield* guard.end(root)
      const others = Array.from({ length: SpendGuard.LAST_RUNS - 1 }, (_, index) => SessionID.make(`ses_run_${index}`))
      yield* Effect.forEach(others, (id) => Effect.andThen(guard.begin(id), guard.end(id)), { discard: true })
      expect(yield* guard.snapshot(child)).toBeDefined()

      yield* guard.begin(sibling)
      yield* guard.end(sibling)
      expect(yield* guard.snapshot(root)).toBeUndefined()
      expect(yield* guard.rootOf(child)).toBe(child)
      expect(yield* guard.snapshot(SessionID.make("ses_run_0"))).toBeDefined()
    }),
  )
})
