import { describe, expect, test } from "bun:test"
import { Redaction } from "../src/redaction"

const stored = {
  provider: {
    custom: {
      options: {
        apiKey: "sk-secret",
        baseURL: "https://api.example.com",
        headers: { Authorization: "Bearer token-secret", "User-Agent": "vector" },
        maxTokens: 4096,
        setCacheKey: true,
      },
    },
  },
  mcp: {
    tools: { type: "local", command: ["tool"], environment: { GITHUB_TOKEN: "env-secret", DEBUG: "1" } },
  },
}

describe("Redaction", () => {
  test("redact replaces secret strings with the marker and keeps the shape", () => {
    expect(Redaction.redact(stored)).toEqual({
      provider: {
        custom: {
          options: {
            apiKey: Redaction.MARKER,
            baseURL: "https://api.example.com",
            headers: { Authorization: Redaction.MARKER, "User-Agent": "vector" },
            maxTokens: 4096,
            setCacheKey: true,
          },
        },
      },
      mcp: {
        tools: {
          type: "local",
          command: ["tool"],
          environment: { GITHUB_TOKEN: Redaction.MARKER, DEBUG: "1" },
        },
      },
    })
  })

  test("redactConfig marks secrets where config carries credentials", () => {
    expect(Redaction.redactConfig(stored)).toEqual(Redaction.redact(stored))
    expect(
      Redaction.redactConfig({
        plugin: ["plain", ["with-options", { apiKey: "plugin-secret", region: "us" }]],
        lsp: { ts: { command: ["ts"], env: { NPM_TOKEN: "lsp-secret" } } },
        agent: { build: { options: { apiKey: "agent-secret" } } },
      }),
    ).toEqual({
      plugin: ["plain", ["with-options", { apiKey: Redaction.MARKER, region: "us" }]],
      lsp: { ts: { command: ["ts"], env: { NPM_TOKEN: Redaction.MARKER } } },
      agent: { build: { options: { apiKey: Redaction.MARKER } } },
    })
  })

  test("redactConfig leaves permission rules with secret-looking patterns alone", () => {
    const config = {
      permission: { read: { "*.key": "deny", "cat *token": "ask" }, "*password": "deny" },
      agent: { build: { permission: { read: { "*.key": "deny" } } } },
    }
    expect(Redaction.redactConfig(config)).toEqual(config)
  })

  test("redact leaves an empty key alone, since it holds nothing", () => {
    expect(Redaction.redact({ apiKey: "" })).toEqual({ apiKey: "" })
  })

  test("omit drops secret fields whatever they hold", () => {
    expect<unknown>(Redaction.omit({ credentials: { private_key: "x" }, apiKey: "y", region: "us" })).toEqual({
      region: "us",
    })
  })

  test("unchanged drops the marker so a deep merge keeps the stored value", () => {
    const sent = Redaction.redact(stored)
    sent.provider.custom.options.baseURL = "https://changed.example.com"
    expect<unknown>(Redaction.unchanged(sent)).toEqual({
      provider: {
        custom: {
          options: {
            baseURL: "https://changed.example.com",
            headers: { "User-Agent": "vector" },
            maxTokens: 4096,
            setCacheKey: true,
          },
        },
      },
      mcp: { tools: { type: "local", command: ["tool"], environment: { DEBUG: "1" } } },
    })
  })

  test("unchanged keeps a new secret the client typed", () => {
    expect(Redaction.unchanged({ apiKey: "sk-new" })).toEqual({ apiKey: "sk-new" })
  })

  test("restore puts the stored secret back where the marker was", () => {
    const entry = Redaction.redact(stored.mcp.tools)
    expect(Redaction.restore(entry, stored.mcp.tools)).toEqual(stored.mcp.tools)
  })

  test("restore drops a marker with nothing stored behind it", () => {
    expect<unknown>(Redaction.restore({ environment: { TOKEN: Redaction.MARKER, DEBUG: "1" } }, undefined)).toEqual({
      environment: { DEBUG: "1" },
    })
  })
})
