import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { ReviewModel } from "../../src/review/model"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const modalities = { text: true, audio: false, image: false, video: false, pdf: false }

function model(name: string, input: { context?: number; input?: number; output?: number; cacheRead?: number } = {}) {
  const ref = Provider.parseModel(name)
  return {
    id: ref.modelID,
    providerID: ref.providerID,
    api: { id: ref.modelID, url: "https://models.invalid/v1", npm: "@ai-sdk/openai-compatible" },
    name,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: modalities,
      output: modalities,
      interleaved: false,
    },
    cost: { input: input.input ?? 0, output: input.output ?? 0, cache: { read: input.cacheRead ?? 0, write: 0 } },
    limit: { context: input.context ?? 128_000, output: 8_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } satisfies Provider.Model
}

const MODELS = [
  model("acme/auto", { input: 1, output: 2 }),
  model("acme/json", { input: 1, output: 2 }),
  model("acme/env", { input: 1, output: 2 }),
  model("acme/flag", { input: 1, output: 2 }),
  model("acme/agent", { input: 1, output: 2 }),
  model("acme/default", { input: 1, output: 2 }),
  model("anthropic/sonnet", { input: 3, output: 15, cacheRead: 0.3 }),
  model("openai/gpt", { input: 1.25, output: 10, cacheRead: 0.125 }),
  model("local/unpriced"),
  model("tiny/small", { context: 16_000, input: 1, output: 1 }),
]

interface Setup {
  defaultModel?: string
  agent?: { model?: string; variant?: string }
  oauth?: string[]
}

const services = (setup: Setup) =>
  Layer.mergeAll(
    Layer.mock(Provider.Service, {
      getModel: (providerID, modelID) => {
        const found = MODELS.find((item) => item.providerID === providerID && item.id === modelID)
        return found ? Effect.succeed(found) : Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
      },
      defaultModel: () =>
        setup.defaultModel
          ? Effect.succeed(Provider.parseModel(setup.defaultModel))
          : Effect.fail(
              new Provider.ModelNotFoundError({
                providerID: ProviderV2.ID.make("none"),
                modelID: ModelV2.ID.make("none"),
              }),
            ),
    }),
    TestConfig.layer({ get: () => Effect.succeed(setup.agent ? { agent: { review: setup.agent } } : {}) }),
    Layer.mock(Auth.Service, {
      get: (providerID) =>
        Effect.succeed(
          setup.oauth?.includes(providerID)
            ? new Auth.Oauth({
                type: "oauth",
                refresh: "refresh-placeholder",
                access: "access-placeholder",
                expires: 0,
              })
            : undefined,
        ),
    }),
  )

const resolve = (input: ReviewModel.ResolveInput, setup: Setup = {}) =>
  ReviewModel.resolveReviewModel(input).pipe(Effect.provide(services(setup)))

const chosen = (input: ReviewModel.ResolveInput, setup: Setup = {}) =>
  resolve(input, setup).pipe(Effect.map((resolved) => `${resolved.providerID}/${resolved.modelID}`))

describe("ReviewModel.resolveReviewModel order", () => {
  it.effect("automatic CI runs take REVIEW_AUTO_MODEL, then review.json, then MODEL", () =>
    Effect.gen(function* () {
      const env = { REVIEW_AUTO_MODEL: "acme/auto", MODEL: "acme/env" }
      expect(yield* chosen({ trigger: "auto", config: "acme/json", env })).toBe("acme/auto")
      expect(yield* chosen({ trigger: "auto", config: "acme/json", env: { MODEL: "acme/env" } })).toBe("acme/json")
      expect(yield* chosen({ trigger: "auto", env: { MODEL: "acme/env" } })).toBe("acme/env")
      // Project config and the user's default model play no part in CI.
      expect(
        (yield* resolve(
          { trigger: "auto", env: {} },
          { agent: { model: "acme/agent" }, defaultModel: "acme/default" },
        ).pipe(Effect.flip)).message,
      ).toContain("No review model is set")
    }),
  )

  it.effect("commands ignore REVIEW_AUTO_MODEL and agent.review.model", () =>
    Effect.gen(function* () {
      const env = { REVIEW_AUTO_MODEL: "acme/auto", MODEL: "acme/env" }
      expect(yield* chosen({ trigger: "command", env })).toBe("acme/env")
      expect(yield* chosen({ trigger: "command", config: "acme/json", env }, { agent: { model: "acme/agent" } })).toBe(
        "acme/json",
      )
      expect(
        (yield* resolve({ trigger: "command", env: { REVIEW_AUTO_MODEL: "acme/auto" } }).pipe(Effect.flip)).message,
      ).toContain("No review model is set")
    }),
  )

  it.effect("local runs take --model, review.json, agent.review.model, the default model", () =>
    Effect.gen(function* () {
      const env = { MODEL: "acme/env", REVIEW_AUTO_MODEL: "acme/auto" }
      const setup = { agent: { model: "acme/agent", variant: "high" }, defaultModel: "acme/default" }
      expect(yield* chosen({ trigger: "local", flag: "acme/flag", config: "acme/json", env }, setup)).toBe("acme/flag")
      expect(yield* chosen({ trigger: "local", config: "acme/json", env }, setup)).toBe("acme/json")
      const agent = yield* resolve({ trigger: "local", env }, setup)
      expect(`${agent.providerID}/${agent.modelID}`).toBe("acme/agent")
      expect(agent.variant).toBe("high")
      expect(yield* chosen({ trigger: "desktop", env }, { defaultModel: "acme/default" })).toBe("acme/default")
      expect((yield* resolve({ trigger: "local", env }).pipe(Effect.flip)).message).toContain("No review model is set")
    }),
  )
})

describe("ReviewModel.resolveReviewModel cost", () => {
  it.effect("tells subscription, unknown and priced models apart", () =>
    Effect.gen(function* () {
      const plan = yield* resolve({ trigger: "command", env: { MODEL: "anthropic/sonnet" } }, { oauth: ["anthropic"] })
      expect(plan.costKind).toBe("plan")
      expect(plan.price).toBeUndefined()

      const unknown = yield* resolve({ trigger: "command", env: { MODEL: "local/unpriced" } })
      expect(unknown.costKind).toBe("unknown")
      expect(unknown.price).toBeUndefined()

      const priced = yield* resolve({ trigger: "command", env: { MODEL: "openai/gpt" } })
      expect(priced.costKind).toBe("priced")
      expect(priced.price).toEqual({ input: 1.25, output: 10, cacheRead: 0.125 })
      expect(priced.context).toBe(128_000)
    }),
  )
})

describe("ReviewModel.resolveReviewModel refusals", () => {
  it.effect("refuses a model with less than 32k tokens of context", () =>
    Effect.gen(function* () {
      const error = yield* resolve({ trigger: "command", env: { MODEL: "tiny/small" } }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ReviewModel.ReviewModelError)
      expect(error.message).toBe(
        "Vectorscope reviews need a model with at least 32k tokens of context; tiny/small has 16k.",
      )
    }),
  )

  it.effect("rejects a malformed or unavailable model instead of falling back", () =>
    Effect.gen(function* () {
      const malformed = yield* resolve({ trigger: "command", env: { MODEL: "nonsense" } }).pipe(Effect.flip)
      expect(malformed.message).toBe('Invalid model nonsense. Model must be in the format "provider/model".')
      const missing = yield* resolve({ trigger: "local", flag: "acme/missing" }).pipe(Effect.flip)
      expect(missing.message).toContain("acme/missing is not available")
    }),
  )
})
