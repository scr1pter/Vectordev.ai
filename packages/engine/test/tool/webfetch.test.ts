import { describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node, Config.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("retries declared challenges once with Vector identity and unchanged permission scope", () =>
    Effect.gen(function* () {
      const agents: Array<string | null> = []
      yield* withFetch(
        (request) => {
          agents.push(request.headers.get("user-agent"))
          return agents.length === 1
            ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
            : new Response("restored", { headers: { "content-type": "text/plain" } })
        },
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: url.toString(), format: "text" })
            expect(result.output).toBe("restored")
            expect(agents).toHaveLength(2)
            expect(agents[0]).toMatch(/^Mozilla\/.* Vector\//)
            expect(agents[1]).toMatch(/^Vector\//)
          }),
      )
    }),
  )

  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )
  it.instance("converts html to lean markdown without page chrome", () =>
    withFetch(
      () =>
        new Response(
          [
            "<html><body><nav><a href='/home'>Home</a></nav>",
            "<h1>Guide</h1>",
            "<p>See <a href='https://example.com/docs'>the docs</a>, <a href='/local'>local page</a> and <a href='#top'>top</a>.</p>",
            "<img src='/diagram.png' alt='Request flow'><img src='/spacer.gif'><svg><text>icon</text></svg>",
            "<form><button>Subscribe</button></form><footer>Copyright</footer></body></html>",
          ].join(""),
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/guide", url).toString(), format: "markdown" })
          // Relative links resolve against the page; in-page anchors keep only their text; forms keep their content.
          expect(result.output).toBe(
            `# Guide\n\nSee [the docs](https://example.com/docs), [local page](${new URL("/local", url).href}) and top.\n\n[image: Request flow]\n\nSubscribe`,
          )
          const metadata: { truncated?: boolean } = result.metadata
          expect(metadata.truncated).toBe(false)
        }),
    ),
  )

  it.instance("caps converted pages at 20KB and saves the full page", () =>
    withFetch(
      () =>
        new Response(`<html><body>${"<p>paragraph of documentation text</p>".repeat(2_000)}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/long", url).toString(), format: "markdown" })
          const metadata: { truncated?: boolean; outputPath?: string } = result.metadata
          expect(metadata.truncated).toBe(true)
          expect(metadata.outputPath).toBeString()
          expect(Buffer.byteLength(result.output)).toBeLessThan(21 * 1024)
        }),
    ),
  )
})
