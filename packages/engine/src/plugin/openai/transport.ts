import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"

export const REQUEST_ID_HEADER = "x-vector-request-id"
const decodeBody = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export type Diagnostic = {
  requestID: string
  sessionID?: string
  transport: "websocket" | "http"
  phase:
    | "selected"
    | "connecting"
    | "connected"
    | "request_sent"
    | "first_frame"
    | "first_progress"
    | "terminal"
    | "abort"
    | "failure"
  elapsedMs: number
  reused?: boolean
  reason?:
    | "conversation"
    | "disabled"
    | "title"
    | "missing_session"
    | "request"
    | "busy"
    | "fallback"
    | "setup_failure"
    | "rejected"
    | "connect"
    | "stream"
  terminal?: "completed" | "failed" | "incomplete" | "error" | "body_end"
  status?: number
  model?: string
  reasoningEffort?: string
  patchToolType?: "custom" | "function" | "absent" | "other"
}

export function createTrace(input: {
  transport: Diagnostic["transport"]
  headers: Record<string, string>
  report?: (event: Diagnostic) => void
  startedAt?: number
  body?: unknown
}) {
  const startedAt = input.startedAt ?? performance.now()
  const requestID = input.headers[REQUEST_ID_HEADER] ?? crypto.randomUUID()
  const sessionID = input.headers["x-session-affinity"] ?? input.headers["session-id"]
  const body = input.report
    ? typeof input.body === "string"
      ? Option.getOrUndefined(decodeBody(input.body))
      : input.body
    : undefined
  // Record only bounded routing fields and the patch wire mode. Never retain
  // the body, prompt, tool contents, credentials, or arbitrary reasoning configuration.
  const model =
    isRecord(body) && typeof body.model === "string" && /^[\w./:-]{1,128}$/.test(body.model) ? body.model : undefined
  const effort = isRecord(body) && isRecord(body.reasoning) ? body.reasoning.effort : undefined
  const reasoningEffort =
    typeof effort === "string" && ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)
      ? effort
      : undefined
  const patch = patchToolType(body)
  return (phase: Diagnostic["phase"], details?: Pick<Diagnostic, "reused" | "reason" | "terminal" | "status">) => {
    input.report?.({
      requestID,
      sessionID,
      transport: input.transport,
      phase,
      model,
      reasoningEffort,
      patchToolType: patch,
      elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      ...details,
    })
  }
}

function patchToolType(body: unknown): Diagnostic["patchToolType"] {
  if (!isRecord(body)) return
  if (body.tools === undefined) return "absent"
  if (!Array.isArray(body.tools)) return "other"
  const patch = body.tools.filter(isRecord).filter((tool) => tool.name === "apply_patch" || tool.type === "apply_patch")
  if (!patch.length) return "absent"
  if (patch.length !== 1) return "other"
  return patch[0].type === "custom" || patch[0].type === "function" ? patch[0].type : "other"
}

export async function fetchHttp(input: {
  fetch: typeof globalThis.fetch
  request: RequestInfo | URL
  init?: RequestInit
  trace: ReturnType<typeof createTrace>
  reason: Diagnostic["reason"]
}) {
  input.trace("selected", { reason: input.reason })
  const signal = input.init?.signal ?? (input.request instanceof Request ? input.request.signal : undefined)
  const response = await input.fetch(input.request, input.init).catch((error: unknown) => {
    input.trace(signal?.aborted ? "abort" : "failure", { reason: "connect" })
    throw error
  })
  input.trace("connected", { status: response.status })
  if (!response.body) {
    input.trace("terminal", { terminal: "body_end", status: response.status })
    return response
  }
  const reader = response.body.getReader()
  let first = true
  let cancelled = false
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read().catch((error: unknown) => {
          if (!cancelled) input.trace(signal?.aborted ? "abort" : "failure", { reason: "stream" })
          throw error
        })
        if (cancelled) return
        if (chunk.done) {
          input.trace("terminal", { terminal: "body_end", status: response.status })
          controller.close()
          return
        }
        if (first) {
          first = false
          // HTTP exposes body bytes, not WebSocket protocol frames. Content/tool timing is recorded by the LLM layer.
          input.trace("first_frame")
        }
        controller.enqueue(chunk.value)
      },
      async cancel(reason) {
        cancelled = true
        input.trace("abort")
        await reader.cancel(reason)
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  )
}

export * as OpenAITransport from "./transport"
