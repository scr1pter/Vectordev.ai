export * as LocalServers from "./serve"

import path from "node:path"
import { Schema } from "effect"

// A fake model server on 127.0.0.1 that answers from one of the cassettes beside this file (http-recorder's format),
// matching each request by method, path and, for a POST, its JSON body. A test adds routes of its own, such as
// /v1/chat/completions, which take precedence. Anything else gets the cassette's `fallback` answer: Ollama's 404,
// or LM Studio's "Unexpected endpoint" 200, which is part of what the probe has to cope with.
//
// Every answer closes its connection. Tests start and stop many fakes, and a port a stopped fake had can be handed to
// the next one; a pooled keep-alive socket to the old server would then fail the new server's first request.

export const DIR = import.meta.dir

export type Kind = "ollama" | "lmstudio" | "vllm" | "llamacpp" | "sglang" | "openai"

export type Hit = { readonly method: string; readonly path: string; readonly body: string }

export type Route = (request: Request, body: string) => Response | Promise<Response>

export type Fake = {
  readonly origin: string
  readonly port: number
  readonly hits: () => readonly Hit[]
  /** Replaces the answer to `METHOD /path` from now on, such as a server that was swapped for another. */
  readonly route: (key: string, route: Route) => void
  readonly close: () => Promise<void>
}

const Snapshot = {
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
}

const Answer = Schema.Struct({ status: Schema.Number, ...Snapshot })

// The part of http-recorder's cassette format these files use: version 1 and HTTP interactions, plus the fallback
// answer in the metadata.
const Cassette = Schema.Struct({
  version: Schema.Literal(1),
  metadata: Schema.Struct({
    recorded: Schema.Boolean,
    note: Schema.String,
    fallback: Schema.optional(Answer),
  }),
  interactions: Schema.Array(
    Schema.Struct({
      transport: Schema.Literal("http"),
      request: Schema.Struct({ method: Schema.String, url: Schema.String, ...Snapshot }),
      response: Answer,
    }),
  ),
})

/** A cassette as written, checked against the format. */
export async function load(kind: Kind) {
  return Schema.decodeUnknownSync(Cassette)(await Bun.file(path.join(DIR, `${kind}.json`)).json())
}

export async function serve(
  kind: Kind,
  options: {
    readonly routes?: Record<string, Route>
    /** 127.0.0.1 unless a test needs ::1. */
    readonly hostname?: "127.0.0.1" | "::1"
    readonly port?: number
  } = {},
): Promise<Fake> {
  const cassette = await load(kind)
  const fallback = cassette.metadata.fallback
  const interactions = cassette.interactions
  const routes = new Map(Object.entries(options.routes ?? {}))
  const hits: Hit[] = []
  const hostname = options.hostname ?? "127.0.0.1"
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text()
      hits.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
      const answer = await (async () => {
        const route = routes.get(`${request.method} ${url.pathname}`)
        if (route) return route(request, body)
        const match = interactions.find(
          (item) =>
            item.request.method === request.method &&
            new URL(item.request.url).pathname === url.pathname &&
            (item.request.body === "" || same(item.request.body, body)),
        )
        if (match)
          return new Response(match.response.body, { status: match.response.status, headers: match.response.headers })
        if (fallback) return new Response(fallback.body, { status: fallback.status, headers: fallback.headers })
        return new Response("Not found", { status: 404 })
      })()
      answer.headers.set("connection", "close")
      return answer
    },
  })
  return {
    origin: hostname === "::1" ? `http://[::1]:${server.port}` : `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    hits: () => [...hits],
    route: (key, route) => {
      routes.set(key, route)
    },
    close: () => server.stop(true),
  }
}

function same(left: string, right: string) {
  const parse = (text: string) => {
    const value: unknown = JSON.parse(text)
    return JSON.stringify(value)
  }
  return parse(left) === parse(right)
}

/**
 * An OpenAI-compatible /v1/chat/completions that streams the call it is asked for: the user's "Call the X tool with
 * these arguments: {…}" comes back as that tool call, and a tool result comes back as a short reply. `behave` changes
 * the answer for a test (no call, a refusal, wrong arguments).
 */
export function chat(
  behave: (input: {
    readonly body: ChatBody
    readonly tool?: string
    readonly args?: string
  }) => Response | undefined = () => undefined,
): Route {
  return (_request, text) => {
    const body = JSON.parse(text) as ChatBody
    const last = body.messages.at(-1)
    const asked =
      typeof last?.content === "string" ? last.content.match(/^Call the (\S+) tool with these arguments: (.*)$/s) : null
    const custom = behave({ body, tool: asked?.[1], args: asked?.[2] })
    if (custom) return custom
    if (last?.role === "tool") return sse([{ choices: [{ index: 0, delta: { role: "assistant", content: "Done." } }] }])
    if (!asked) return sse([{ choices: [{ index: 0, delta: { role: "assistant", content: "Hello." } }] }])
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: null } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: asked[1], arguments: "" } }],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: asked[2] } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ])
  }
}

export type ChatBody = {
  readonly model: string
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
  readonly tools?: readonly { readonly function: { readonly name: string } }[]
}

/** A streamed chat completion, as OpenAI-compatible servers send one. */
export function sse(events: readonly unknown[]) {
  return new Response([...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}
