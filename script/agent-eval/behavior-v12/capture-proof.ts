import { expect, test } from "bun:test"
import { capture } from "./capture"
import { scripted } from "./scripted"

test("retains a non-200 response without recording headers or inventing zero usage", async () => {
  const result = await capture(new Response('{"error":"unauthorized"}', { status: 401, headers: { "x-private": "FAKE_PRIVATE_HEADER" } }), "gpt-6-luna")
  expect(result.bytes.toString()).toBe('{"error":"unauthorized"}')
  expect(result.evidence.httpStatus).toBe(401)
  expect(result.evidence.errorCode).toBe("HTTP_STATUS_401")
  expect(result.evidence.success).toBe(false)
  expect(result.evidence.projectedUsage).toBeNull()
  expect(JSON.stringify(result)).not.toContain("FAKE_PRIVATE_HEADER")
})

test("preserves reported usage on a failed HTTP response without passing it", async () => {
  const result = await capture(new Response(scripted("gpt-6-luna", { text: "fixture" }, 1), { status: 429 }), "gpt-6-luna")
  expect(result.evidence.httpStatus).toBe(429)
  expect(result.evidence.errorCode).toBe("HTTP_STATUS_429")
  expect(result.evidence.success).toBe(false)
  expect(result.evidence.projectedUsage.input_tokens).toBe(100)
  expect(result.evidence.projectedUsage.output_tokens).toBe(10)
})

test("retains partial wire evidence after stream failure", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n')) },
    pull(controller) { controller.error(new Error("synthetic disconnect")) },
  })
  const result = await capture(new Response(stream), "gpt-6-luna")
  expect(result.bytes.toString()).toContain("response.created")
  expect(result.evidence.errorCode).toBe("STREAM_READ_FAILED")
  expect(result.evidence.projectedUsage).toBeNull()
  expect(result.evidence.success).toBe(false)
})

test("caps retained failure bytes and rejects a missing response body", async () => {
  const result = await capture(new Response(new Uint8Array(4 * 1024 * 1024 + 1)), "gpt-6-luna")
  expect(result.bytes.byteLength).toBe(4 * 1024 * 1024)
  expect(result.evidence.errorCode).toBe("STREAM_BYTE_LIMIT")
  const empty = await capture(new Response(null, { status: 204 }), "gpt-6-luna")
  expect(empty.evidence.errorCode).toBe("RESPONSE_BODY_MISSING")
  expect(empty.evidence.success).toBe(false)
})
