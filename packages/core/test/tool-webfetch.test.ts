import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { PermissionV2 } from "@vectordevai/core/permission"
import { SessionV2 } from "@vectordevai/core/session"
import { ToolRegistry } from "@vectordevai/core/tool/registry"
import { WebFetchTool } from "@vectordevai/core/tool/webfetch"
import { ToolOutputStore } from "@vectordevai/core/tool-output-store"
import { WebFetchRequest } from "@vectordevai/core/util/webfetch-request"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_webfetch_test")
const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
const assertions: PermissionV2.AssertInput[] = []
const denied = new Set<string>()
let respond = (_request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))

const client = HttpClient.make((request) =>
  Effect.sync(() => requests.push({ url: request.url, headers: request.headers })).pipe(
    Effect.andThen(respond(request)),
    Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
  ),
)
const http = Layer.succeed(HttpClient.HttpClient, client)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(denied.has(input.action) ? Effect.fail(new PermissionV2.RejectedError()) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const toolLayer = (replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebFetchTool.node]), [
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ...replacements,
  ])
const it = testEffect(toolLayer([[LayerNodePlatform.httpClient, http]]))

const reset = () => {
  requests.length = 0
  assertions.length = 0
  denied.clear()
  respond = () => Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
}

const call = (input: typeof WebFetchTool.Input.Type, id = "call-webfetch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "webfetch", input },
})

describe("WebFetchTool helpers", () => {
  test("defaults format and rejects invalid timeout controls", () => {
    const decode = Schema.decodeUnknownSync(WebFetchTool.Input)
    expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com", format: "markdown" })
    expect(() => decode({ url: "https://example.com", timeout: 0 })).toThrow()
    expect(() => decode({ url: "https://example.com", timeout: WebFetchTool.MAX_TIMEOUT_SECONDS + 1 })).toThrow()
  })

  test("ports HTML text and markdown conversions without active content", () => {
    const html = "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>"
    expect(WebFetchTool.extractTextFromHTML(html)).toBe("Helloworld wide")
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("# Hello\n\nworld **wide**")
  })

  it.effect("blocks private destinations even without an authorization callback", () =>
    Effect.gen(function* () {
      reset()
      const exit = yield* WebFetchRequest.execute(client, HttpClientRequest.get("http://127.0.0.1/private")).pipe(
        Effect.scoped,
        Effect.exit,
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toEqual([])
    }),
  )
})

describe("WebFetchTool registration", () => {
  it.effect("registers and fetches an ordinary hostname HTTP URL without rewriting it", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://example.com/public"

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["webfetch"])
      expect(yield* settleTool(registry, call({ url, format: "text", timeout: 4 }))).toEqual({
        result: { type: "text", value: "hello" },
        output: {
          structured: { url, contentType: "text/plain", format: "text", output: "hello" },
          content: [{ type: "text", text: "hello" }],
        },
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text", timeout: 4 } },
      ])
      expect(requests).toMatchObject([{ url, headers: { accept: expect.stringContaining("text/plain;q=1.0") } }])
    }),
  )

  it.effect("asks separately before reaching private, link-local, reserved and mapped destinations", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const url of [
        "http://localhost/private",
        "http://127.0.0.1/private",
        "http://10.0.0.1/private",
        "http://169.254.169.254/latest/meta-data",
        "http://192.0.2.1/reserved",
        "http://[::1]/private",
        "http://[fe80::1]/private",
        "http://[::ffff:127.0.0.1]/private",
        "http://[64:ff9b::7f00:1]/private",
      ]) {
        reset()
        denied.add("private_network")
        expect(yield* executeTool(registry, call({ url, format: "text" }, `call-${url}`))).toEqual({
          type: "error",
          value: `Unable to fetch ${url}`,
        })
        expect(assertions.map((assertion) => [assertion.action, assertion.resources])).toEqual([
          ["webfetch", [url]],
          ["private_network", [new URL(url).origin]],
        ])
        expect(requests).toEqual([])
      }
    }),
  )

  it.effect("fetches a private destination once the user approves it", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://localhost:3000/health"

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({ type: "text", value: "hello" })
      expect(assertions).toMatchObject([
        { action: "webfetch", resources: [url] },
        { action: "private_network", resources: ["http://localhost:3000"], save: ["http://localhost:3000"] },
      ])
      expect(requests.map((request) => request.url)).toEqual([url])
    }),
  )

  it.effect("reauthorizes each public redirect destination", () =>
    Effect.gen(function* () {
      reset()
      const source = "https://1.1.1.1/redirect"
      const target = "https://1.0.0.1/target"
      respond = (request) =>
        Effect.succeed(
          request.url === source
            ? new Response("", { status: 302, headers: { location: target } })
            : new Response("redirected", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: source, format: "text" }))).toEqual({
        type: "text",
        value: "redirected",
      })
      expect(assertions.map((assertion) => assertion.resources)).toEqual([[source], [target]])
      expect(requests.map((request) => request.url)).toEqual([source, target])
    }),
  )

  it.effect("asks again before following a redirect to a private destination", () =>
    Effect.gen(function* () {
      reset()
      denied.add("private_network")
      const source = "https://1.1.1.1/redirect"
      const target = "http://169.254.169.254/latest/meta-data"
      respond = () => Effect.succeed(new Response("", { status: 302, headers: { location: target } }))
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: source, format: "text" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${source}`,
      })
      expect(assertions.map((assertion) => [assertion.action, assertion.resources])).toEqual([
        ["webfetch", [source]],
        ["webfetch", [target]],
        ["private_network", ["http://169.254.169.254"]],
      ])
      expect(requests.map((request) => request.url)).toEqual([source])
    }),
  )

  it.effect("stops redirect chains at the fixed hop limit", () =>
    Effect.gen(function* () {
      reset()
      const url = "https://1.1.1.1/redirect"
      respond = () => Effect.succeed(new Response("", { status: 302, headers: { location: url } }))
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
      expect(requests).toHaveLength(6)
      expect(assertions).toHaveLength(6)
    }),
  )

  it.effect("rejects non-HTTP schemes before permission or transport", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "file:///etc/passwd", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch file:///etc/passwd",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("converts HTML to requested markdown and text", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<h1>Hello</h1><p>world</p><script>bad()</script>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "markdown" }))).toEqual({
        type: "text",
        value: "# Hello\n\nworld",
      })
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "text",
        value: "Helloworld",
      })
    }),
  )

  it.effect("returns an error result when HTML-to-Markdown conversion throws", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<div>".repeat(10_000) + "content" + "</div>".repeat(10_000), {
            headers: { "content-type": "text/html" },
          }),
        )
      const registry = yield* ToolRegistry.Service
      const url = "https://1.1.1.1/deep-html"

      expect(yield* executeTool(registry, call({ url, format: "markdown" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
    }),
  )

  it.effect("rejects declared and streamed oversized bodies", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () =>
        Effect.succeed(
          new Response("small", {
            headers: { "content-type": "text/plain", "content-length": String(WebFetchTool.MAX_RESPONSE_BYTES + 1) },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/declared", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/declared",
      })

      respond = () =>
        Effect.succeed(
          new Response("x".repeat(WebFetchTool.MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "text/plain" } }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/streamed", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/streamed",
      })
    }),
  )

  it.effect("keeps images and files unsupported until typed settlement can carry attachments", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () => Effect.succeed(new Response("png", { headers: { "content-type": "image/png" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/image", format: "html" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/image",
      })

      respond = () => Effect.succeed(new Response("pdf", { headers: { "content-type": "application/pdf" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/file", format: "html" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/file",
      })
    }),
  )

  it.effect("retries a declared challenge once and retains Vector identity on both attempts", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }))
      const registry = yield* ToolRegistry.Service
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1",
      })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.headers["user-agent"]).toMatch(/^Mozilla\/.* Vector\//)
      expect(requests[1]?.headers["user-agent"]).toMatch(/^Vector\//)
    }),
  )

  it.effect("times out stalled requests", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.never
      const registry = yield* ToolRegistry.Service
      const fiber = yield* executeTool(
        registry,
        call({ url: "https://1.1.1.1/slow", format: "text", timeout: 1 }),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* Fiber.join(fiber)).toEqual({ type: "error", value: "Unable to fetch https://1.1.1.1/slow" })
    }),
  )
})
