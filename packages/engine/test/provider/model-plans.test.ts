import { afterAll, afterEach, expect, test } from "bun:test"
import { APICallError } from "ai"
import { Effect, Layer, Schema, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Usage } from "@vectordevai/llm"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { Session } from "@/session/session"
import { SessionRetry } from "@/session/retry"
import { usable } from "@/session/overflow"
import { CODIUM_MODELS } from "../../../../api/_lib/codium-catalog"
import { codiumGateway, codiumModel } from "../../../core/test/fixture/codium-gateway"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const token = "vct_synthetic-private-account.token"
const gateway = codiumGateway(token)
afterAll(() => gateway.stop())
const entitlement = { enabled: true }
const account = { token: token as string | undefined }
const it = testEffect(
  LayerNode.compile(Provider.node, [
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([]),
      }),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "vector" ? account.token : undefined),
      }),
    ],
    [
      ModelPlans.node,
      Layer.succeed(ModelPlans.Service, {
        catalog: (value) =>
          Effect.succeed(
            entitlement.enabled && value === token
              ? { enabled: true, models: [codiumModel] }
              : { enabled: false, models: [] },
          ),
        request: gateway.forward,
      }),
    ],
  ]),
)
const id = ProviderV2.ID.make(ModelPlans.PROVIDER_ID)

it.instance(
  "Codium publishes the account's models without credentials and replaces project overrides",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const listed = (yield* provider.list())[id]
      expect(listed.name).toBe("Vector Codium")
      expect(Object.keys(listed.models)).toEqual([codiumModel.id])
      expect(JSON.stringify(listed)).not.toContain(token)
      expect(listed.options).toEqual({})
      const selected = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id))
      expect(selected.api.url).toBe(ModelPlans.API_URL)
      expect(selected.freeModel).toBeUndefined()
      expect(selected.cost.input).toBe(codiumModel.inputPrice)
      expect(selected.cost.output).toBe(codiumModel.outputPrice)
      expect((yield* provider.getLanguage(selected)).provider).toContain(ModelPlans.PROVIDER_ID)
      entitlement.enabled = false
      expect((yield* provider.list())[id]).toBeUndefined()
      const missing = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id)).pipe(Effect.flip)
      expect(missing).toMatchObject({ codium: "unavailable" })
      expect(missing.message).toContain("Vector Codium is not available right now")
      entitlement.enabled = true
      account.token = undefined
      const signedOut = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id)).pipe(Effect.flip)
      expect(signedOut).toMatchObject({ codium: "sign-in" })
      expect(signedOut.message).toContain("Sign in to Vector to use Vector Codium")
      account.token = token
      expect((yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id))).api.url).toBe(ModelPlans.API_URL)
    }),
  {
    trusted: true,
    config: {
      model: `${ModelPlans.PROVIDER_ID}/${codiumModel.id}`,
      provider: {
        [ModelPlans.PROVIDER_ID]: {
          name: "injected",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://attacker.invalid", apiKey: "injected" },
          models: { "vendor/expensive": { cost: { input: 100, output: 100 } } },
        },
      },
    },
  },
)

it.instance("a Codium turn streams text and a tool call through the gateway and records the billed cost", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const selected = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id))
    const language = yield* provider.getLanguage(selected)
    const before = gateway.seen.length
    const result = yield* Effect.promise(() =>
      language.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "read src/a.ts" }] }],
        tools: [
          {
            type: "function",
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      }),
    )
    const parts = Array.from(
      yield* Stream.runCollect(Stream.fromReadableStream({ evaluate: () => result.stream, onError: (cause) => cause })),
    )
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join(""),
    ).toBe("Reading the file.")
    const call = parts.find((part) => part.type === "tool-call")
    expect(call).toMatchObject({ toolName: "read", toolCallId: "call_1" })
    if (call?.type !== "tool-call") throw new Error("Expected a tool call")
    expect(JSON.parse(call.input)).toEqual({ path: "src/a.ts" })
    const finish = parts.find((part) => part.type === "finish")
    if (finish?.type !== "finish") throw new Error("Expected a finish part")
    expect(finish.providerMetadata?.codium).toEqual({ cost: 0.00042 })
    // Listed prices are ceilings; the step records what the gateway reports it billed.
    const usage = Session.getUsage({
      model: selected,
      usage: new Usage({ inputTokens: 1000, outputTokens: 50 }),
      metadata: finish.providerMetadata,
    })
    expect(usage.cost).toBe(0.00042)
    expect(usage.unpriced).toBe(false)
    const sent = gateway.seen.slice(before)
    expect(sent.map((item) => item.path)).toEqual(["/api/model-plans/chat"])
    expect(sent[0].authorization).toBe(`Bearer ${token}`)
    expect(sent[0].body).toMatchObject({ model: codiumModel.id, stream: true, tools: [{ type: "function" }] })
  }),
)

it.instance("an out-of-credits or disabled gateway fails the turn once, with an action and no retry", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const selected = yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id))
    const language = yield* provider.getLanguage(selected)
    for (const [mode, kind, message] of [
      [
        "credits",
        "credits",
        `Your included model credits are used up. They renew at the next billing period. Buy credits at ${ModelPlans.PURCHASE_URL}`,
      ],
      ["disabled", "unavailable", "Vector Codium is not available yet. Choose another model."],
    ] as const) {
      gateway.state.mode = mode
      const before = gateway.seen.length
      const error = yield* Effect.promise(() =>
        language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      )
      if (!APICallError.isInstance(error)) throw error
      const parsed = ProviderError.parseAPICallError({ providerID: id, error })
      expect(parsed).toMatchObject({ type: "api_error", message, isRetryable: false, metadata: { codium: kind } })
      if (parsed.type !== "api_error") throw new Error("Expected an API error")
      const recorded = new SessionV1.APIError({
        message: parsed.message,
        statusCode: parsed.statusCode,
        isRetryable: parsed.isRetryable,
        metadata: parsed.metadata,
      }).toObject()
      // A 503 would normally be retried; a Codium availability answer is final.
      expect(SessionRetry.retryable(recorded, id)).toBeUndefined()
      expect(JSON.stringify(recorded)).not.toContain(token)
      expect(gateway.seen.slice(before).map((item) => item.path)).toEqual(["/api/model-plans/chat"])
    }
    gateway.state.mode = "context"
    const overflow = yield* Effect.promise(() =>
      language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    )
    if (!APICallError.isInstance(overflow)) throw overflow
    expect(ProviderError.parseAPICallError({ providerID: id, error: overflow }).type).toBe("context_overflow")
    gateway.state.mode = "ok"
  }),
)

it.instance("short Codium capacity is retried like a busy provider, with no purchase prompt", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language = yield* provider.getLanguage(yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id)))
    gateway.state.mode = "capacity"
    const error = yield* Effect.promise(() =>
      language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    )
    gateway.state.mode = "ok"
    if (!APICallError.isInstance(error)) throw error
    const parsed = ProviderError.parseAPICallError({ providerID: id, error })
    expect(parsed).toMatchObject({
      type: "api_error",
      message: "Vector Codium is short of model capacity for a moment. Vector will try again shortly.",
      isRetryable: true,
    })
    if (parsed.type !== "api_error") throw new Error("Expected an API error")
    expect(parsed.metadata?.codium).toBeUndefined()
    const recorded = new SessionV1.APIError({
      message: parsed.message,
      statusCode: parsed.statusCode,
      isRetryable: parsed.isRetryable,
      metadata: parsed.metadata,
    }).toObject()
    expect(SessionRetry.retryable(recorded, id)).toEqual({ message: parsed.message })
  }),
)

it.instance("a turn after signing out fails before any request and offers Sign in to Vector", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language = yield* provider.getLanguage(yield* provider.getModel(id, ModelV2.ID.make(codiumModel.id)))
    const before = gateway.seen.length
    account.token = undefined
    const error = yield* Effect.promise(() =>
      language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    )
    account.token = token
    if (!APICallError.isInstance(error)) throw error
    expect(ProviderError.parseAPICallError({ providerID: id, error })).toMatchObject({
      type: "api_error",
      message: "Sign in to Vector to use Vector Codium.",
      isRetryable: false,
      metadata: { codium: "sign-in" },
    })
    expect(gateway.seen.length).toBe(before)
  }),
)

it.instance(
  "Codium is never the automatic default while another provider can run",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect((yield* provider.list())[id]).toBeDefined()
      expect(yield* provider.defaultModel()).toEqual({
        providerID: ProviderV2.ID.make("local"),
        modelID: ModelV2.ID.make("coder"),
      })
    }),
  {
    trusted: true,
    config: {
      provider: {
        local: {
          name: "Local",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:9/v1" },
          models: { coder: { name: "Local coder", tool_call: true } },
        },
      },
    },
  },
)

it.instance(
  "Codium alone is still not chosen automatically; the person is asked to pick a Codium model",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect(Object.keys(yield* provider.list())).toEqual([id])
      const error = yield* provider.defaultModel().pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "ProviderNoProvidersError", codium: true })
      expect(error.message).toContain("Vector never chooses it for you")
    }),
  { trusted: true, config: { enabled_providers: [ModelPlans.PROVIDER_ID] } },
)

it.instance("a Codium title stays on credits and records the gateway charge exactly once", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const selected = yield* provider.getSmallModel(id, ModelV2.ID.make(codiumModel.id))
    if (!selected) throw new Error("Missing Codium title model")
    expect(selected.providerID).toBe(id)
    const language = yield* provider.getLanguage(selected)
    gateway.state.mode = "text"
    const before = gateway.seen.length
    const response = yield* Effect.promise(() =>
      language.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Generate a concise session title" }] }],
      }),
    )
    const parts = Array.from(
      yield* Stream.runCollect(
        Stream.fromReadableStream({ evaluate: () => response.stream, onError: (cause) => cause }),
      ),
    )
    gateway.state.mode = "ok"
    const finish = parts.find((part) => part.type === "finish")
    if (finish?.type !== "finish") throw new Error("Missing title usage")
    expect(finish.providerMetadata?.codium).toEqual({ cost: 0.000031 })
    expect(
      Session.getUsage({
        model: selected,
        usage: new Usage({ inputTokens: 200, outputTokens: 6 }),
        metadata: finish.providerMetadata,
      }).cost,
    ).toBe(0.000031)
    expect(gateway.seen.slice(before).map((request) => request.path)).toEqual(["/api/model-plans/chat"])
  }),
)

test("Vector compacts each reviewed Codium conversation once a step reaches the window less a full reply", () => {
  // The gateway's context checks are sized against this threshold; see packages/web/test/model-plan-context.test.ts.
  const cfg = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  const provider = Provider.fromModelPlans(CODIUM_MODELS)
  expect(CODIUM_MODELS.map((model) => usable({ cfg, model: provider.models[model.id] }))).toEqual(
    CODIUM_MODELS.map((model) => model.contextLength - model.maxOutputTokens),
  )
})
