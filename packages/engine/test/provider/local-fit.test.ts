import { afterEach, expect } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { streamText, tool } from "ai"
import z from "zod"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { Effect } from "effect"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Model servers someone hosts, end to end through the provider: a fake OpenAI-compatible server on 127.0.0.1 counts
// how many requests it is answering at once and holds each reply until the test lets it go. Nothing leaves this
// computer; the strict guard checks.
const guard = NetworkGuard.use()

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, ModelSlots.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

const LOCAL = ProviderV2.ID.make("local")
const OTHER = ProviderV2.ID.make("other")
const CLOUD = ProviderV2.ID.make("cloud")
const MODEL = ModelV2.ID.make("qwen")

it.live("two providers that point at one server share its permit", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const first = yield* turn(provider, LOCAL, "user", "first")
          const second = yield* turn(provider, OTHER, "user", "second")
          yield* until(() => server.seen.length === 1)
          // The second provider's request waits for the first one's permit instead of reaching the server.
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen.map(said)).toEqual(["first"])
          server.release()
          yield* until(() => server.seen.length === 2)
          server.release()
          expect(yield* Effect.promise(() => Promise.all([first, second]))).toEqual(["reply 1", "reply 2"])
          expect(server.most).toBe(1)
        }),
      // Only the first provider says the server takes one request at a time; the second shares that limit.
      { trusted: true, config: config(server.url, { other: true, concurrency: 1 }) },
    ),
  ),
)

it.live("a server whose number nobody configured takes the user's turn and subagents at once", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const replies = yield* Effect.all([
            turn(provider, LOCAL, "user", "the user's turn"),
            turn(provider, LOCAL, "subagent", "subagent 1"),
            turn(provider, LOCAL, "subagent", "subagent 2"),
          ])
          // The server queues them itself; Vector holds none back.
          yield* until(() => server.seen.length === 3)
          server.release()
          server.release()
          server.release()
          yield* Effect.promise(() => Promise.all(replies))
          expect(server.most).toBe(3)
        }),
      { trusted: true, config: config(server.url) },
    ),
  ),
)

it.live("a provider's concurrency lets that many requests reach its server at once", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const replies = yield* Effect.all([1, 2, 3].map((n) => turn(provider, LOCAL, "user", `ask ${n}`)))
          yield* until(() => server.seen.length === 2)
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen).toHaveLength(2)
          server.release()
          server.release()
          yield* until(() => server.seen.length === 3)
          server.release()
          yield* Effect.promise(() => Promise.all(replies))
          expect(server.most).toBe(2)
        }),
      { trusted: true, config: config(server.url, { concurrency: 2 }) },
    ),
  ),
)

it.live("helpers wait behind the user's turn, and a new prompt drops a waiting helper", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const slots = yield* ModelSlots.Service
          const user = yield* turn(provider, LOCAL, "user", "the user's turn")
          yield* until(() => server.seen.length === 1)
          // A model the session processor did not name is a helper, such as a title.
          const title = yield* turn(provider, LOCAL, undefined, "a title")
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen.map(said)).toEqual(["the user's turn"])
          slots.prompted()
          const dropped = yield* Effect.promise(() =>
            title.then(
              () => undefined,
              (error: unknown) => error,
            ),
          )
          expect(dropped).toMatchObject({ name: "AbortError" })
          // Another helper waits until the user's reply ends, then runs.
          const summary = yield* turn(provider, LOCAL, undefined, "a summary")
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen).toHaveLength(1)
          server.release()
          yield* until(() => server.seen.length === 2)
          expect(server.seen.map(said)).toEqual(["the user's turn", "a summary"])
          server.release()
          expect(yield* Effect.promise(() => Promise.all([user, summary]))).toEqual(["reply 1", "reply 2"])
        }),
      { trusted: true, config: config(server.url) },
    ),
  ),
)

it.live("the header timeout starts once a request holds its permit", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const first = yield* turn(provider, LOCAL, "user", "slow")
          yield* until(() => server.seen.length === 1)
          const second = yield* turn(provider, LOCAL, "user", "queued")
          // The queued request waits well past its header timeout for the permit, and still gets its reply.
          yield* Effect.promise(() => server.idle(2_500))
          server.release()
          yield* until(() => server.seen.length === 2)
          server.release()
          expect(yield* Effect.promise(() => Promise.all([first, second]))).toEqual(["reply 1", "reply 2"])
        }),
      { trusted: true, config: config(server.url, { headerTimeout: 1_000, concurrency: 1 }) },
    ),
  ),
)

it.live("four subagents on a single-slot server run one at a time, in the order they asked", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const replies: Promise<string>[] = []
          for (const n of [1, 2, 3, 4]) {
            replies.push(yield* turn(provider, LOCAL, "subagent", `subagent ${n}`))
            yield* Effect.promise(() => server.idle(10))
          }
          for (const n of [1, 2, 3, 4]) {
            yield* until(() => server.seen.length === n)
            yield* Effect.promise(() => server.idle(20))
            expect(server.seen).toHaveLength(n)
            server.release()
          }
          expect(yield* Effect.promise(() => Promise.all(replies))).toEqual([
            "reply 1",
            "reply 2",
            "reply 3",
            "reply 4",
          ])
          expect(server.seen.map(said)).toEqual(["subagent 1", "subagent 2", "subagent 3", "subagent 4"])
          expect(server.most).toBe(1)
        }),
      { trusted: true, config: config(server.url, { concurrency: 1 }) },
    ),
  ),
)

it.live("two providers that configure different counts for one server both hold to the smaller one", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          // The provider that says 3 still waits by the other's 1, so their requests never take turns lifting it.
          const replies = yield* Effect.all([
            turn(provider, OTHER, "user", "first"),
            turn(provider, LOCAL, "user", "second"),
            turn(provider, OTHER, "user", "third"),
          ])
          for (const n of [1, 2, 3]) {
            yield* until(() => server.seen.length === n)
            yield* Effect.promise(() => server.idle(30))
            expect(server.seen).toHaveLength(n)
            server.release()
          }
          yield* Effect.promise(() => Promise.all(replies))
          expect(server.most).toBe(1)
        }),
      { trusted: true, config: config(server.url, { other: true, concurrency: 1, otherConcurrency: 3 }) },
    ),
  ),
)

it.live("a request stopped while it holds the server's permit gives it back, so the next one runs", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const stop = new AbortController()
          const first = yield* turn(provider, LOCAL, "user", "stopped", stop.signal)
          yield* until(() => server.seen.length === 1)
          const second = yield* turn(provider, LOCAL, "subagent", "next")
          yield* Effect.promise(() => server.idle(50))
          expect(server.seen).toHaveLength(1)
          stop.abort()
          const stopped = yield* Effect.promise(() =>
            first.then(
              () => undefined,
              (error: unknown) => error,
            ),
          )
          expect(stopped).toMatchObject({ name: "AbortError" })
          yield* until(() => server.seen.length === 2)
          expect(server.seen.map(said)).toEqual(["stopped", "next"])
          server.release()
          server.release()
          expect(yield* Effect.promise(() => second)).toBe("reply 2")
        }),
      { trusted: true, config: config(server.url, { concurrency: 1 }) },
    ),
  ),
)

it.live("a tool call that asks the same single-slot server again gets its answer instead of waiting forever", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          server.auto = true
          const provider = yield* Provider.Service
          const model = Provider.withPriority(yield* provider.getModel(LOCAL, MODEL), "user")
          const inner = Provider.withPriority(model, "subagent")
          const language = yield* provider.getLanguage(model)
          const innerLanguage = yield* provider.getLanguage(inner)
          // The tool runs as soon as its call arrives, while the reply that made the call still holds the server's one
          // permit. The SDK reads that reply to its end meanwhile, which gives the permit to the tool's own request.
          const result = streamText({
            model: language,
            messages: [{ role: "user", content: "ask the helper" }],
            tools: {
              ask: tool({
                description: "Ask the model server again.",
                inputSchema: z.object({ question: z.string() }),
                execute: async (input) =>
                  streamText({ model: innerLanguage, messages: [{ role: "user", content: input.question }] }).text,
              }),
            },
          })
          const answers = yield* Effect.promise(() => Promise.resolve(result.toolResults))
          expect(answers.map((item) => item.output)).toEqual(["reply 2"])
          expect(server.seen.map(said)).toEqual(["ask the helper", "what is 2 + 2?"])
          expect(server.most).toBe(1)
        }),
      { trusted: true, config: config(server.url, { concurrency: 1 }) },
    ),
  ),
)

it.live("a reply stays inside the context the server has left after the prompt", () =>
  withServer((server) =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          server.auto = true
          const provider = yield* Provider.Service
          const small = Provider.withPriority(yield* provider.getModel(LOCAL, MODEL), "user")
          // No output limit is listed, so the reply gets a quarter of the 4,096-token context.
          expect(ProviderTransform.maxOutputTokens(small)).toBe(1_024)
          const listed = Provider.withPriority(yield* provider.getModel(OTHER, MODEL), "user")
          expect(ProviderTransform.maxOutputTokens(listed)).toBe(8_192)
          const ask = (model: Provider.Model, text: string) =>
            Effect.gen(function* () {
              const result = streamText({
                model: yield* provider.getLanguage(model),
                maxOutputTokens: ProviderTransform.maxOutputTokens(model),
                messages: [{ role: "user", content: text }],
              })
              return yield* Effect.promise(() => result.text)
            })
          yield* ask(small, "short")
          yield* ask(listed, "short")
          yield* ask(listed, "x".repeat(6_000))
          const sent = server.seen.map((body) => body.max_tokens)
          expect(sent[0]).toBe(1_024)
          // An 8,192-token reply cannot fit a 4,096-token context: it gets what the prompt leaves.
          expect(sent[1]).toBeGreaterThan(4_000)
          expect(sent[1]).toBeLessThan(4_096)
          expect(sent[2]).toBeGreaterThan(1_000)
          expect(sent[2]).toBeLessThan(4_096 - 1_500)
        }),
      { trusted: true, config: config(server.url, { other: true, output: 8_192 }) },
    ),
  ),
)

it.live("a cloud API gets no permits, no new timeouts and no reply limit of its own", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const cloud = yield* provider.getModel(CLOUD, MODEL)
        // The same language model comes back each time: nothing wraps it.
        expect(yield* provider.getLanguage(cloud)).toBe(yield* provider.getLanguage(cloud))
        const local = yield* provider.getModel(LOCAL, MODEL)
        expect(yield* provider.getLanguage(local)).not.toBe(yield* provider.getLanguage(local))
        expect(guard.outside()).toEqual([])
      }),
    { trusted: true, config: config("http://127.0.0.1:1/v1", { cloud: true }) },
  ),
)

// One streamed request through the provider; resolves with the reply's text. `priority` is what the session processor
// names; undefined is any other caller, a helper.
function turn(
  provider: Provider.Interface,
  providerID: ProviderV2.ID,
  priority: ModelSlots.Priority | undefined,
  text: string,
  signal?: AbortSignal,
) {
  return Effect.gen(function* () {
    const found = yield* provider.getModel(providerID, MODEL)
    const model = priority ? Provider.withPriority(found, priority) : found
    const failed: { error?: unknown } = {}
    const result = streamText({
      model: yield* provider.getLanguage(model),
      abortSignal: signal,
      onError: ({ error }) => {
        failed.error = error
      },
      messages: [{ role: "user", content: text }],
    })
    // The stream's own error, rather than the SDK's "no output" that follows it.
    return Promise.resolve(result.text).catch((error: unknown) => Promise.reject(failed.error ?? error))
  })
}

function said(body: Record<string, any>) {
  return body.messages.at(-1)?.content
}

const until = (check: () => boolean) =>
  Effect.promise(async () => {
    const stop = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > stop) throw new Error("timed out waiting for the model server")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })

function config(
  url: string,
  options: {
    other?: boolean
    cloud?: boolean
    concurrency?: number
    otherConcurrency?: number
    headerTimeout?: number
    output?: number
  } = {},
) {
  const provider = (baseURL: string, output = 0, concurrency?: number) => ({
    name: "Model server",
    npm: "@ai-sdk/openai-compatible",
    models: {
      qwen: {
        id: "qwen",
        name: "qwen",
        tool_call: true,
        limit: { context: 4_096, output },
        cost: { input: 0, output: 0 },
      },
    },
    options: {
      apiKey: "test-key",
      baseURL,
      ...(concurrency ? { concurrency } : {}),
      ...(options.headerTimeout ? { headerTimeout: options.headerTimeout } : {}),
    },
  })
  return {
    formatter: false,
    lsp: false,
    provider: {
      local: provider(url, 0, options.concurrency),
      ...(options.other ? { other: provider(url, options.output, options.otherConcurrency) } : {}),
      ...(options.cloud ? { cloud: provider("https://api.cloud.invalid/v1") } : {}),
    },
  }
}

type Server = {
  readonly url: string
  /** Request bodies in the order they arrived. */
  readonly seen: Record<string, any>[]
  /** The most requests the server answered at once. */
  readonly most: number
  /** Answers at once instead of holding each reply. */
  auto: boolean
  /** Finishes the oldest reply still held. */
  readonly release: () => void
  /** Waits a while so a request that is not going to arrive has had its chance. */
  readonly idle: (ms: number) => Promise<void>
}

function withServer<A, E, R>(body: (server: Server) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(() => modelServer()),
    (started) => body(started.server),
    (started) => Effect.sync(() => started.close()),
  )
}

async function modelServer() {
  const held: (() => void)[] = []
  const state = { running: 0, most: 0, replies: 0 }
  const server: Server = {
    url: "",
    seen: [],
    get most() {
      return state.most
    },
    auto: false,
    release: () => held.shift()?.(),
    idle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      server.seen.push(JSON.parse(Buffer.concat(chunks).toString()))
      state.running += 1
      state.most = Math.max(state.most, state.running)
      const body = server.seen.at(-1)!
      const reply = `reply ${++state.replies}`
      // A request that offers tools gets a call to the first one, the way a model asks for more.
      const call = body.tools?.[0]?.function?.name
      const chunk = call
        ? {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: call, arguments: JSON.stringify({ question: "what is 2 + 2?" }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }
        : { choices: [{ delta: { content: reply } }] }
      // Headers go out at once, as a server does when it starts on a request; the reply comes when released.
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
      const finish = () => {
        state.running -= 1
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
      }
      if (server.auto) return finish()
      held.push(finish)
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("the model server did not bind to a TCP port")
  Object.assign(server, { url: `http://127.0.0.1:${address.port}/v1` })
  return {
    server,
    close: () => {
      held.splice(0).forEach((finish) => finish())
      http.close()
    },
  }
}
