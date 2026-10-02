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

  test("redactConfig marks an agent's own secret-named fields and keeps its permission rules", () => {
    const config = {
      agent: {
        build: { apiKey: "agent-top-secret", model: "custom/small", permission: { read: { "*.key": "deny" } } },
      },
      mode: { plan: { sessionToken: "mode-secret", prompt: "plan" } },
    }
    expect(Redaction.redactConfig(config)).toEqual({
      agent: {
        build: { apiKey: Redaction.MARKER, model: "custom/small", permission: { read: { "*.key": "deny" } } },
      },
      mode: { plan: { sessionToken: Redaction.MARKER, prompt: "plan" } },
    })
  })

  test("redactConfig masks secrets nested in an agent's unknown keys", () => {
    const headers = { Authorization: "Bearer agent-nested", "User-Agent": "vector" }
    const config = {
      agent: { build: { headers, options: { headers }, tools: { "read.key": true }, permission: { "*.key": "deny" } } },
      mode: { plan: { providerOptions: { custom: { apiKey: "mode-nested" } } } },
    }
    const masked = { Authorization: Redaction.MARKER, "User-Agent": "vector" }
    expect(Redaction.redactConfig(config)).toEqual({
      agent: {
        build: {
          headers: masked,
          options: { headers: masked },
          tools: { "read.key": true },
          permission: { "*.key": "deny" },
        },
      },
      mode: { plan: { providerOptions: { custom: { apiKey: Redaction.MARKER } } } },
    })
  })

  test("redactConfig masks secret query parameters and command arguments", () => {
    const config = {
      provider: { custom: { options: { baseURL: "https://api.example.com/v1?api_key=sk-url&region=us" } } },
      mcp: {
        remote: { type: "remote", url: "https://mcp.example.com/sse?token=url-secret&mode=full#top" },
        tools: {
          type: "local",
          command: ["npx", "server", "--api-key", "sk-arg", "--x-token=arg-secret", "--max-tokens", "100"],
        },
      },
    }
    expect(Redaction.redactConfig(config)).toEqual({
      provider: {
        custom: { options: { baseURL: `https://api.example.com/v1?api_key=${Redaction.MARKER}&region=us` } },
      },
      mcp: {
        remote: { type: "remote", url: `https://mcp.example.com/sse?token=${Redaction.MARKER}&mode=full#top` },
        tools: {
          type: "local",
          command: [
            "npx",
            "server",
            "--api-key",
            Redaction.MARKER,
            `--x-token=${Redaction.MARKER}`,
            "--max-tokens",
            "100",
          ],
        },
      },
    })
  })

  test("omit masks secret query parameters in URL fields", () => {
    expect<unknown>(Redaction.omit({ baseURL: "https://api.example.com?key=sk-url", apiKey: "sk" })).toEqual({
      baseURL: `https://api.example.com?key=${Redaction.MARKER}`,
    })
  })

  test("restore puts back every secret of a redacted config, inside arrays too", () => {
    const config = {
      ...stored,
      plugin: ["plain", ["first", { apiKey: "first-secret" }], ["second", { apiKey: "second-secret", region: "us" }]],
      provider: {
        custom: { options: { ...stored.provider.custom.options, baseURL: "https://api.example.com?api_key=sk-url" } },
      },
      mcp: {
        tools: { ...stored.mcp.tools, command: ["server", "--api-key", "sk-arg", "--x-token=arg-secret"] },
        remote: { type: "remote", url: "https://mcp.example.com/sse?token=url-secret" },
      },
      agent: { build: { apiKey: "agent-secret", options: { apiKey: "agent-secret" } } },
    }
    expect(Redaction.restore(Redaction.redactConfig(config), config)).toEqual(config)
  })

  test("restore pairs a plugin tuple by name, not by position", () => {
    const sent = { plugin: [["second", { apiKey: Redaction.MARKER }]] }
    const file = {
      plugin: [
        ["first", { apiKey: "first-secret" }],
        ["second", { apiKey: "second-secret" }],
      ],
    }
    expect(Redaction.restore(sent, file)).toEqual({ plugin: [["second", { apiKey: "second-secret" }]] })
    // A tuple the file does not hold is left out, so the copy holding the key stays
    // in effect, and so is a list left empty by that.
    expect<unknown>(Redaction.restore({ plugin: [["third", { apiKey: Redaction.MARKER }]] }, file)).toEqual({})
    expect<unknown>(Redaction.restore({ plugin: [] }, file)).toEqual({ plugin: [] })
  })

  test("restore leaves out a masked URL or command the file does not hold, with its entry", () => {
    const sent = {
      mcp: {
        remote: { type: "remote", url: `https://h.example/p?token=${Redaction.MARKER}`, enabled: true },
        tools: { type: "local", command: ["srv", "--api-key", Redaction.MARKER] },
        added: { type: "local", command: ["new-server"] },
      },
      provider: { custom: { name: "Custom", options: { baseURL: `https://h.example?key=${Redaction.MARKER}` } } },
      plugin: ["plain", ["global-only", { apiKey: Redaction.MARKER }]],
    }
    expect<unknown>(Redaction.restore(sent, {})).toEqual({
      mcp: { added: { type: "local", command: ["new-server"] } },
      provider: { custom: { name: "Custom" } },
      plugin: ["plain"],
    })
    // An entry the file holds, such as an `enabled` override, keeps the rest of what was sent.
    expect<unknown>(Redaction.restore(sent.mcp, { remote: { enabled: false }, tools: { enabled: false } })).toEqual({
      remote: { type: "remote", enabled: true },
      tools: { type: "local" },
      added: { type: "local", command: ["new-server"] },
    })
  })

  test("restore pairs a repeated flag or query parameter with the stored one in the same place", () => {
    const command = ["srv", "--api-key", "A", "--api-key", "B", "--x-token=C", "--x-token=D"]
    expect(
      Redaction.restore(
        [
          "srv",
          "--verbose",
          "--api-key",
          Redaction.MARKER,
          "--api-key",
          Redaction.MARKER,
          `--x-token=${Redaction.MARKER}`,
          `--x-token=${Redaction.MARKER}`,
        ],
        command,
      ),
    ).toEqual(["srv", "--verbose", "--api-key", "A", "--api-key", "B", "--x-token=C", "--x-token=D"])
    // An edited first value keeps the second stored one in the second place, and a
    // third occurrence with nothing stored behind it is dropped.
    expect(
      Redaction.restore(
        ["srv", "--api-key", "edited", "--api-key", Redaction.MARKER, "--api-key", Redaction.MARKER],
        command,
      ),
    ).toEqual(["srv", "--api-key", "edited", "--api-key", "B", "--api-key"])
    const url = "https://h.example/p?token=a&token=b&mode=full"
    expect(
      Redaction.restore(`https://h.example/p?token=${Redaction.MARKER}&token=${Redaction.MARKER}&mode=lite`, url),
    ).toBe("https://h.example/p?token=a&token=b&mode=lite")
    expect(
      Redaction.restore(
        `https://h.example/p?token=${Redaction.MARKER}&token=${Redaction.MARKER}&token=${Redaction.MARKER}`,
        url,
      ),
    ).toBe("https://h.example/p?token=a&token=b")
  })

  test("restore keeps a changed URL but never sends the stored key to a new host", () => {
    const url = "https://mcp.example.com/sse?token=url-secret&mode=full"
    expect(Redaction.restore(`https://mcp.example.com/sse?token=${Redaction.MARKER}&mode=lite`, url)).toBe(
      "https://mcp.example.com/sse?token=url-secret&mode=lite",
    )
    expect(Redaction.restore(`https://evil.example.com/sse?token=${Redaction.MARKER}&mode=full`, url)).toBe(
      "https://evil.example.com/sse?mode=full",
    )
  })

  test("restore finds a masked argument by its flag and drops one it cannot find", () => {
    const command = ["server", "--api-key", "sk-arg", "--x-token=arg-secret"]
    expect(Redaction.restore(["server", "--verbose", "--api-key", Redaction.MARKER], command)).toEqual([
      "server",
      "--verbose",
      "--api-key",
      "sk-arg",
    ])
    expect(
      Redaction.restore(["server", "--other-key", Redaction.MARKER, `--x-token=${Redaction.MARKER}`], command),
    ).toEqual(["server", "--other-key", "--x-token=arg-secret"])
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
