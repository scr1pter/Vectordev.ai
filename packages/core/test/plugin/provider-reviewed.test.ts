import "../../src/plugin/internal"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { expect } from "bun:test"
import { Effect } from "effect"
import { AISDK } from "../../src/aisdk"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"
import { PluginV2 } from "../../src/plugin"
import { PluginHost } from "../../src/plugin/host"
import { ReviewedProviderPlugin } from "../../src/plugin/provider/reviewed"
import { DynamicProviderPlugin } from "../../src/plugin/provider/dynamic"
import { Npm } from "../../src/npm"
import { ProviderSDK } from "../../src/provider-sdk"
import { PluginTestLayer } from "./fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(PluginTestLayer)
const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "fixture" }] }]
const reply = {
  id: "fixture-response",
  object: "chat.completion",
  created: 1,
  model: "fixture",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "fixture answer",
        tool_calls: [
          { id: "call-fixture", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
}

for (const entry of [
  { id: "aihubmix", pkg: "@aihubmix/ai-sdk-provider", path: "/v1/chat/completions" },
  { id: "merge-gateway", pkg: "merge-gateway-ai-sdk-provider", path: "/chat/completions" },
  { id: "qvac", pkg: "@qvac/ai-sdk-provider", path: "/chat/completions" },
]) {
  it.effect(`${entry.id} uses its bundled V3 SDK through native hooks and real HTTP`, () =>
    Effect.gen(function* () {
      const calls: { path: string; auth: string | null; appCode: string | null; body: Record<string, unknown> }[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(request) {
              calls.push({
                path: new URL(request.url).pathname,
                auth: request.headers.get("authorization"),
                appCode: request.headers.get("APP-Code"),
                body: await request.json(),
              })
              return calls.at(-1)?.body.stream ? streamReply() : Response.json(reply)
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const host = yield* PluginHost.make(plugin)
      yield* ReviewedProviderPlugin.effect(host)
      yield* DynamicProviderPlugin.effect(host).pipe(
        Effect.provideService(
          Npm.Service,
          Npm.Service.of({
            add: () => Effect.die("A reviewed provider must never install at runtime"),
            install: () => Effect.die("A reviewed provider must never install at runtime"),
            which: () => Effect.succeed(undefined),
          }),
        ),
      )
      const model = ModelV2.Info.make({
        ...ModelV2.Info.empty(ProviderV2.ID.make(entry.id), ModelV2.ID.make("fixture")),
        api: { id: ModelV2.ID.make("fixture"), type: "aisdk", package: entry.pkg },
      })
      const sdk = yield* aisdk.runSDK({
        model,
        package: entry.pkg,
        options: { apiKey: `fixture-${entry.id}-key`, baseURL: server.url.origin },
      })
      const language: LanguageModelV3 = sdk.sdk.languageModel("fixture")
      expect(language.specificationVersion).toBe("v3")
      const response = yield* Effect.promise(() =>
        language.doGenerate({ prompt, tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }] }),
      )
      expect(response.content).toContainEqual({ type: "text", text: "fixture answer" })
      expect(response.content).toContainEqual({
        type: "tool-call",
        toolCallId: "call-fixture",
        toolName: "read",
        input: '{"path":"README.md"}',
      })
      expect(response.finishReason.unified).toBe("tool-calls")
      const streaming = awaitStream(language)
      const parts = yield* Effect.promise(() => streaming)
      expect(parts.some((part) => part.type === "tool-call" && part.toolName === "read")).toBe(true)
      expect(parts.some((part) => part.type === "finish" && part.finishReason.unified === "tool-calls")).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe(entry.path)
      expect(calls[0].auth).toBe(`Bearer fixture-${entry.id}-key`)
      expect(calls[0].appCode).toBeNull()
      expect(calls[0].body.model).toBe("fixture")
      expect(calls[0].body.tools).toBeArray()
    }),
  )
}

it.effect("AIHubMix only sends an explicitly chosen app code", () =>
  Effect.promise(async () => {
    const seen: (string | null)[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("APP-Code"))
        return Response.json(reply)
      },
    })
    try {
      const create = await ProviderSDK.load("@aihubmix/ai-sdk-provider")
      await create({ apiKey: "fixture", baseURL: `${server.url.origin}/v1`, appCode: "owner-selected" })
        .languageModel("fixture")
        .doGenerate({ prompt })
      await create({ apiKey: "fixture", baseURL: server.url.origin, headers: { "APP-Code": "owner-header" } })
        .languageModel("fixture")
        .doGenerate({ prompt })
      expect(seen).toEqual(["owner-selected", "owner-header"])
    } finally {
      server.stop(true)
    }
  }),
)

it.effect("QVAC requires an external endpoint and never starts or downloads a runtime", () =>
  Effect.promise(async () => {
    const create = await ProviderSDK.load("@qvac/ai-sdk-provider")
    expect(() => create({})).toThrow("explicit baseURL")
    expect(() => create({ baseURL: "file:///private/runtime" })).toThrow("HTTP(S)")
    expect(() => create({ baseURL: "https://user:secret@example.test" })).toThrow("credentials")
    expect(create({ baseURL: "http://127.0.0.1:11435/v1" }).languageModel("fixture").specificationVersion).toBe("v3")
  }),
)

it.effect("Cloudflare outer transport preserves gateway auth, metadata, tools and cancellation", () =>
  Effect.promise(async () => {
    const calls: { headers: Headers; body: Record<string, unknown>[] }[] = []
    const urls: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls.push({ headers: request.headers, body: await request.json() })
        return (calls.at(-1)?.body[0]?.query as { stream?: boolean })?.stream ? streamReply() : Response.json(reply)
      },
    })
    try {
      const create = await ProviderSDK.load("ai-gateway-provider")
      const request = Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          urls.push(String(url))
          return fetch(server.url, init)
        },
        { preconnect: fetch.preconnect },
      )
      const language = create({
        accountId: "fixture-account",
        gatewayId: "fixture-gateway",
        apiKey: "fixture-token",
        fetch: request,
        metadata: { product: "Vector" },
        cacheTtl: 45,
        collectLog: false,
        headers: { "x-test": "fixture", "cf-aig-authorization": "must-not-win" },
      }).languageModel("openai/fixture")
      const response = await language.doGenerate({
        prompt,
        tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
      })
      expect(response.finishReason.unified).toBe("tool-calls")
      expect(urls).toEqual(["https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway"])
      expect(calls[0].headers.get("cf-aig-authorization")).toBe("Bearer fixture-token")
      expect(calls[0].headers.get("cf-aig-metadata")).toBe('{"product":"Vector"}')
      expect(calls[0].headers.get("cf-cache-ttl")).toBe("45")
      expect(calls[0].headers.get("cf-aig-collect-log")).toBe("false")
      expect(calls[0].headers.get("user-agent")).toStartWith("vector/")
      expect(calls[0].headers.get("x-test")).toBe("fixture")
      expect(calls[0].body[0].provider).toBe("compat")
      const parts = await awaitStream(language)
      expect(parts.some((part) => part.type === "tool-call" && part.toolName === "read")).toBe(true)
      const abort = new AbortController()
      abort.abort()
      await expect(language.doGenerate({ prompt, abortSignal: abort.signal })).rejects.toBeDefined()
      expect(calls).toHaveLength(2)
    } finally {
      server.stop(true)
    }
  }),
)

function streamReply() {
  return new Response(
    [
      {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-fixture",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"README.md"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
    ]
      .map((part) => `data: ${JSON.stringify(part)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  )
}
async function awaitStream(language: LanguageModelV3) {
  const result = await language.doStream({
    prompt,
    tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
  })
  const reader = result.stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  while (true) {
    const next = await reader.read()
    if (next.done) return parts
    parts.push(next.value)
  }
}

it.effect("AIHubMix strips the publisher referral header from its Anthropic and Gemini routes", () =>
  Effect.promise(async () => {
    const seen: { path: string; referral: string | null; key: string | null }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        seen.push({
          path: pathname,
          referral: request.headers.get("APP-Code"),
          key: request.headers.get("x-api-key") ?? request.headers.get("x-goog-api-key"),
        })
        return pathname.startsWith("/gemini/")
          ? Response.json({
              candidates: [{ content: { role: "model", parts: [{ text: "fixture answer" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
            })
          : Response.json({
              id: "fixture",
              type: "message",
              role: "assistant",
              model: "claude-fixture",
              content: [{ type: "text", text: "fixture answer" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 2, output_tokens: 3 },
            })
      },
    })
    try {
      const create = await ProviderSDK.load("@aihubmix/ai-sdk-provider")
      for (const id of ["claude-fixture", "gemini-fixture"]) {
        const response = await create({ apiKey: "fixture-key", baseURL: `${server.url.origin}/v1` })
          .languageModel(id)
          .doGenerate({ prompt })
        expect(response.content).toContainEqual({ type: "text", text: "fixture answer" })
      }
      expect(seen.map((request) => request.referral)).toEqual([null, null])
      expect(seen.map((request) => request.key)).toEqual(["fixture-key", "fixture-key"])
      expect(seen.map((request) => request.path)).toEqual([
        "/v1/messages",
        "/gemini/v1beta/models/gemini-fixture:generateContent",
      ])
    } finally {
      server.stop(true)
    }
  }),
)
