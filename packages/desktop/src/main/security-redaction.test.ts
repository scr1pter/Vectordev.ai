import { describe, expect, test } from "bun:test"
import { redactText, redactValue } from "./security-redaction"

describe("security redaction", () => {
  test("removes headers, provider keys, and sensitive URL values", () => {
    const value = redactText(
      "Authorization: Bearer abc.def.ghi api_key=sk-abcdefghijklmnopqrstuvwxyz https://example.com/callback?code=secret-code&tab=logs",
    )
    expect(value).not.toContain("abc.def.ghi")
    expect(value).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(value).not.toContain("secret-code")
    expect(value).toContain("tab=logs")
  })

  test("redacts nested values by key without losing useful diagnostics", () => {
    const value = redactValue({
      provider: "anthropic",
      password: "hunter2",
      nested: { accessToken: "token-value", status: 401 },
    })
    expect(value).toEqual({
      provider: "anthropic",
      password: "[REDACTED]",
      nested: { accessToken: "[REDACTED]", status: 401 },
    })
  })
})
