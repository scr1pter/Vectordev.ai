import WebSocket from "ws"
import { createHash } from "node:crypto"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { OpenAIWebSocket } from "./ws"
import { OpenAITransport } from "./transport"

export const TITLE_HEADER = "x-vector-title"

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  streamRetries?: number
  onDiagnostic?: (event: OpenAITransport.Diagnostic) => void
}

interface PoolEntry {
  socket?: WebSocket
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
  lifecycle: AbortController
  identity?: string
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"

export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options?.streamRetries ?? 5
  let closed = false
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (closed) throw new DOMException("WebSocket pool is closed", "AbortError")
    const startedAt = performance.now()
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    internalHeaders[OpenAITransport.REQUEST_ID_HEADER] ??= crypto.randomUUID()
    const httpInit = withoutInternalHeaders(init, input)

    const http = (reason: OpenAITransport.Diagnostic["reason"]) =>
      OpenAITransport.fetchHttp({
        fetch: httpFetch,
        request: input,
        init: httpInit,
        reason,
        trace: OpenAITransport.createTrace({
          transport: "http",
          headers: internalHeaders,
          report: options?.onDiagnostic,
          startedAt,
          body: init?.body,
        }),
      })

    if (!new URL(url).pathname.endsWith("/responses")) {
      return httpFetch(input, httpInit)
    }
    // A Request owns its body stream. Preserve it through HTTP rather than consuming it to inspect WS eligibility.
    if (input instanceof Request && init?.body === undefined) return http("request")
    if (init?.method !== "POST") return httpFetch(input, httpInit)

    const body = (() => {
      try {
        if (typeof init?.body !== "string") return undefined
        const parsed = JSON.parse(init.body)
        return typeof parsed === "object" && parsed !== null ? parsed : undefined
      } catch {
        return undefined
      }
    })()
    if (!body?.stream) return httpFetch(input, httpInit)
    if (internalHeaders[TITLE_HEADER] === "true") {
      return http("title")
    }

    const sessionID = internalHeaders["x-session-affinity"] ?? internalHeaders["session-id"]
    if (!sessionID) {
      return http("missing_session")
    }
    const key = `${sessionID}:conversation`

    const entry = pool.get(key) ?? {
      lastUsedAt: Date.now(),
      busy: false,
      fallback: false,
      streamFailures: 0,
      lifecycle: new AbortController(),
    }
    pool.set(key, entry)

    if (entry.fallback) {
      return http("fallback")
    }
    if (entry.busy) {
      return http("busy")
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    const signal = init?.signal ? AbortSignal.any([init.signal, entry.lifecycle.signal]) : entry.lifecycle.signal
    const trace = OpenAITransport.createTrace({
      transport: "websocket",
      headers: internalHeaders,
      report: options?.onDiagnostic,
      startedAt,
      body,
    })
    trace("selected", { reason: "conversation" })
    let streaming = false
    let rejected = false
    try {
      entry.socket = await socket(
        entry,
        options?.url ?? url,
        OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
        connectTimeout,
        maxConnectionAge,
        signal,
        trace,
      )
      let resolveFirstEvent: (event: boolean | OpenAIWebSocket.WrappedError) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean | OpenAIWebSocket.WrappedError>((resolve, reject) => {
        resolveFirstEvent = resolve
        rejectFirstEvent = reject
      })
      streaming = true
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body,
        idleTimeout,
        signal,
        onRequestSent: () => trace("request_sent"),
        onFirstFrame: () => trace("first_frame"),
        onFirstProgress: () => trace("first_progress"),
        onFirstEvent: (error) => resolveFirstEvent(error ?? true),
        onTerminal: (event) => {
          trace("terminal", {
            terminal:
              event.type === "response.completed" || event.type === "response.done"
                ? "completed"
                : event.type === "response.incomplete"
                  ? "incomplete"
                  : event.type === "response.failed"
                    ? "failed"
                    : "error",
          })
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (event.type !== "response.completed" && event.type !== "response.done") {
            invalidate(entry)
          }
        },
        onConnectionInvalid: (error) => {
          trace("failure", { reason: "stream" })
          entry.busy = false
          entry.lastUsedAt = Date.now()
          if (!entry.fallback) recordStreamFailure(entry)
          invalidate(entry)
          resolveFirstEvent(false)
        },
        onAbort: (error) => {
          trace("abort")
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          invalidate(entry)
          rejectFirstEvent(error)
        },
        onRetryableTerminal: async (event) => {
          const error = connectionLimitError(event)
          if (!error) return undefined
          rejected = true
          throw error
        },
      })
      const first = await firstEvent
      if (first !== false) {
        if (first === true || first.status < 200 || first.status > 599) return response
        return new Response(first.body, {
          status: first.status,
          headers: { "content-type": "application/json", ...first.headers },
        })
      }
      // A missing first frame does not establish that a sent request was rejected. Only an explicit
      // connection-limit rejection permits same-call replay; uncertain failures fall back on the next call.
      if (!entry.fallback || !rejected) return response
      return http("rejected")
    } catch (error) {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (OpenAIWebSocket.isAbortError(error)) {
        if (!streaming) trace("abort")
        entry.streamFailures = 0
        invalidate(entry)
        throw error
      }

      recordStreamFailure(entry)
      trace("failure", { reason: streaming ? "stream" : "connect" })
      invalidate(entry)
      if (entry.fallback && !streaming) return http("setup_failure")
      return failedResponse(
        new ProviderError.ResponseStreamError(error instanceof Error ? error.message : String(error), {
          cause: error,
        }),
      )
    }
  }

  function recordStreamFailure(entry: PoolEntry) {
    entry.streamFailures++
    // Codex counts retries after the initial failed WebSocket attempt.
    if (entry.streamFailures > streamRetries) entry.fallback = true
  }

  function prune() {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.busy) continue
      if (entry.fallback) continue
      if (now - entry.lastUsedAt < idleTimeout) continue
      invalidate(entry)
      pool.delete(key)
    }
  }

  function close() {
    closed = true
    clearInterval(pruneTimer)
    for (const entry of pool.values()) {
      entry.lifecycle.abort(new DOMException("WebSocket pool is closed", "AbortError"))
      invalidate(entry)
    }
    pool.clear()
  }

  function remove(sessionID: string) {
    const key = `${sessionID}:conversation`
    const entry = pool.get(key)
    if (!entry) return
    entry.lifecycle.abort(new DOMException("Session was removed", "AbortError"))
    invalidate(entry)
    pool.delete(key)
  }

  return Object.assign(websocketFetch, { close, remove })
}

function connectionLimitError(event: Record<string, unknown>) {
  if (event.type !== "error" || !isRecord(event.error) || event.error.code !== CONNECTION_LIMIT_REACHED_CODE) return
  return new Error(typeof event.error.message === "string" ? event.error.message : CONNECTION_LIMIT_REACHED_CODE)
}

function failedResponse(error: ProviderError.ResponseStreamError) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  signal?: AbortSignal | null,
  trace?: ReturnType<typeof OpenAITransport.createTrace>,
) {
  // A session can switch endpoints/accounts without changing its ID. Never reuse the old authenticated socket.
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        url,
        headers.authorization,
        headers["chatgpt-account-id"],
        headers["openai-organization"],
        headers["openai-project"],
        headers["openai-beta"],
      ]),
    )
    .digest("hex")
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < maxConnectionAge &&
    entry.identity === identity
  ) {
    trace?.("connected", { reused: true })
    return entry.socket
  }

  invalidate(entry)
  trace?.("connecting")
  const next = await OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    signal: signal ?? undefined,
  })
  entry.connectedAt = Date.now()
  entry.identity = identity
  trace?.("connected", { reused: false })
  return next
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) {
    entry.socket.on("error", () => {})
    entry.socket.terminate()
    entry.socket = undefined
  }
  entry.connectedAt = undefined
  entry.identity = undefined
}

export function withoutInternalHeaders(
  init: RequestInit | undefined,
  request?: RequestInfo | URL,
): RequestInit | undefined {
  if (!init?.headers && request instanceof Request) return withoutInternalHeaders({ ...init, headers: request.headers })
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    headers.delete(OpenAITransport.REQUEST_ID_HEADER)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return {
      ...init,
      headers: init.headers.filter(
        (item) => ![TITLE_HEADER, OpenAITransport.REQUEST_ID_HEADER].includes(item[0].toLowerCase()),
      ),
    }
  }

  return {
    ...init,
    headers: Object.fromEntries(
      Object.entries(init.headers).filter(
        ([key]) => ![TITLE_HEADER, OpenAITransport.REQUEST_ID_HEADER].includes(key.toLowerCase()),
      ),
    ),
  }
}

export * as OpenAIWebSocketPool from "./ws-pool"
