import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Truncate } from "../../src/tool/truncate"
import { WebSearchTool } from "../../src/tool/websearch"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { FenceMatch } from "../../../core/test/lib/fence"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node, Auth.node, RuntimeFlags.node])),
)

// The search requests are sent to a local server; anything that tried to reach Exa or Parallel would throw.
const guard = NetworkGuard.use()

describe("stored search keys", () => {
  test("V2 search resolves the same saved key through the desktop engine bridge", async () => {
    const { WebSearchTool } = await import("@vectordevai/core/tool/websearch")
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const credentials = yield* WebSearchTool.CredentialsService
        yield* auth.set("exa", { type: "api", key: "bridge-fixture-secret" })
        expect(yield* credentials.get("exa")).toBe("bridge-fixture-secret")
        yield* auth.remove("exa")
        expect(yield* credentials.get("exa")).toBeUndefined()
      }).pipe(Effect.provide(AppNodeBuilderV1.build(LayerNode.group([Auth.node, WebSearchTool.credentialsNode])))),
    )
  })
  for (const provider of ["exa", "parallel"] as const) {
    it.instance(`uses a stored ${provider} key only in a header on a real HTTP request`, () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const http = yield* HttpClient.HttpClient
        yield* auth.remove("exa")
        yield* auth.remove("parallel")
        yield* auth.set(provider, { type: "api", key: `${provider}-fixture-secret` })
        const requests: Request[] = []
        const bodies: string[] = []
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              async fetch(request) {
                requests.push(request.clone())
                bodies.push(await request.text())
                return Response.json({ result: { content: [{ type: "text", text: "Fixture search result" }] } })
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const output = yield* Effect.gen(function* () {
          const info = yield* WebSearchTool
          const tool = yield* info.init()
          return yield* tool.execute(
            { query: "Vector fixture" },
            {
              sessionID: SessionID.make("ses_search_credentials"),
              messageID: MessageID.make("msg_search_credentials"),
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.mapRequest(http, (request) => {
              expect(request.headers[provider === "exa" ? "x-api-key" : "authorization"]).toBe(
                provider === "exa" ? "exa-fixture-secret" : "Bearer parallel-fixture-secret",
              )
              expect(request.url).toBe(provider === "exa" ? "https://mcp.exa.ai/mcp" : "https://search.parallel.ai/mcp")
              return HttpClientRequest.setUrl(request, server.url)
            }),
          ),
        )
        expect(requests).toHaveLength(1)
        expect(requests[0].headers.get(provider === "exa" ? "x-api-key" : "authorization")).toBe(
          provider === "exa" ? "exa-fixture-secret" : "Bearer parallel-fixture-secret",
        )
        expect(new URL(requests[0].url).search).toBe("")
        // The search service gets the query and nothing that ties it to the session or the model.
        const body = JSON.parse(bodies[0] ?? "{}") as { params: { arguments: Record<string, unknown> } }
        expect(Object.keys(body.params.arguments)).not.toContain("session_id")
        expect(Object.keys(body.params.arguments)).not.toContain("model_name")
        expect(JSON.stringify(body)).not.toContain("ses_search_credentials")
        expect(output.output).toEqual(
          FenceMatch.block(
            `title="${provider === "exa" ? "Exa" : "Parallel"} Web Search: Vector fixture" tool="websearch"`,
            "Fixture search result",
          ),
        )
        expect(JSON.stringify(output)).not.toContain("fixture-secret")
        expect(guard.outside()).toEqual([])
        yield* auth.remove(provider)
      }),
    )
  }
})
