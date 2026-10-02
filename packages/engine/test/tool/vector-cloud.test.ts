import { describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { Parameters, VectorCloudTool } from "../../src/tool/vector-cloud"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

function bridge(report: unknown, status = 200) {
  return Effect.gen(function* () {
    const requests: Record<string, unknown>[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            expect(request.method).toBe("POST")
            expect(request.headers.get("authorization")).toBe("Bearer cloud-test-token")
            requests.push(await request.json())
            return Response.json(report, { status })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const previousUrl = process.env.VECTOR_CLOUD_BRIDGE_URL
    const previousToken = process.env.VECTOR_CLOUD_BRIDGE_TOKEN
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        previousUrl === undefined
          ? delete process.env.VECTOR_CLOUD_BRIDGE_URL
          : (process.env.VECTOR_CLOUD_BRIDGE_URL = previousUrl)
        previousToken === undefined
          ? delete process.env.VECTOR_CLOUD_BRIDGE_TOKEN
          : (process.env.VECTOR_CLOUD_BRIDGE_TOKEN = previousToken)
      }),
    )
    process.env.VECTOR_CLOUD_BRIDGE_URL = `http://127.0.0.1:${server.port}`
    process.env.VECTOR_CLOUD_BRIDGE_TOKEN = "cloud-test-token"
    return requests
  })
}

function execute(params: Schema.Schema.Type<typeof Parameters>, ask: Tool.Context["ask"] = () => Effect.void) {
  return Effect.gen(function* () {
    const info = yield* VectorCloudTool
    const tool = yield* info.init()
    return yield* tool.execute(params, {
      sessionID: SessionID.descending(),
      messageID: MessageID.ascending(),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask,
    })
  })
}

describe("vector_cloud bridge", () => {
  it.instance("reports linked destinations in Cloud status", () =>
    Effect.gen(function* () {
      yield* bridge({
        ok: true,
        configured: true,
        targets: [{ id: "vercel", label: "Vercel", projectName: "customer-site" }],
        connections: [{ provider: "vercel", connected: true }],
      })
      const result = yield* execute({ action: "status" })
      expect(result.output).toContain("Vector Cloud configured: yes")
      expect(result.output).toContain("customer-site")
      expect(result.output).toContain('"provider":"vercel"')
    }),
  )

  it.instance("preserves an omitted publish destination and reports the choices without a retry", () =>
    Effect.gen(function* () {
      const requests = yield* bridge(
        {
          ok: false,
          needsChoice: true,
          targets: [
            { id: "vercel", label: "Vercel", projectName: "website" },
            { id: "netlify", label: "Netlify", projectName: "landing" },
          ],
          nextStep: "Choose one of these destinations.",
        },
        400,
      )
      const result = yield* execute({ action: "publish" })
      expect(requests).toHaveLength(1)
      expect(requests[0]).not.toHaveProperty("target")
      expect(result.output).toContain("target vercel, project website")
      expect(result.output).toContain("target netlify, project landing")
      expect(result.output).toContain("Choose one of these destinations.")
      expect(result.output).not.toContain("publish completed")
    }),
  )

  it.instance("keeps an explicit target in permission metadata and makes no fallback request", () =>
    Effect.gen(function* () {
      const requests = yield* bridge({ ok: false, error: "The selected Vercel project is unavailable." }, 400)
      const permissions: Parameters<Tool.Context["ask"]>[0][] = []
      const result = yield* execute({ action: "publish", target: "vercel", production: false }, (input) =>
        Effect.sync(() => {
          permissions.push(input)
        }),
      )
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ command: "publish", target: "vercel", production: false })
      expect(permissions).toHaveLength(1)
      expect(permissions[0]).toMatchObject({
        permission: "vector_cloud_publish",
        metadata: { target: "vercel", production: false },
      })
      expect(result.output).toContain("The selected Vercel project is unavailable.")
      expect(result.output).not.toContain("publish completed")
    }),
  )

  it.instance("rejects a response without an explicit operation result", () =>
    Effect.gen(function* () {
      yield* bridge({ error: "Unauthorized" }, 401)
      const result = yield* execute({ action: "status" }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Vector Cloud command failed (401)")
    }),
  )

  it.instance("does not report success from an HTTP failure", () =>
    Effect.gen(function* () {
      yield* bridge({ ok: true, url: "https://example.invalid" }, 502)
      const result = yield* execute({ action: "publish", target: "netlify" }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Vector Cloud command failed (502)")
    }),
  )
})
