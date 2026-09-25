import { expect, test } from "bun:test"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { freeModelRequest, serializeFreeModelRequest } from "../src/free-model-request"

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
