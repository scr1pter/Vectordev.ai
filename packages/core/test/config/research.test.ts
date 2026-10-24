import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigResearchV1 } from "@vectordevai/core/v1/config/research"

const decode = Schema.decodeUnknownSync(ConfigV1.Info)

describe("research and local config", () => {
  test("the build agent may research as a tool on Work and Thorough requests by default, never on Chat or Light", () => {
    expect(ConfigResearchV1.buildTool("chat")).toBe(false)
    expect(ConfigResearchV1.buildTool("light")).toBe(false)
    expect(ConfigResearchV1.buildTool("light", "work")).toBe(false)
    expect(ConfigResearchV1.buildTool("light", "thorough")).toBe(false)
    expect(ConfigResearchV1.buildTool("standard")).toBe(true)
    expect(ConfigResearchV1.buildTool("thorough")).toBe(true)
    expect(ConfigResearchV1.buildTool("standard", "thorough")).toBe(false)
    expect(ConfigResearchV1.buildTool("thorough", "thorough")).toBe(true)
    expect(ConfigResearchV1.buildTool("thorough", "off")).toBe(false)
    expect(ConfigResearchV1.buildTool("chat", "work")).toBe(false)
  })

  test("decodes the documented research and local blocks", () => {
    const config = decode({
      research: {
        depth: "auto",
        tool: "thorough",
        limits: {
          focused: { usd: 1, steps: 80, pages: 15, searches: 8, researchers: 0 },
          deep: { usd: 3, steps: 240, pages: 40, searches: 24, researchers: 4 },
        },
        domains: { prefer: [], avoid: ["example.com"] },
        robots: true,
        retain_days: 30,
      },
      local: {
        enabled: true,
        web: "network",
        endpoints: ["http://127.0.0.1:11434"],
        web_domains: { allow: [], deny: [] },
        allow: [{ source: "github", hosts: ["github.com"], reason: "Pull requests", added_at: 1, added_by: "app" }],
        pins: { "http://127.0.0.1:11434": { kind: "ollama", version: "0.12.6", models: "sha256:abc", spki: null } },
        checked: { "ollama/qwen": { checked_at: 0, result: "works" } },
        log: { retain_days: 30 },
      },
      provider: { box: { options: { baseURL: "http://10.0.0.5:8000/v1", concurrency: 4 } } },
    })
    expect(config.research?.tool).toBe("thorough")
    expect(config.local?.web).toBe("network")
    expect(config.provider?.box?.options?.concurrency).toBe(4)
  })

  // Research searches in each research agent's own browser now. A config file from an earlier version may still name a
  // search service, its address or the browser_search switch: it loads, and those settings are dropped.
  test("loads an earlier version's search settings and drops them", () => {
    for (const provider of ["auto", "searxng", "exa", "parallel", "browser", "none", "something-else"]) {
      const config = decode({
        research: {
          search: { provider, url: "https://searx.example.lan" },
          browser_search: true,
          tool: "thorough",
        },
      })
      expect(config.research).toEqual({ tool: "thorough" })
    }
  })

  test("refuses more than four researchers and an unknown Web access", () => {
    expect(() => decode({ research: { limits: { deep: { researchers: 5 } } } })).toThrow()
    expect(() => decode({ local: { web: "open" } })).toThrow()
    expect(() => decode({ research: { tool: "always" } })).toThrow()
  })
})
