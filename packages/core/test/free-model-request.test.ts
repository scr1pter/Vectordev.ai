import { expect, test } from "bun:test"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { FreeModelTrainingConsentError, freeModelRequest, serializeFreeModelRequest } from "../src/free-model-request"
import { FREE_MODEL_TRAINING_CONSENT_REQUIRED } from "../src/free-model-choice"

test("disables account-default plugins and preserves the safeguards through shared proxy normalization", () => {
  const request = freeModelRequest(
    {
      model: FREE_MODEL_FALLBACKS[0].id,
      messages: [{ role: "user", content: "hello" }],
      provider: { max_price: { prompt: 100 }, only: ["unreviewed"] },
      models: ["paid/model"],
      web_search_options: {},
    },
    FREE_MODEL_FALLBACKS,
  )
  expect(request.plugins).toEqual([
    { id: "web", enabled: false },
    { id: "file-parser", enabled: false },
    { id: "response-healing", enabled: false },
    { id: "context-compression", enabled: false },
    { id: "auto-router", enabled: false },
    { id: "pareto-router", enabled: false },
  ])
  expect(request.provider.max_price).toEqual({ prompt: 0, completion: 0, request: 0, image: 0 })
  expect(request.provider.only).not.toContain("unreviewed")
  expect(request.models).not.toContain("paid/model")
  expect(request).not.toHaveProperty("web_search_options")
  expect(freeModelRequest(JSON.parse(serializeFreeModelRequest(request, true)), FREE_MODEL_FALLBACKS)).toEqual(request)
  expect(freeModelRequest({ ...request, plugins: [] }, FREE_MODEL_FALLBACKS)).toEqual(request)
  expect(freeModelRequest({ ...request, plugins: [{ id: "web", enabled: false }] }, FREE_MODEL_FALLBACKS)).toEqual(
    request,
  )
})

test("routes to no-training, zero-price allowlisted endpoints only, without requiring zero data retention", () => {
  const request = freeModelRequest(
    {
      model: FREE_MODEL_FALLBACKS[0].id,
      messages: [{ role: "user", content: "hello" }],
      provider: { data_collection: "allow", zdr: false, allow_fallbacks: true, sort: "price" },
    },
    FREE_MODEL_FALLBACKS,
  )
  expect(request.provider).toEqual({
    data_collection: "deny",
    require_parameters: true,
    only: ["cohere", "atlas-cloud"],
    max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
  })
  expect(request.models).toEqual(FREE_MODEL_FALLBACKS.map((model) => model.id))
})

test("rejects active, unknown and configured plugin overrides before either inference route", () => {
  for (const plugins of [
    null,
    {},
    [null],
    [{ id: "web" }],
    [{ id: "web", enabled: true }],
    [{ id: "web", enabled: "false" }],
    [{ id: "unknown", enabled: false }],
    [{ id: "web", enabled: false, engine: "exa" }],
    [{ id: "auto-router", enabled: false, allowed_models: ["paid/model"] }],
    [
      { id: "web", enabled: false },
      { id: "web", enabled: true },
    ],
  ])
    expect(() =>
      freeModelRequest(
        { model: FREE_MODEL_FALLBACKS[0].id, messages: [{ role: "user", content: "hello" }], plugins },
        FREE_MODEL_FALLBACKS,
      ),
    ).toThrow("Paid plugins")
})

test("refuses routing shortcuts and malformed free IDs even when catalog metadata includes them", () => {
  for (const id of [
    "openrouter/auto",
    "openrouter/auto:free",
    "openrouter/auto-beta:free",
    "openrouter/pareto-code:free",
    "openrouter/free:free",
    "OpenRouter/auto:free",
    "maker/model:online:free",
    "maker/model:nitro:free",
    "maker/model:free?plugin=web",
    "maker/model:free\n",
    "maker/model/extra:free",
  ]) {
    const models = [{ ...FREE_MODEL_FALLBACKS[0], id }, ...FREE_MODEL_FALLBACKS]
    expect(() => freeModelRequest({ model: id, messages: [{ role: "user", content: "hello" }] }, models)).toThrow(
      "no longer available",
    )
    expect(
      freeModelRequest({ model: FREE_MODEL_FALLBACKS[0].id, messages: [{ role: "user", content: "hello" }] }, models)
        .models,
    ).not.toContain(id)
  }
})

test("shared request limit counts serialized UTF-8 bytes at the boundary and leaves own-key requests unaffected", () => {
  const request = freeModelRequest(
    { model: FREE_MODEL_FALLBACKS[0].id, messages: [{ role: "user", content: "" }] },
    FREE_MODEL_FALLBACKS,
  )
  const remaining = 4_500_000 - new TextEncoder().encode(JSON.stringify(request)).byteLength
  const content = "é".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2)
  const boundary = { ...request, messages: [{ role: "user", content }] }
  expect(new TextEncoder().encode(serializeFreeModelRequest(boundary, true)).byteLength).toBe(4_500_000)
  const oversized = { ...request, messages: [{ role: "user", content: `${content}é` }] }
  expect(JSON.stringify(oversized).length).toBeLessThan(4_500_000)
  expect(() => serializeFreeModelRequest(oversized, true)).toThrow(
    "Context too large for the shared free allowance. Compact this conversation or connect OpenRouter to continue with your own account.",
  )
  expect(serializeFreeModelRequest(oversized, false)).toBe(JSON.stringify(oversized))
})

const mayTrain = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  contextLength: 262144,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
}
const lagunaXS = {
  ...mayTrain,
  id: "poolside/laguna-xs-2.1:free",
  name: "Poolside: Laguna XS 2.1",
  providers: [{ id: "poolside/fp8", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
}
const inkling = {
  id: "thinkingmachines/inkling:free",
  name: "Thinking Machines: Inkling",
  contextLength: 1048576,
  maxOutputTokens: 262144,
  toolChoice: false,
  providers: [
    { id: "thinkingmachines/nvfp4", name: "Thinking Machines", retention: "", dataPolicy: "may-train" as const },
  ],
}
const unreviewed = {
  id: "maker/new:free",
  name: "Maker: New",
  contextLength: 16000,
  maxOutputTokens: 4096,
  providers: [{ id: "maker", name: "Maker", retention: "", dataPolicy: "unreviewed" as const }],
}
const all = [mayTrain, inkling, unreviewed, ...FREE_MODEL_FALLBACKS, lagunaXS]
const hello = (model: string) => ({ model, messages: [{ role: "user", content: "hello" }] })

test("nothing is built for a may-train or unreviewed model until the user accepted, and no-training never asks", () => {
  for (const model of [mayTrain, inkling, unreviewed]) {
    expect(() => freeModelRequest(hello(model.id), all)).toThrow(FreeModelTrainingConsentError)
    expect(() => freeModelRequest(hello(model.id), all, { trainingConsent: false })).toThrow(
      FREE_MODEL_TRAINING_CONSENT_REQUIRED,
    )
  }
  expect(FREE_MODEL_TRAINING_CONSENT_REQUIRED).toContain("Vector itself never trains on your prompts")
  expect(FREE_MODEL_TRAINING_CONSENT_REQUIRED).toContain("Nothing was sent")
  expect(freeModelRequest(hello(FREE_MODEL_FALLBACKS[0].id), all).provider.data_collection).toBe("deny")
})

test("data collection is allowed only for an accepted, reviewed may-train model; unreviewed ones keep deny", () => {
  const accepted = { trainingConsent: true }
  expect(freeModelRequest(hello(mayTrain.id), all, accepted).provider).toEqual({
    data_collection: "allow",
    require_parameters: true,
    only: ["poolside/fp4", "poolside/fp8"],
    max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
  })
  expect(freeModelRequest(hello(unreviewed.id), all, accepted).provider.data_collection).toBe("deny")
  expect(freeModelRequest(hello(FREE_MODEL_FALLBACKS[0].id), all, accepted).provider.data_collection).toBe("deny")
  // The server rebuilds the same request from the client's, so a client cannot lift deny on its own.
  const client = freeModelRequest(hello(FREE_MODEL_FALLBACKS[0].id), all, accepted)
  expect(
    freeModelRequest({ ...client, provider: { ...client.provider, data_collection: "allow" } }, all, accepted).provider
      .data_collection,
  ).toBe("deny")
})

test("a fallback never weakens the chosen model's data policy", () => {
  // No-training and unreviewed choices fall back to no-training models only.
  for (const model of [FREE_MODEL_FALLBACKS[0].id, unreviewed.id])
    expect(freeModelRequest(hello(model), all, { trainingConsent: true }).models).toEqual(
      [model, ...FREE_MODEL_FALLBACKS.map((item) => item.id)]
        .filter((id, index, ids) => ids.indexOf(id) === index)
        .slice(0, 3),
    )
  // An accepted may-train choice falls back only to may-train models of the same provider: never to another
  // provider whose terms the user was not shown (Poolside's Laguna answered by Thinking Machines, whose free tier takes a
  // perpetual training licence), and never to a no-training model, which would then be sent data_collection "allow".
  expect(freeModelRequest(hello(mayTrain.id), all, { trainingConsent: true })).toMatchObject({
    models: [mayTrain.id, lagunaXS.id],
    provider: { data_collection: "allow", only: ["poolside/fp4", "poolside/fp8"] },
  })
  expect(freeModelRequest(hello(inkling.id), all, { trainingConsent: true })).toMatchObject({
    models: [inkling.id],
    provider: { data_collection: "allow", only: ["thinkingmachines/nvfp4"] },
  })
  // So "allow" reaches no request that could be served by a no-training model.
  for (const model of all) {
    const request = freeModelRequest(hello(model.id), all, { trainingConsent: true })
    if (request.provider.data_collection !== "allow") continue
    expect(
      request.models.filter((id) => all.find((item) => item.id === id)?.providers[0].dataPolicy !== "may-train"),
    ).toEqual([])
    expect(request.provider.only.filter((id) => !id.startsWith(model.providers[0].id.split("/")[0]))).toEqual([])
  }
})

test("an endpoint without tool_choice gets the same automatic request without it", () => {
  const tools = [{ type: "function", function: { name: "read" } }]
  const consent = { trainingConsent: true }
  expect(freeModelRequest({ ...hello(inkling.id), tools, tool_choice: "auto" }, all, consent)).not.toHaveProperty(
    "tool_choice",
  )
  expect(freeModelRequest({ ...hello(inkling.id), tools }, all, consent)).toMatchObject({ tools })
  // A forced choice is kept, so OpenRouter refuses it rather than silently ignoring it.
  expect(freeModelRequest({ ...hello(inkling.id), tools, tool_choice: "required" }, all, consent)).toMatchObject({
    tool_choice: "required",
  })
  expect(freeModelRequest({ ...hello(mayTrain.id), tools, tool_choice: "auto" }, all, consent)).toMatchObject({
    tool_choice: "auto",
  })
})
