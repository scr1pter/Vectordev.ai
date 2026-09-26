import { expect, test } from "bun:test"
import { APICallError } from "ai"
import { FreeModelsLimitError } from "@vectordevai/schema/free-model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"

const providerID = ProviderV2.ID.vector

function wrapped(cause: unknown) {
  return new APICallError({
    message: "Failed to process successful response",
    cause,
    url: "https://provider.fixture.test/chat/completions",
    requestBodyValues: {},
    statusCode: 200,
    responseHeaders: { "x-request-id": "fixture" },
  })
}

test.each([new ProviderError.HeaderTimeoutError(100), new ProviderError.ResponseStreamError("SSE read timed out")])(
  "nested SDK wrappers retain typed transport errors and retry policy: %s",
  (cause) => {
    const result = MessageV2.fromError(wrapped(wrapped(cause)), { providerID })
    expect(result).toEqual(MessageV2.fromError(cause, { providerID }))
    expect(result).toMatchObject({ name: "APIError", data: { isRetryable: true, metadata: { code: cause.name } } })
    expect(SessionRetry.retryable(result, providerID)).toEqual({ message: cause.message })
  },
)

test("nested SDK wrappers retain quota details without retrying", () => {
  const result = MessageV2.fromError(
    wrapped(
      wrapped(new FreeModelsLimitError({ reason: "shared_daily", resetAt: 456, message: "Shared allowance used" })),
    ),
    { providerID },
  )
  expect(result).toEqual({
    name: "FreeModelsLimitError",
    data: {
      code: "VECTOR_FREE_MODELS_LIMIT",
      reason: "shared_daily",
      resetAt: 456,
      message: "Shared allowance used",
    },
  })
  expect(SessionRetry.retryable(result, providerID)).toBeUndefined()
})

test.each([
  new Error("private implementation detail"),
  { _tag: "FreeModelsLimitError", reason: "invalid", resetAt: 456, message: "Invalid quota" },
])("unknown SDK causes retain the outer API error and HTTP metadata: %s", (cause) => {
  expect(MessageV2.fromError(wrapped(cause), { providerID })).toEqual({
    name: "APIError",
    data: {
      message: "Failed to process successful response",
      statusCode: 200,
      isRetryable: false,
      responseHeaders: { "x-request-id": "fixture" },
      responseBody: undefined,
      metadata: { url: "https://provider.fixture.test/chat/completions" },
    },
  })
})

test("cyclic SDK causes terminate without losing the outer API error", () => {
  const error = wrapped(undefined)
  Object.defineProperty(error, "cause", { value: wrapped(error) })
  expect(MessageV2.fromError(error, { providerID })).toMatchObject({
    name: "APIError",
    data: { message: error.message, statusCode: 200, responseHeaders: error.responseHeaders },
  })
})

test("ordinary error wrappers are not treated as SDK transport failures", () => {
  const error = new Error("Outer error", { cause: new ProviderError.ResponseStreamError("Inner stream error") })
  expect(MessageV2.fromError(error, { providerID })).toMatchObject({
    name: "UnknownError",
    data: { message: "Outer error" },
  })
})
