import { describe, expect, test } from "bun:test"
import { collectSecretValues, REDACTED, redactSecrets } from "@vectordevai/core/review/redact"

// Placeholders only. Token shapes are assembled at runtime so no token-like literal sits in the source.
const env = {
  GITHUB_TOKEN: "placeholder-github-token-value",
  ANTHROPIC_API_KEY: "placeholder-anthropic-key-0001",
  SESSION_SECRET: "  padded-secret-placeholder  ",
  DB_PASSWORD: "short",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\nplaceholderlinenumberone\nplaceholderlinenumbertwo\n-----END PRIVATE KEY-----",
  EMPTY_TOKEN: "",
  UNSET_TOKEN: undefined,
}

describe("collectSecretValues", () => {
  const values = collectSecretValues(env)

  test("collects values of *_TOKEN, *_KEY, *_SECRET and *_PASSWORD of 12 characters or more", () => {
    expect(values).toContain("placeholder-github-token-value")
    expect(values).toContain("placeholder-anthropic-key-0001")
    expect(values).toContain("padded-secret-placeholder")
    expect(values).not.toContain("short")
    expect(values).not.toContain(env.PATH)
  })

  test("adds each line of a multi-line value, without the PEM markers", () => {
    expect(values).toContain("placeholderlinenumberone")
    expect(values).toContain("placeholderlinenumbertwo")
    expect(values).not.toContain("-----END PRIVATE KEY-----")
  })

  test("sorts the longest first", () => {
    expect(values).toEqual(values.toSorted((a, b) => b.length - a.length))
  })
})

describe("redactSecrets", () => {
  const values = collectSecretValues(env)

  test("replaces values from the environment", () => {
    expect(redactSecrets("used placeholder-github-token-value here", values)).toBe(`used ${REDACTED} here`)
    expect(redactSecrets("line placeholderlinenumbertwo leaked", values)).toBe(`line ${REDACTED} leaked`)
  })

  test("replaces token shapes that are not in the environment", () => {
    const shapes = [
      "ghp_" + "a1".repeat(18),
      "gho_" + "b2".repeat(18),
      "ghs_" + "c3".repeat(18),
      "github_pat_" + "d4_".repeat(10),
      "sk-" + "e5".repeat(12),
      "sk-ant-api03-" + "f6-".repeat(10),
      "xoxb-" + "123456789012-abcdefghij",
      "AKIA" + "ABCDEFGHIJKLMNOP",
    ]
    for (const shape of shapes) expect(redactSecrets(`key: ${shape}.`, [])).toBe(`key: ${REDACTED}.`)
  })

  test("leaves short values and look-alikes alone", () => {
    expect(redactSecrets("the password is short", values)).toBe("the password is short")
    expect(redactSecrets("abc short", ["short"])).toBe("abc short")
    for (const text of ["task-runner-configuration-file", "risk-assessment-document-name", "sk-short", "ghp_short"])
      expect(redactSecrets(text, [])).toBe(text)
  })
})
