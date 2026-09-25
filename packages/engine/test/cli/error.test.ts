import { describe, expect, test } from "bun:test"
import { AccountTransportError } from "../../src/account/schema"
import { FormatError } from "../../src/cli/error"
import { UI } from "../../src/cli/ui"

describe("cli.error", () => {
  test("formats legacy and tagged config errors the same way", () => {
    const cases = [
      {
        tag: "ConfigJsonError",
        data: { path: "/tmp/vector.jsonc", message: "Unexpected token" },
        expected: "Config file at /tmp/vector.jsonc is not valid JSON(C): Unexpected token",
      },
      {
        tag: "ConfigDirectoryTypoError",
        data: { path: "/tmp/vector.jsonc", dir: ".vector", suggestion: "vector" },
        expected:
          'Directory ".vector" in /tmp/vector.jsonc is not valid. Rename the directory to "vector" or remove it. This is a common typo.',
      },
      {
        tag: "ConfigFrontmatterError",
        data: { path: "/tmp/AGENTS.md", message: "failed frontmatter" },
        expected: "failed frontmatter",
      },
      {
        tag: "ConfigInvalidError",
        data: {
          path: "/tmp/vector.jsonc",
          message: "schema mismatch",
          issues: [{ message: "Expected string", path: ["provider", "id"] }],
        },
        expected: "Configuration is invalid at /tmp/vector.jsonc: schema mismatch\n↳ Expected string provider.id",
      },
    ]

    for (const item of cases) {
      expect(FormatError({ name: item.tag, data: item.data })).toBe(item.expected)
      expect(FormatError({ _tag: item.tag, ...item.data })).toBe(item.expected)
    }
  })

  test("preserves multiline JSONC diagnostics for tagged config errors", () => {
    const data = {
      path: "/tmp/vector.jsonc",
      message:
        '\n--- JSONC Input ---\n{\n  "model": \n}\n--- Errors ---\nValueExpected at line 3, column 1\n   Line 3: }\n          ^\n--- End ---',
    }
    const expected = `Config file at ${data.path} is not valid JSON(C): ${data.message}`

    expect(FormatError({ name: "ConfigJsonError", data })).toBe(expected)
    expect(FormatError({ _tag: "ConfigJsonError", ...data })).toBe(expected)
  })

  test("formats account transport errors clearly", () => {
    const error = new AccountTransportError({
      method: "POST",
      url: "https://auth.example.test/auth/device/code",
    })

    const formatted = FormatError(error)

    expect(formatted).toContain("Could not reach POST https://auth.example.test/auth/device/code.")
    expect(formatted).toContain("This failed before the server returned an HTTP response.")
    expect(formatted).toContain("Check your network, proxy, or VPN configuration and try again.")
  })

  test("formats legacy and tagged provider model errors the same way", () => {
    const data = {
      providerID: "anthropic",
      modelID: "claude-sonet-4",
      suggestions: ["claude-sonnet-4"],
    }
    const expected = [
      "Model not found: anthropic/claude-sonet-4",
      "Did you mean: claude-sonnet-4",
      "Try: `vector models` to list available models",
      "Or check your config (vector.json) provider/model names",
    ].join("\n")

    expect(FormatError({ name: "ProviderModelNotFoundError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderModelNotFoundError", ...data })).toBe(expected)
  })

  test("formats legacy and tagged provider init errors the same way", () => {
    const data = { providerID: "anthropic" }
    const expected = 'Failed to initialize provider "anthropic". Check credentials and configuration.'

    expect(FormatError({ name: "ProviderInitError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderInitError", ...data })).toBe(expected)
  })

  test("formats cancelled UI errors as empty output", () => {
    expect(FormatError(new UI.CancelledError())).toBe("")
  })
})

test("ignored provider credentials replace model spelling suggestions with a recovery action", () => {
  const data = {
    providerID: "openai",
    modelID: "gpt-5",
    suggestions: ["gpt-4.1"],
    unavailable: { id: "openai", reason: "sign-in-paused", message: "Sign-in paused; add an API key." },
  }
  for (const error of [
    { name: "ProviderModelNotFoundError", data },
    { _tag: "ProviderModelNotFoundError", ...data },
  ]) {
    expect(FormatError(error)).toBe("Model unavailable: openai/gpt-5\nSign-in paused; add an API key.")
  }
})
