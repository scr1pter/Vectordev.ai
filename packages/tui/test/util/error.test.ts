import { describe, expect, test } from "bun:test"
import { FREE_MODELS_OWN_KEYS_TERMINAL } from "@vectordevai/core/free-model-choice"
import { cliErrorMessage, errorData, errorFormat, errorMessage } from "../../src/util/error"

describe("util.error", () => {
  test("formats native Error instances", () => {
    const err = new Error("boom")
    expect(errorMessage(err)).toBe("boom")
    expect(errorFormat(err)).toContain("boom")

    const data = errorData(err)
    expect(data.type).toBe("Error")
    expect(data.message).toBe("boom")
    expect(String(data.formatted)).toContain("boom")
  })

  test("extracts message from record-like values", () => {
    const err = { message: "bad input", code: "E_BAD" }
    expect(errorMessage(err)).toBe("bad input")

    const data = errorData(err)
    expect(data.message).toBe("bad input")
    expect(data.code).toBe("E_BAD")
  })

  test("never returns bare {} for opaque object errors", () => {
    expect(errorFormat({})).not.toBe("{}")
    expect(errorFormat({})).toContain("no message")

    class OpaqueError {}
    const opaque = new OpaqueError()
    Object.defineProperty(opaque, "secret", { value: "hidden", enumerable: false })
    expect(errorFormat(opaque)).not.toBe("{}")
    expect(errorFormat(opaque)).toContain("OpaqueError")
  })

  test("handles opaque throwables with custom toString", () => {
    const err = {
      toString() {
        return "ResolveMessage: Cannot resolve module"
      },
    }

    expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")

    const data = errorData(err)
    expect(data.message).toBe("ResolveMessage: Cannot resolve module")
    expect(String(data.formatted)).toContain("ResolveMessage")
  })
})

// Owner, 23 October 2026: a free-model limit says free tokens ran out, never that an allowance shared with others did.
test("a free-model limit says free tokens ran out and when more are available, without the upstream text", () => {
  const limit = (reason: string) => ({
    name: "FreeModelsLimitError",
    data: { reason, resetAt: Date.UTC(2030, 0, 1, 12), message: "RAW_UPSTREAM_TEXT" },
  })
  expect(cliErrorMessage(limit("user_daily"))).toStartWith(
    "You've run out of free tokens for today. More free tokens are available at",
  )
  expect(cliErrorMessage(limit("shared_daily"))).toStartWith(
    "Free tokens have run out for today. More free tokens are available at",
  )
  // Only a daily limit means free tokens ran out (owner's wording review, 23 October 2026).
  expect(cliErrorMessage(limit("user_minute"))).toStartWith(
    "Give the free models provided by Vector a moment. Try again at",
  )
  expect(cliErrorMessage(limit("upstream"))).not.toContain("More free tokens")
  for (const reason of ["user_daily", "user_minute", "shared_daily", "upstream", "balance"]) {
    const text = cliErrorMessage(limit(reason)) ?? ""
    expect(text).toEndWith(FREE_MODELS_OWN_KEYS_TERMINAL)
    expect(text).not.toMatch(/allowance|\bshared\b|\bpool(?:ed)?\b|RAW_UPSTREAM_TEXT/i)
  }
})
