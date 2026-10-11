export * as ResponseTerminal from "./response-terminal"

import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"

const decode = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const terminal = new Set([
  "response.completed",
  "response.done",
  "response.incomplete",
  "response.failed",
  "message_stop",
])

// The SDK flushes final usage when its input stream ends. Providers may keep the HTTP body open after the protocol's
// terminal event, so close at that boundary while forwarding the entire event (including authoritative usage) first.
export function wrap(response: Response) {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response
  const decoder = new TextDecoder()
  let pending = ""
  let oversized = false
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          pending += decoder.decode(chunk, { stream: true })
          while (true) {
            const boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending)
            if (!boundary) {
              // Inspection is optional for oversized frames; keep forwarding their bytes without retaining a second copy.
              if (pending.length > 4 * 1024 * 1024) {
                oversized = true
                pending = pending.slice(-3)
              }
              return
            }
            const frame = pending.slice(0, boundary.index)
            pending = pending.slice(boundary.index + boundary[0].length)
            if (oversized) {
              oversized = false
              continue
            }
            const data = frame
              .split(/\r\n|\r|\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n")
            if (data.trim() === "[DONE]") {
              controller.terminate()
              return
            }
            if (![...terminal].some((type) => data.includes(type))) continue
            const event = Option.getOrUndefined(decode(data))
            if (!isRecord(event) || typeof event.type !== "string" || !terminal.has(event.type)) continue
            controller.terminate()
            return
          }
        },
      }),
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
}
