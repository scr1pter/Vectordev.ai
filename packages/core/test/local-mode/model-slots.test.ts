import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { ModelSlots } from "../../src/local-mode/model-slots"
import { SpendGuard } from "../../src/spend-guard"
import { NetworkGuard } from "../lib/network-guard"

// The lines are plain promises over in-memory state; nothing here opens a connection, and the strict guard proves it.
const guard = NetworkGuard.use()

const GPU = "http://10.0.0.5:8000"
const OLLAMA = "http://127.0.0.1:11434"

// Settles once every queued promise callback has run, so a test can see whether a wait has resolved.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// Records the order waits resolve in.
function track(slots: ModelSlots.Interface, request: ModelSlots.Request, name: string, log: string[]) {
  return slots.acquire(request).then((release) => {
    log.push(name)
    return release
  })
}

describe("ModelSlots lines", () => {
  test("holds a server to its permits and lets the next request in when one ends", async () => {
    const slots = ModelSlots.make()
    const log: string[] = []
    const first = await track(slots, { origin: GPU, permits: 2, priority: "user" }, "first", log)
    const second = await track(slots, { origin: GPU, permits: 2, priority: "user" }, "second", log)
    const third = track(slots, { origin: GPU, permits: 2, priority: "user" }, "third", log)
    await settle()
    expect(log).toEqual(["first", "second"])
    expect(slots.queue(GPU)).toEqual({ permits: 2, running: 2, waiting: 1 })
    first()
    // A second call to a release gives nothing back twice.
    first()
    await settle()
    expect(log).toEqual(["first", "second", "third"])
    expect(slots.queue(GPU)).toEqual({ permits: 2, running: 2, waiting: 0 })
    second()
    ;(await third)()
    expect(slots.queue(GPU)).toEqual({ permits: ModelSlots.DEFAULT_PERMITS, running: 0, waiting: 0 })
  })

  test("keeps one line per server, so other servers never wait", async () => {
    const slots = ModelSlots.make()
    const held = await slots.acquire({ origin: GPU, permits: 1, priority: "user" })
    const other = await slots.acquire({ origin: OLLAMA, permits: 1, priority: "helper" })
    expect(slots.queue(GPU).running).toBe(1)
    expect(slots.queue(OLLAMA).running).toBe(1)
    held()
    other()
  })

  test("serves the user's turn first, then subagents in the order they asked, then helpers", async () => {
    const slots = ModelSlots.make()
    const log: string[] = []
    const holder = await slots.acquire({ origin: OLLAMA, permits: 1, priority: "user" })
    const waits = new Map([
      ["title", track(slots, { origin: OLLAMA, permits: 1, priority: "helper" }, "title", log)],
      ["subagent 1", track(slots, { origin: OLLAMA, permits: 1, priority: "subagent" }, "subagent 1", log)],
      ["subagent 2", track(slots, { origin: OLLAMA, permits: 1, priority: "subagent" }, "subagent 2", log)],
      ["next step", track(slots, { origin: OLLAMA, permits: 1, priority: "user" }, "next step", log)],
    ])
    holder()
    // One request holds the server at a time; each one's release lets the next one in.
    for (const expected of ["next step", "subagent 1", "subagent 2", "title"]) {
      await settle()
      expect(log.at(-1)).toBe(expected)
      expect(slots.queue(OLLAMA).running).toBe(1)
      ;(await waits.get(expected)!)()
    }
    expect(log).toEqual(["next step", "subagent 1", "subagent 2", "title"])
  })

  test("runs a helper only on an idle server, even with permits to spare", async () => {
    const slots = ModelSlots.make()
    const log: string[] = []
    const turn = await slots.acquire({ origin: GPU, permits: 4, priority: "user" })
    const helper = track(slots, { origin: GPU, permits: 4, priority: "helper" }, "summary", log)
    const subagent = await track(slots, { origin: GPU, permits: 4, priority: "subagent" }, "subagent", log)
    await settle()
    expect(log).toEqual(["subagent"])
    turn()
    await settle()
    expect(log).toEqual(["subagent"])
    subagent()
    ;(await helper)()
    expect(log).toEqual(["subagent", "summary"])
  })

  test("holds nothing back on a server whose number is not known, except helpers", async () => {
    const slots = ModelSlots.make()
    const log: string[] = []
    const request = (priority: ModelSlots.Priority) => ({
      origin: OLLAMA,
      permits: ModelSlots.DEFAULT_PERMITS,
      priority,
    })
    const turn = await slots.acquire(request("user"))
    const [first, second] = await Promise.all([slots.acquire(request("subagent")), slots.acquire(request("subagent"))])
    const title = track(slots, request("helper"), "title", log)
    await settle()
    expect(slots.queue(OLLAMA)).toEqual({ permits: ModelSlots.DEFAULT_PERMITS, running: 3, waiting: 1 })
    turn()
    first()
    await settle()
    expect(log).toEqual([])
    second()
    ;(await title)()
    expect(log).toEqual(["title"])
  })

  test("drops waiting helpers when a new prompt arrives, and keeps every other wait", async () => {
    const slots = ModelSlots.make()
    const log: string[] = []
    const turn = await slots.acquire({ origin: OLLAMA, permits: 1, priority: "user" })
    const title = slots.acquire({ origin: OLLAMA, permits: 1, priority: "helper" })
    const elsewhere = slots.acquire({ origin: GPU, permits: 1, priority: "helper" })
    const subagent = track(slots, { origin: OLLAMA, permits: 1, priority: "subagent" }, "subagent", log)
    slots.prompted()
    const dropped = await title.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(dropped).toBeInstanceOf(ModelSlots.Cancelled)
    expect(dropped).toMatchObject({ name: "AbortError", origin: OLLAMA })
    // A helper already running on an idle server is not waiting, so it keeps its permit.
    ;(await elsewhere)()
    expect(slots.queue(OLLAMA)).toEqual({ permits: 1, running: 1, waiting: 1 })
    turn()
    ;(await subagent)()
    expect(log).toEqual(["subagent"])
  })

  test("leaves the line when the request is aborted, with the signal's reason", async () => {
    const slots = ModelSlots.make()
    const holder = await slots.acquire({ origin: OLLAMA, permits: 1, priority: "user" })
    const controller = new AbortController()
    const waiting = slots.acquire({ origin: OLLAMA, permits: 1, priority: "subagent", signal: controller.signal })
    expect(slots.queue(OLLAMA).waiting).toBe(1)
    controller.abort(new DOMException("Stopped", "AbortError"))
    expect(
      await waiting.then(
        () => "granted",
        (error: Error) => error.message,
      ),
    ).toBe("Stopped")
    expect(slots.queue(OLLAMA)).toEqual({ permits: 1, running: 1, waiting: 0 })
    const aborted = new AbortController()
    aborted.abort(new DOMException("Already stopped", "AbortError"))
    expect(
      await slots.acquire({ origin: OLLAMA, permits: 1, priority: "user", signal: aborted.signal }).then(
        () => "granted",
        (error: Error) => error.message,
      ),
    ).toBe("Already stopped")
    holder()
  })

  test("an interrupted holder gives its permit back, so the next wait never deadlocks", async () => {
    const slots = ModelSlots.make()
    const run = Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* slots.take({ origin: OLLAMA, permits: 1, priority: "user" }).pipe(Scope.provide(scope))
      const holder = yield* Effect.never.pipe(
        Effect.onInterrupt(() => Scope.close(scope, Exit.void)),
        Effect.forkChild,
      )
      const waiting = yield* Effect.scoped(slots.take({ origin: OLLAMA, permits: 1, priority: "subagent" })).pipe(
        Effect.forkChild,
      )
      yield* Effect.promise(settle)
      expect(slots.queue(OLLAMA)).toEqual({ permits: 1, running: 1, waiting: 1 })
      yield* Fiber.interrupt(holder)
      yield* Fiber.join(waiting)
      expect(slots.queue(OLLAMA)).toEqual({ permits: ModelSlots.DEFAULT_PERMITS, running: 0, waiting: 0 })
    })
    await Effect.runPromise(run)
  })

  test("an interrupted wait leaves the line", async () => {
    const slots = ModelSlots.make()
    const holder = await slots.acquire({ origin: OLLAMA, permits: 1, priority: "user" })
    await Effect.runPromise(
      Effect.gen(function* () {
        const waiting = yield* Effect.scoped(slots.take({ origin: OLLAMA, permits: 1, priority: "user" })).pipe(
          Effect.forkChild,
        )
        yield* Effect.promise(settle)
        expect(slots.queue(OLLAMA).waiting).toBe(1)
        yield* Fiber.interrupt(waiting)
        expect(slots.queue(OLLAMA)).toEqual({ permits: 1, running: 1, waiting: 0 })
      }),
    )
    holder()
  })

  test("opened no connection", () => {
    expect(guard.outside()).toEqual([])
  })
})

describe("ModelSlots servers", () => {
  test("gives permits to servers on this computer and the user's network, never to a cloud API", () => {
    expect(ModelSlots.server("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434")
    expect(ModelSlots.server("http://localhost:1234/v1")).toBe("http://localhost:1234")
    expect(ModelSlots.server("http://[::1]:8080")).toBe("http://[::1]:8080")
    expect(ModelSlots.server("http://10.0.0.5:8000/v1")).toBe("http://10.0.0.5:8000")
    expect(ModelSlots.server("http://gpu-box:8000/v1")).toBe("http://gpu-box:8000")
    expect(ModelSlots.server("https://api.openai.com/v1")).toBeUndefined()
    expect(ModelSlots.server("https://llm.corp.example.com/v1")).toBeUndefined()
    expect(ModelSlots.server(undefined)).toBeUndefined()
    expect(ModelSlots.server("not a url")).toBeUndefined()
  })

  test("prices nothing on this computer, and a private server only once it is listed", () => {
    const cost = (url: string, listed: string[] = [], priced = false) =>
      SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: priced, local: ModelSlots.local(url, listed) })
    expect(cost("http://127.0.0.1:11434/v1")).toBe("local")
    expect(cost("http://10.0.0.5:8000/v1")).toBe("unknown")
    expect(cost("http://10.0.0.5:8000/v1", ["http://10.0.0.5:8000"])).toBe("local")
    // An unpriced company endpoint on the internet stays unknown, so a dollar cap still stops it.
    expect(cost("https://llm.corp.example.com/v1", ["https://llm.corp.example.com"])).toBe("unknown")
    // A configured price wins over the server being local.
    expect(cost("http://127.0.0.1:11434/v1", [], true)).toBe("priced")
  })
})
