import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { LLM, type Model } from "@vectordevai/llm"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { ModelSlots } from "../../src/local-mode/model-slots"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"
import { SessionRunnerModel } from "../../src/session/runner/model"
import { SpendGuard } from "../../src/spend-guard"
import { NetworkGuard } from "../lib/network-guard"

// The lines are plain promises over in-memory state. Only the V2 runner's test opens connections, to a fake model
// server on 127.0.0.1, and the strict guard proves nothing leaves this computer.
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
    // The count stays once the line is empty.
    expect(slots.queue(GPU)).toEqual({ permits: 2, running: 0, waiting: 0 })
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
    const request = (priority: ModelSlots.Priority) => ({ origin: OLLAMA, priority })
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

  test("a request that names no count waits by the latest one named, even after the line emptied", async () => {
    const slots = ModelSlots.make()
    const log: string[] = []
    ;(await slots.acquire({ origin: GPU, permits: 1, priority: "user" }))()
    expect(slots.queue(GPU)).toEqual({ permits: 1, running: 0, waiting: 0 })
    const first = await slots.acquire({ origin: GPU, priority: "user" })
    const second = track(slots, { origin: GPU, priority: "subagent" }, "second", log)
    // Neither the request that names no count nor one that names an unusable one lifts the limit.
    const third = track(slots, { origin: GPU, permits: ModelSlots.DEFAULT_PERMITS, priority: "subagent" }, "third", log)
    await settle()
    expect(log).toEqual([])
    expect(slots.queue(GPU)).toEqual({ permits: 1, running: 1, waiting: 2 })
    // A new count applies to everyone waiting.
    const fourth = track(slots, { origin: GPU, permits: 3, priority: "subagent" }, "fourth", log)
    await settle()
    expect(log).toEqual(["second", "third"])
    expect(slots.queue(GPU)).toEqual({ permits: 3, running: 3, waiting: 1 })
    first()
    ;(await second)()
    ;(await third)()
    ;(await fourth)()
    expect(log).toEqual(["second", "third", "fourth"])
    // Another server never named one.
    expect(slots.queue(OLLAMA).permits).toBe(ModelSlots.DEFAULT_PERMITS)
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
      expect(slots.queue(OLLAMA)).toEqual({ permits: 1, running: 0, waiting: 0 })
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

describe("ModelSlots in the V2 runner", () => {
  test("a session's requests hold to the provider's concurrency, and one that names none waits by it", async () => {
    const server = heldServer()
    try {
      const slots = ModelSlots.make()
      const origin = new URL(server.url).origin
      const resolve = (settings: Record<string, unknown>, priority: ModelSlots.Priority) =>
        Effect.runPromise(
          SessionRunnerModel.fromCatalogModel(info(`${origin}/v1`, settings), undefined, undefined, {
            slots,
            priority,
          }),
        )
      const configured = await resolve({ concurrency: 1 }, "user")
      const unnamed = await resolve({}, "subagent")
      const first = ask(configured, "first")
      await until(() => server.seen.length === 1)
      const second = ask(unnamed, "second")
      await new Promise((resolve) => setTimeout(resolve, 50))
      // The second request waits for the first one's permit instead of reaching the server.
      expect(server.seen).toEqual(["first"])
      expect(slots.queue(origin)).toEqual({ permits: 1, running: 1, waiting: 1 })
      server.release()
      await until(() => server.seen.length === 2)
      server.release()
      expect(await Promise.all([first, second])).toEqual(["reply 1", "reply 2"])
      expect(server.most()).toBe(1)
      expect(slots.queue(origin)).toEqual({ permits: 1, running: 0, waiting: 0 })
    } finally {
      server.stop()
    }
    expect(guard.outside()).toEqual([])
  })

  test("a cloud API gets a line only when its provider sets concurrency", async () => {
    const slots = ModelSlots.make()
    const resolve = (settings: Record<string, unknown>) =>
      Effect.runPromise(
        SessionRunnerModel.fromCatalogModel(info("https://llm.cloud.invalid/v1", settings), undefined, undefined, {
          slots,
          priority: "user",
        }),
      )
    const plain = await SessionRunnerModel.fromCatalogModel(info("https://llm.cloud.invalid/v1", {})).pipe(
      Effect.runPromise,
    )
    // Nothing wraps the transport of a cloud API that names no count.
    expect((await resolve({})).route.transport.frames).toBe(plain.route.transport.frames)
    expect((await resolve({ concurrency: 2 })).route.transport.frames).not.toBe(plain.route.transport.frames)
  })
})

function info(url: string, settings: Record<string, unknown>) {
  return ModelV2.Info.make({
    id: ModelV2.ID.make("qwen"),
    providerID: ProviderV2.ID.make("gpu-box"),
    name: "qwen",
    api: { id: ModelV2.ID.make("qwen"), type: "aisdk", package: "@ai-sdk/openai-compatible", url, settings },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 32_768, output: 4_096 },
  })
}

// One streamed request through the V2 client; resolves with the reply's text.
async function ask(model: Model, prompt: string) {
  const events = await Effect.runPromise(
    LLMClient.stream(LLM.request({ model, prompt })).pipe(
      Stream.runCollect,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
    ),
  )
  return [...events].flatMap((event) => (event.type === "text-delta" ? [event.text] : [])).join("")
}

async function until(check: () => boolean) {
  const stop = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > stop) throw new Error("timed out waiting for the model server")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// A fake OpenAI-compatible server on 127.0.0.1 that sends its headers at once and holds each reply until released.
function heldServer() {
  const held: (() => void)[] = []
  const seen: string[] = []
  const state = { running: 0, most: 0, replies: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      seen.push(body.messages.at(-1)?.content)
      state.running += 1
      state.most = Math.max(state.most, state.running)
      const reply = `reply ${++state.replies}`
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            held.push(() => {
              state.running -= 1
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: "stop" }] })}\n\n` +
                    "data: [DONE]\n\n",
                ),
              )
              controller.close()
            })
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return {
    url: server.url.toString(),
    seen,
    most: () => state.most,
    release: () => held.shift()?.(),
    stop: () => {
      held.splice(0).forEach((finish) => finish())
      void server.stop()
    },
  }
}
