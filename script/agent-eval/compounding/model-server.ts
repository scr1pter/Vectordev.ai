// A local stand-in for the Anthropic Messages API that answers each request with whatever `respond` decides from that
// request's body alone, and records every request as sent. The compounding benchmark puts its scripted model behind it,
// so what the model "knows" can only be what Vector put in the request. Nothing here reaches the network.

import type { Recorded } from "../prompt-cache"

export type Call = { name: string; input: Record<string, unknown> } | { text: string }

export type Served = {
  readonly url: string
  readonly requests: Recorded[]
  /** The answer given to each request that carried tools, in order: what the scripted model did. */
  readonly calls: Call[]
  stop: () => void
}

export function serve(respond: (body: Record<string, unknown>) => Call | Promise<Call>): Served {
  const requests: Recorded[] = []
  const calls: Call[] = []
  let id = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const text = await request.text()
      const body = await Promise.resolve()
        .then(() => JSON.parse(text) as Record<string, unknown>)
        .catch((): Record<string, unknown> => ({}))
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: Math.ceil(text.length / 4) })
      if (!url.pathname.endsWith("/messages")) return Response.json({ data: [] })
      const n = ++id
      const recorded: Recorded = {
        body,
        output: "",
        sentBytes: Buffer.byteLength(text),
        headers: Object.fromEntries(request.headers.entries()),
      }
      requests.push(recorded)
      // A request without tools is a side call such as the session title; it never advances the model's work.
      const tools = Array.isArray(body.tools) ? body.tools : []
      const call: Call = tools.length === 0 ? { text: "Benchmark task" } : await respond(body)
      if (tools.length > 0) calls.push(call)
      recorded.output = "text" in call ? call.text : JSON.stringify(call.input)
      const model = String(body.model ?? "claude-sonnet-4-5")
      if (body.stream !== true) return Response.json(message(call, `toolu_${n}`, model))
      return new Response(stream(call, `toolu_${n}`, model), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, calls, stop: () => server.stop(true) }
}

function message(call: Call, id: string, model: string) {
  return {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    model,
    content: "name" in call ? [{ type: "tool_use", id, name: call.name, input: call.input }] : [{ type: "text", text: call.text }],
    stop_reason: "name" in call ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }
}

// One streamed response in the Messages SSE format.
function stream(call: Call, id: string, model: string) {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const start = { ...message(call, id, model), content: [], stop_reason: null }
  const block =
    "name" in call
      ? [
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id, name: call.name, input: {} },
          }),
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
          }),
        ]
      : [
          event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: call.text },
          }),
        ]
  return [
    event("message_start", { type: "message_start", message: start }),
    ...block,
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "name" in call ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("")
}
