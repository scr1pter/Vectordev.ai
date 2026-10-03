import { describe, expect, test } from "bun:test"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { UsageService } from "@/acp/usage"
import { Provider } from "@/provider/provider"
import { Effect, Layer } from "effect"
import { it } from "../lib/effect"

const assistant = (
  input: Partial<UsageService.AssistantMessage> & Pick<UsageService.AssistantMessage, "cost">,
): UsageService.SessionMessage => ({
  info: {
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet",
    tokens: {
      input: 10,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...input,
  },
})

const user = (): UsageService.SessionMessage => ({
  info: { role: "user" },
})

const assistantWithoutProvider = (): UsageService.SessionMessage => ({
  info: {
    role: "assistant",
    modelID: "claude-sonnet",
    cost: 1,
    tokens: {
      input: 10,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  },
})

const model = (providerID: ProviderV2.ID, modelID: ModelV2.ID, context: number): Provider.Model => ({
  id: modelID,
  providerID,
  api: {
    id: modelID,
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: modelID,
  family: "test",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  },
  limit: {
    context,
    output: 4096,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

const providers = (context = 128_000): Record<ProviderV2.ID, Provider.Info> => {
  const providerID = ProviderV2.ID.make("anthropic")
  const modelID = ModelV2.ID.make("claude-sonnet")
  return {
    [providerID]: {
      id: providerID,
      name: "Anthropic",
      source: "config",
      env: [],
      options: {},
      models: {
        [modelID]: model(providerID, modelID, context),
      },
    },
  }
}

const fakeLayer = (input: {
  readonly messages?: Effect.Effect<readonly UsageService.SessionMessage[], unknown>
  readonly providers?: (directory: string) => Effect.Effect<Record<ProviderV2.ID, Provider.Info>, unknown>
}) =>
  LayerNode.compile(UsageService.node, [
    [
      UsageService.messageLoaderNode,
      Layer.succeed(
        UsageService.MessageLoader,
        UsageService.MessageLoader.of({
          messages: () => input.messages ?? Effect.succeed([]),
        }),
      ),
    ],
    [
      UsageService.contextLimitLoaderNode,
      Layer.succeed(
        UsageService.ContextLimitLoader,
        UsageService.ContextLimitLoader.of({
          providers: input.providers ?? (() => Effect.succeed(providers())),
        }),
      ),
    ],
  ])

const connection = (updates: SessionNotification[]) => ({
  sessionUpdate(params: SessionNotification) {
    updates.push(params)
    return Promise.resolve()
  },
})

describe("acp usage", () => {
  test("builds ACP Usage from assistant token shape", () => {
    expect(
      UsageService.buildUsage({
        cost: 0.02,
        tokens: {
          input: 100,
          output: 40,
          reasoning: 7,
          cache: { read: 11, write: 13 },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      thoughtTokens: 7,
      cachedReadTokens: 11,
      cachedWriteTokens: 13,
      totalTokens: 171,
    })
  })

  test("omits optional token fields when they are zero", () => {
    expect(
      UsageService.buildUsage({
        cost: 0,
        tokens: {
          input: 3,
          output: 4,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    })
  })

  test("finds the latest assistant message", () => {
    expect(
      UsageService.latestAssistantMessage([assistant({ cost: 1, modelID: "older" }), user(), assistant({ cost: 2 })]),
    ).toMatchObject({ cost: 2 })
  })

  test("measures the context from the last response that reported usage", () => {
    const cancelled = assistant({
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(UsageService.latestAssistantMessage([assistant({ cost: 1 }), user(), cancelled])).toMatchObject({ cost: 1 })
  })

  test("counts cache reads and writes in the context in use", () => {
    expect(
      UsageService.contextTokens({
        cost: 0,
        tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 5_000, write: 18_000 } },
      }),
    ).toBe(23_020)
  })

  test("a turn's usage sums every provider step that answered its user message", () => {
    const step = (parentID: string, input: number) =>
      assistant({ cost: 0.1, parentID, tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } })
    expect(UsageService.turnUsage([step("msg_a", 999), step("msg_b", 30_000), step("msg_b", 31_000)], "msg_b")).toEqual(
      { inputTokens: 61_000, outputTokens: 20, totalTokens: 61_020 },
    )
    expect(UsageService.turnUsage([step("msg_a", 1)], "msg_missing")).toBeUndefined()
  })

  test("calculates total session cost from assistant messages", () => {
    expect(UsageService.totalSessionCost([assistant({ cost: 1.25 }), user(), assistant({ cost: 2.5 })])).toBe(3.75)
    // A response with no listed price makes the total unknown, so it is left out of the update rather than sent short.
    expect(
      UsageService.totalSessionCost([assistant({ cost: 1.25 }), assistant({ cost: 0, unpriced: true })]),
    ).toBeUndefined()
  })

  it.effect("loads context limits from providers and caches by directory/provider/model", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      const first = yield* usage.contextLimit({
        directory: "/workspace",
        providerID: ProviderV2.ID.make("anthropic"),
        modelID: ModelV2.ID.make("claude-sonnet"),
      })
      const second = yield* usage.contextLimit({
        directory: "/workspace",
        providerID: ProviderV2.ID.make("anthropic"),
        modelID: ModelV2.ID.make("claude-sonnet"),
      })

      expect(first).toBe(200_000)
      expect(second).toBe(200_000)
      expect(calls).toEqual(["/workspace"])
    }).pipe(
      Effect.provide(
        fakeLayer({
          providers: (directory) =>
            Effect.sync(() => {
              calls.push(directory)
              return providers(200_000)
            }),
        }),
      ),
    )
  })

  it.effect("sends ACP usage_update with context size and cumulative assistant cost", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([
        {
          sessionId: "ses_1",
          update: {
            sessionUpdate: "usage_update",
            used: 15,
            size: 128_000,
            cost: { amount: 3, currency: "USD" },
          },
        },
      ])
    }).pipe(
      Effect.provide(
        fakeLayer({
          messages: Effect.succeed([
            assistant({ cost: 1 }),
            assistant({
              cost: 2,
              tokens: {
                input: 10,
                output: 20,
                reasoning: 0,
                cache: { read: 5, write: 0 },
              },
            }),
          ]),
        }),
      ),
    )
  })

  it.effect("skips usage update when messages cannot be fetched", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([])
    }).pipe(Effect.provide(fakeLayer({ messages: Effect.fail(new Error("boom")) })))
  })

  it.effect("skips usage update when no assistant message exists", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([])
    }).pipe(Effect.provide(fakeLayer({ messages: Effect.succeed([user()]) })))
  })

  it.effect("skips usage update when assistant message has no provider or model", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([])
    }).pipe(
      Effect.provide(
        fakeLayer({
          messages: Effect.succeed([assistantWithoutProvider()]),
        }),
      ),
    )
  })

  it.effect("skips usage update when context size is unknown", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([])
    }).pipe(
      Effect.provide(
        fakeLayer({
          messages: Effect.succeed([assistant({ cost: 1, providerID: "missing" })]),
        }),
      ),
    )
  })
})
