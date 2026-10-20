import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseResponse } from "../../src/tool/mcp-websearch"
import { selectWebSearchProvider, webSearchAuthHeaders, webSearchProviderLabel } from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it } from "../lib/effect"
import { ProviderV2 } from "@vectordevai/core/provider"

describe("websearch provider", () => {
  test("keeps keyless search off without an explicit opt-in", () => {
    expect(selectWebSearchProvider()).toBeUndefined()
  })

  test("keeps both providers' keys in authentication headers", () => {
    expect(webSearchAuthHeaders("exa", "exa-secret")).toMatchObject({ "x-api-key": "exa-secret" })
    expect(webSearchAuthHeaders("parallel", "parallel-secret")).toMatchObject({
      Authorization: "Bearer parallel-secret",
    })
    expect(webSearchAuthHeaders("exa")).not.toHaveProperty("x-api-key")
    expect(webSearchAuthHeaders("parallel")).not.toHaveProperty("Authorization")
  })

  test("supports an operational override", () => {
    const original = process.env.VECTOR_WEBSEARCH_PROVIDER

    try {
      process.env.VECTOR_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider()).toBe("parallel")

      process.env.VECTOR_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider()).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.VECTOR_WEBSEARCH_PROVIDER
      else process.env.VECTOR_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Exa when the Exa flag is enabled", () => {
    expect(selectWebSearchProvider({ exa: true, parallel: false })).toBe("exa")
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider({ exa: false, parallel: true })).toBe("parallel")
  })

  test("is enabled only by explicit websearch provider flags", () => {
    expect(webSearchEnabled({ exa: false, parallel: false })).toBe(false)
    expect(webSearchEnabled({ exa: true, parallel: false })).toBe(true)
    expect(webSearchEnabled({ exa: false, parallel: true })).toBe(true)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
})
