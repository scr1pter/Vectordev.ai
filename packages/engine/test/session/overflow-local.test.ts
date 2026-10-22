import { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { expect } from "bun:test"
import { streamText, tool } from "ai"
import { Effect, Fiber, Layer, Stream } from "effect"
import { createServer } from "node:net"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { refusal, requirement, usable } from "../../src/session/overflow"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { Global } from "@vectordevai/core/global"
import { Config } from "@/config/config"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"

// What a model on a server someone hosts must hold, end to end against the fake model server on 127.0.0.1: the
// agent's fixed prompt plus headroom, measured for that agent on that model. The strict guard checks nothing leaves.
// Two addresses on the user's network that the strict guard keeps on this computer: it sends their requests to the fake
// server on 127.0.0.1, the way a server on the user's network would answer them.
const LISTED = "10.1.2.3"
const UNLISTED = "10.1.2.4"
// In the range the company's policy lists.
const RANGED = "10.9.0.7"
const guard = NetworkGuard.use({ names: [LISTED, UNLISTED, RANGED] })
const CLOUD_ORIGIN = "https://api.cloud.invalid"
const COMPANY_ORIGIN = "https://llm.corp.example.com"

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("qwen-7b") }

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  LLM.node,
  SpendGuard.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
  ModelSlots.node,
])

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
    [
      [SessionSummary.node, summary],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

it.live("an agent's requirement is its fixed prompt plus headroom, and a small context says what it needs", () =>
  Effect.sync(() => {
    expect(requirement(0)).toBe(0)
    expect(requirement(10_000)).toBe(14_096)
    expect(requirement(40_000)).toBe(50_000)
    const model = (context: number) => ({ ...base(), id: ModelV2.ID.make("qwen-7b"), limit: { context, output: 0 } })
    expect(refusal({ model: model(8_192), fixed: 14_000, agent: "build" })).toBe(
      "qwen-7b has an 8,192-token context. Vector's agent needs about 19,000. Raise the context size (Ollama: num_ctx) or pick another model.",
    )
    expect(refusal({ model: model(16_384), fixed: 14_000, agent: "explore" })).toBe(
      "qwen-7b has a 16,384-token context. Vector's explore agent needs about 19,000. Raise the context size (Ollama: num_ctx) or pick another model.",
    )
    expect(refusal({ model: model(0), fixed: 14_000, agent: "build" })).toBe(
      "qwen-7b has no listed context size. Vector's agent needs about 19,000 tokens. Set limit.context for this model in your config, or pick another model.",
    )
    expect(refusal({ model: model(32_768), fixed: 14_000, agent: "build" })).toBeUndefined()
    // Nothing fixed, nothing that must fit.
    expect(refusal({ model: model(0), fixed: 0, agent: "build" })).toBeUndefined()
  }),
)

it.live("a model with no listed output limit leaves its window open instead of compacting on every step", () =>
  Effect.sync(() => {
    const model = (context: number) => ({ ...base(), limit: { context, output: 0 } })
    // A 16K model asked for the default 32K reply would have no window at all.
    expect(usable({ cfg: {}, model: model(16_384) })).toBe(12_288)
    // No listed context, no guessed one: such a model never compacts on its own.
    expect(usable({ cfg: {}, model: model(0) })).toBe(0)
  }),
)

it.live("a 16K model is refused for the agent with the requirement measured, and nothing reaches the server", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "fix the bug")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
        // About 15,000 tokens of system prompt, as a long repository instruction file makes.
        const value = yield* handle.process(input(chat.id, parent.id, model, agent("build"), "rule ".repeat(12_000)))

        expect(value).toBe("stop")
        const error = handle.message.error
        expect(SessionV1.APIError.isInstance(error)).toBe(true)
        if (!SessionV1.APIError.isInstance(error)) return
        const needed = Number(/needs about ([\d,]+)/.exec(error.data.message)?.[1]?.replaceAll(",", ""))
        expect(error.data.message).toStartWith("qwen-7b has a 16,384-token context. Vector's agent needs about ")
        expect(error.data.message).toEndWith("Raise the context size (Ollama: num_ctx) or pick another model.")
        expect(needed).toBeGreaterThan(19_000)
        expect(needed).toBeLessThan(25_000)
        expect(error.data.isRetryable).toBe(false)
        expect(yield* llm.calls).toBe(0)
      }),
    { trusted: true, config: (url) => providerCfg(url, 16_384) },
  ),
)

it.live("the same model still runs titles and compaction, which hold no fixed agent prompt to fit", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const llmService = yield* LLM.Service
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "fix the bug")

        yield* llm.text("A bug fix")
        const title = yield* llmService
          .stream({
            ...input(chat.id, parent.id, model, { ...agent("title"), hidden: true }, ""),
            small: true,
            tools: {},
          })
          .pipe(Stream.runCollect)
        expect([...title].some((event) => event.type === "text-delta")).toBe(true)

        yield* llm.text("Summary of the work so far")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
        const value = yield* handle.process(
          input(chat.id, parent.id, model, { ...agent("compaction"), hidden: true }, "rule ".repeat(12_000)),
        )
        expect(value).toBe("continue")
        expect(handle.message.error).toBeUndefined()
        expect(yield* llm.calls).toBe(2)
        // The title's reply is held to a few hundred tokens, so it never holds a single-slot server for long.
        const sent = (yield* llm.inputs).map((body) => body.max_tokens)
        expect(sent[0]).toBe(Provider.BRIEF_REPLY)
        expect(sent[1]).not.toBe(Provider.BRIEF_REPLY)
      }),
    { trusted: true, config: (url) => providerCfg(url, 16_384) },
  ),
)

it.live("an agent whose prompt fits runs, and its steps on this computer have no per-token price", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const spend = yield* SpendGuard.Service
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const chat = yield* session.create({})
        yield* spend.begin(chat.id, { usd: 1 })
        const parent = yield* user(chat.id, "fix the bug")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        yield* llm.push(reply().text("fixed").usage({ input: 100, output: 10 }).stop())
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
        const value = yield* handle.process(input(chat.id, parent.id, model, agent("build"), "rule ".repeat(100)))

        expect(value).toBe("continue")
        expect(handle.message.error).toBeUndefined()
        const run = yield* spend.snapshot(chat.id)
        expect(run?.costKind).toBe("local")
        expect(run?.unpricedSteps).toBe(0)
        expect(guard.outside()).toEqual([])
      }),
    { trusted: true, config: (url) => providerCfg(url, 32_768) },
  ),
)

it.live("a root session's new prompt drops a helper waiting for the same server", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const gate = Promise.withResolvers<void>()
        yield* llm.hold("first answer", gate.promise)

        const first = yield* session.create({})
        const asked = yield* user(first.id, "fix the bug")
        const turn = yield* processors.create({
          assistantMessage: yield* assistant(first.id, asked.id, path.resolve(dir)),
          sessionID: first.id,
          model,
        })
        const running = yield* turn.process(input(first.id, asked.id, model, agent("build"), "")).pipe(Effect.forkChild)
        yield* llm.wait(1)

        // A request the session processor did not make, such as a title, waits while the turn holds the server.
        const failed: { error?: unknown } = {}
        const title = streamText({
          model: yield* provider.getLanguage(model),
          onError: ({ error }) => {
            failed.error = error
          },
          messages: [{ role: "user", content: "Generate a title for this conversation" }],
        })
        const dropped = Promise.resolve(title.text).then(
          () => undefined,
          () => failed.error,
        )
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
        expect(yield* llm.calls).toBe(1)

        // Another root session starts on a new prompt.
        const second = yield* session.create({})
        const next = yield* user(second.id, "add a test")
        yield* processors.create({
          assistantMessage: yield* assistant(second.id, next.id, path.resolve(dir)),
          sessionID: second.id,
          model,
        })
        expect(yield* Effect.promise(() => dropped)).toMatchObject({ name: "AbortError" })
        gate.resolve()
        expect(yield* Fiber.join(running)).toBe("continue")
        expect(yield* llm.calls).toBe(1)
      }),
    { trusted: true, config: (url) => providerCfg(url, 32_768) },
  ),
)

it.live("a server on this computer that nothing answers at says how to fix it while Vector retries", () =>
  Effect.gen(function* () {
    const port = yield* Effect.promise(closedPort)
    const origin = `http://127.0.0.1:${port}`
    return yield* provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const processors = yield* SessionProcessor.Service
          const session = yield* Session.Service
          const provider = yield* Provider.Service
          const status = yield* SessionStatus.Service
          const model = yield* provider.getModel(ref.providerID, ref.modelID)
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "fix the bug")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
          const running = yield* handle
            .process(input(chat.id, parent.id, model, agent("build"), ""))
            .pipe(Effect.forkChild)

          const retrying = yield* Effect.gen(function* () {
            for (const _ of Array.from({ length: 500 })) {
              const info = yield* status.get(chat.id)
              if (info.type === "retry") return info
              yield* Effect.sleep("20 millis")
            }
            return yield* Effect.die(new Error("the session never retried"))
          })
          expect(retrying.message).toStartWith(
            `Nothing answered at ${origin}. Start the model server, or check its address and port. The error was: `,
          )
          yield* Fiber.interrupt(running)
          expect(yield* llm.calls).toBe(0)
          expect(guard.outside()).toEqual([])
        }),
      { trusted: true, config: () => providerCfg(`${origin}/v1`, 32_768) },
    )
  }),
)

it.live(
  "a private server's steps cost nothing once the user or the company lists it, and are unpriced until then",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const at = (host: string) => llm.url.replace("127.0.0.1", host)
      // Plain http to the user's network is the user's own config to set, not a repository's. The user lists one server;
      // the company's policy lists a range of addresses.
      return yield* serverList(
        {
          user: [new URL(at(LISTED)).origin],
          managed: ["10.9.0.0/16"],
          provider: servers({ listed: at(LISTED), ranged: at(RANGED), unlisted: at(UNLISTED) }, 32_768).provider,
        },
        () =>
          provideTmpdirServer(
            ({ dir }) =>
              Effect.gen(function* () {
                const processors = yield* SessionProcessor.Service
                const session = yield* Session.Service
                const provider = yield* Provider.Service
                const spend = yield* SpendGuard.Service
                const kinds: Record<string, unknown> = {}
                for (const providerID of ["listed", "ranged", "unlisted"]) {
                  const model = yield* provider.getModel(ProviderV2.ID.make(providerID), ref.modelID)
                  const chat = yield* session.create({})
                  yield* spend.begin(chat.id, { usd: 1 })
                  const parent = yield* user(chat.id, "fix the bug")
                  yield* llm.push(reply().text("fixed").usage({ input: 100, output: 10 }).stop())
                  const handle = yield* processors.create({
                    assistantMessage: yield* assistant(chat.id, parent.id, path.resolve(dir)),
                    sessionID: chat.id,
                    model,
                  })
                  expect(yield* handle.process(input(chat.id, parent.id, model, agent("build"), ""))).toBe("continue")
                  kinds[providerID] = (yield* spend.snapshot(chat.id))?.costKind
                }
                // A server elsewhere on the network may pass prompts on to a paid service until someone lists it.
                expect(kinds).toEqual({ listed: "local", ranged: "local", unlisted: "unknown" })
                expect(yield* llm.calls).toBe(3)
                expect(guard.outside()).toEqual([])
              }),
            { trusted: true },
          ),
      )
    }),
)

it.live(
  "a company endpoint on the server list is checked like a server someone hosts, and its steps stay unpriced",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        serverList({ user: [COMPANY_ORIGIN] }, () =>
          Effect.gen(function* () {
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            const provider = yield* Provider.Service
            const spend = yield* SpendGuard.Service
            const run = (providerID: string) =>
              Effect.gen(function* () {
                const model = yield* provider.getModel(ProviderV2.ID.make(providerID), ref.modelID)
                const chat = yield* session.create({})
                yield* spend.begin(chat.id, { usd: 1 })
                const parent = yield* user(chat.id, "fix the bug")
                const handle = yield* processors.create({
                  assistantMessage: yield* assistant(chat.id, parent.id, path.resolve(dir)),
                  sessionID: chat.id,
                  model,
                })
                const value = yield* handle.process(
                  input(chat.id, parent.id, model, agent("build"), "rule ".repeat(12_000)),
                )
                return { value, error: handle.message.error, kind: (yield* spend.snapshot(chat.id))?.costKind }
              })
            // Its name looks like any host on the internet, but it is on the list: a 16K model is refused for the agent.
            const small = yield* run("small")
            expect(small.value).toBe("stop")
            expect(small.error).toMatchObject({ data: { message: expect.stringContaining("16,384-token context") } })
            expect(yield* llm.calls).toBe(0)
            // A model that fits runs, and its steps count as unpriced: a company endpoint is never local.
            yield* llm.push(reply().text("fixed").usage({ input: 100, output: 10 }).stop())
            const large = yield* run("large")
            expect(large.value).toBe("continue")
            expect(large.kind).toBe("unknown")
            expect(guard.outside()).toEqual([])
          }),
        ),
      {
        trusted: true,
        // A plugin's `preconnect` names where the provider's requests go; here they reach the fake server instead.
        config: (url) => ({
          provider: {
            ...servers({ small: url }, 16_384, COMPANY_ORIGIN).provider,
            ...servers({ large: url }, 65_536, COMPANY_ORIGIN).provider,
          },
        }),
      },
    ),
)

it.live("a cloud API whose provider sets concurrency keeps the user's turn in its line when a new prompt arrives", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const slots = yield* ModelSlots.Service
        const model = yield* provider.getModel(ProviderV2.ID.make("cloud"), ref.modelID)
        // Another request holds the API's one permit, so the turn waits in line and never reaches the network.
        const holder = yield* Effect.promise(() =>
          slots.acquire({ origin: CLOUD_ORIGIN, permits: 1, priority: "user" }),
        )
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "fix the bug")
        const turn = yield* processors.create({
          assistantMessage: yield* assistant(chat.id, parent.id, path.resolve(dir)),
          sessionID: chat.id,
          model,
        })
        const running = yield* turn.process(input(chat.id, parent.id, model, agent("build"), "")).pipe(Effect.forkChild)
        yield* waitFor(() => slots.queue(CLOUD_ORIGIN).waiting === 1)

        // Another root session's new prompt drops waiting helpers; the user's turn is not one.
        const other = yield* session.create({})
        const next = yield* user(other.id, "add a test")
        yield* processors.create({
          assistantMessage: yield* assistant(other.id, next.id, path.resolve(dir)),
          sessionID: other.id,
          model,
        })
        yield* Effect.sleep("50 millis")
        expect(slots.queue(CLOUD_ORIGIN)).toEqual({ permits: 1, running: 1, waiting: 1 })
        expect(turn.message.error).toBeUndefined()

        // Stopping the turn takes it out of the line, and the permit's holder gives it back.
        yield* Fiber.interrupt(running)
        yield* waitFor(() => slots.queue(CLOUD_ORIGIN).waiting === 0)
        expect(slots.queue(CLOUD_ORIGIN)).toEqual({ permits: 1, running: 1, waiting: 0 })
        holder()
        expect(guard.outside()).toEqual([])
      }),
    {
      trusted: true,
      config: () => ({
        provider: {
          cloud: {
            ...servers({ cloud: `${CLOUD_ORIGIN}/v1` }, 32_768).provider.cloud,
            options: { apiKey: "test-key", baseURL: `${CLOUD_ORIGIN}/v1`, concurrency: 1 },
          },
        },
      }),
    },
  ),
)

it.live("a server on this computer that refuses the connection itself gets the same fix, in the runtime's words", () =>
  Effect.gen(function* () {
    const port = yield* Effect.promise(closedPort)
    const origin = `http://127.0.0.1:${port}`
    // The request goes straight to the closed port rather than through the strict guard's own proxy, so the error is
    // the one the runtime gives when nothing listens.
    return yield* direct(
      provideTmpdirServer(
        ({ dir }) =>
          Effect.gen(function* () {
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            const provider = yield* Provider.Service
            const status = yield* SessionStatus.Service
            const model = yield* provider.getModel(ref.providerID, ref.modelID)
            const chat = yield* session.create({})
            const parent = yield* user(chat.id, "fix the bug")
            const handle = yield* processors.create({
              assistantMessage: yield* assistant(chat.id, parent.id, path.resolve(dir)),
              sessionID: chat.id,
              model,
            })
            const running = yield* handle
              .process(input(chat.id, parent.id, model, agent("build"), ""))
              .pipe(Effect.forkChild)
            const retrying = yield* Effect.gen(function* () {
              for (const _ of Array.from({ length: 500 })) {
                const info = yield* status.get(chat.id)
                if (info.type === "retry") return info
                yield* Effect.sleep("20 millis")
              }
              return yield* Effect.die(new Error("the session never retried"))
            })
            expect(retrying.message).toStartWith(
              `Nothing answered at ${origin}. Start the model server, or check its address and port. The error was: `,
            )
            expect(retrying.message).not.toContain("Could not reach")
            yield* Fiber.interrupt(running)
            expect(guard.outside()).toEqual([])
          }),
        { trusted: true, config: () => providerCfg(`${origin}/v1`, 32_768) },
      ),
    )
  }),
)

// A loopback port nothing listens on: one the system just handed out and took back.
async function closedPort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === "string") throw new Error("no port was handed out")
  return address.port
}

// Waits for a condition the test cannot be told about.
const waitFor = (check: () => boolean) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 500 })) {
      if (check()) return
      yield* Effect.sleep("10 millis")
    }
    yield* Effect.die(new Error("timed out waiting"))
  })

// Runs `body` with requests to 127.0.0.1 sent around the proxy environment, as NO_PROXY does for a local model server.
// Bun reads NO_PROXY at each request; it is emptied again, never deleted, since Bun would not see it set again.
const direct = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy }
      process.env.NO_PROXY = "127.0.0.1"
      process.env.no_proxy = "127.0.0.1"
      return saved
    }),
    () => body,
    (saved) =>
      Effect.sync(() => {
        process.env.NO_PROXY = saved.upper ?? ""
        process.env.no_proxy = saved.lower ?? ""
      }),
  )

// Puts servers on the model server list for `body`: the user's own entries in their config, and the company's in the
// managed policy. A loosening edit waits for the owner, who says yes here; both are taken off again afterwards.
const serverList = <A, E, R>(
  input: {
    readonly user?: readonly string[]
    readonly managed?: readonly string[]
    /** Providers for the user's own config, read when the repository's instance starts. */
    readonly provider?: Record<string, unknown>
  },
  body: () => Effect.Effect<A, E, R>,
) => {
  const globalFile = path.join(Global.Path.config, "vector.json")
  const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
  const apply = () => {
    Config.refreshLocal()
    Config.confirmLocal()
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      writeFileSync(globalFile, JSON.stringify({ provider: input.provider, local: { endpoints: input.user ?? [] } }))
      if (input.managed) {
        mkdirSync(managedDirectory, { recursive: true })
        writeFileSync(
          path.join(managedDirectory, "vector.json"),
          JSON.stringify({ local: { endpoints: input.managed } }),
        )
      }
      apply()
    }),
    body,
    () =>
      Effect.sync(() => {
        rmSync(globalFile, { force: true })
        rmSync(managedDirectory, { recursive: true, force: true })
        apply()
        rmSync(Config.localConfirmedFile(), { force: true })
      }),
  )
}

// Providers that each serve qwen-7b with this context from their own address. With `preconnect`, a plugin names where
// their requests go, which decides where they count as being.
function servers(urls: Readonly<Record<string, string>>, context: number, preconnect?: string) {
  return {
    provider: Object.fromEntries(
      Object.entries(urls).map(([id, url]) => [
        id,
        {
          ...providerCfg(url, context).provider.lmstudio,
          name: id,
          id,
          options: { apiKey: "test-key", baseURL: url, ...(preconnect ? { preconnect } : {}) },
        },
      ]),
    ),
  }
}

function providerCfg(url: string, context: number) {
  return {
    provider: {
      lmstudio: {
        name: "LM Studio",
        id: "lmstudio",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "qwen-7b": {
            id: "qwen-7b",
            name: "Qwen 7B",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context, output: 0 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

function agent(name: string): Agent.Info {
  return {
    name,
    mode: "primary",
    options: {},
    prompt: "You are Vector's agent.",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function input(
  sessionID: SessionID,
  parentID: MessageID,
  model: Provider.Model,
  info: Agent.Info,
  system: string,
): LLM.StreamInput {
  return {
    user: {
      id: parentID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: info.name,
      model: ref,
    } satisfies SessionV1.User,
    sessionID,
    model,
    agent: info,
    system: system ? [system] : [],
    messages: [{ role: "user", content: "fix the bug" }],
    tools: {
      read: tool({
        description: "Read a file in the repository.",
        inputSchema: z.object({ path: z.string().describe("The file to read") }),
        execute: async () => "",
      }),
    },
  }
}

function base(): Provider.Model {
  return {
    id: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("lmstudio"),
    api: { id: "test", url: "http://127.0.0.1:1234/v1", npm: "@ai-sdk/openai-compatible" },
    name: "Test",
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})
