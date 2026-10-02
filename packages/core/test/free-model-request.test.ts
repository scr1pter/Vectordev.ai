import { expect, test } from "bun:test"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { freeModelRequest, serializeFreeModelRequest } from "../src/free-model-request"

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
