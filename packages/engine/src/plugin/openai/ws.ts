// Low-level OpenAI Responses WebSocket protocol helpers. Session pooling,
// fallback, and continuation state intentionally live above this file.

import WebSocket from "ws"
import { APICallError } from "ai"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ProviderError } from "@/provider/error"
import { errorMessage } from "@/util/error"
import { ProxyEnv } from "@/util/proxy-env"
import { isRecord } from "@/util/record"

export const PROTOCOL_HEADER = "responses_websockets=2026-02-06"

export interface ConnectResponsesWebSocketOptions {
  url: string
  headers: Record<string, string>
  timeout?: number
  signal?: AbortSignal
}

export interface StreamResponsesWebSocketOptions {
  socket: WebSocket
  body: Record<string, unknown>
  idleTimeout?: number
  signal?: AbortSignal
  // Holds response.created, queued and in_progress back until the response produces something, so a request the
  // server rejects right after accepting it can still be retried without the consumer seeing two responses.
  holdLifecycle?: boolean
  onRequestSent?: (bytes: number) => void
  onFirstFrame?: () => void
  onFirstProgress?: () => void
  onFirstEvent?: (error?: WrappedError) => void
  // Every event delivered to the consumer, in order.
  onEvent?: (event: Record<string, unknown>) => void
  onComplete?: (event: Record<string, unknown>) => void
  onTerminal?: (event: Record<string, unknown>) => void
  onRetryableTerminal?: (event: Record<string, unknown>) => Promise<Retry | undefined>
  onConnectionInvalid?: (error: ProviderError.ResponseStreamError) => void
  onAbort?: (error: Error) => void
}

export interface Retry {
  socket: WebSocket
  body: Record<string, unknown>
}

const LIFECYCLE = new Set(["response.created", "response.queued", "response.in_progress"])

export interface WrappedError {
  status: number
  headers?: Record<string, string>
  body: string
}

export function toWebSocketUrl(url: string) {
  return url.replace(/^http/, "ws")
}

export function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value
    })
    return result
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key.toLowerCase()] = value
    }
    return result
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value != null) result[key.toLowerCase()] = value
  }
  return result
}

export function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError"
}

export function connectResponsesWebSocket(options: ConnectResponsesWebSocketOptions) {
  return new Promise<WebSocket>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError(options.signal))
      return
    }

    const headers: Record<string, string> = {
      ...options.headers,
      "openai-beta": options.headers["openai-beta"] ?? PROTOCOL_HEADER,
    }
    delete headers["content-length"]

    // Bun serves the ws package itself, past the egress guard, so this model call is decided here the way Egress
    // decides any other; under Node the guard sees its socket too.
    const target = options.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")
    const host = URL.canParse(target) ? new URL(target).hostname : ""
    const place = LocalPolicy.hostClass(host)
    const decided = Egress.decide({ source: place === "internet" ? "cloud-inference" : "local-inference", url: target })
    if (decided.decision !== "allow") {
      reject(new EgressGuard.EgressBlocked(host, "websocket", decided.rule, decided.reason))
      return
    }
    // Bun does not apply HTTP(S)_PROXY to WebSockets unless the proxy is supplied explicitly. With Vector Local on, a
    // model call for this computer or your network never goes through one.
    const proxy =
      typeof Bun === "undefined" || (decided.rule !== "local-off" && place !== "internet")
        ? undefined
        : ProxyEnv.getProxyForUrl(target)
    const connect = { headers, ...(proxy ? { proxy } : {}) }
    const socket = new WebSocket(options.url, connect)
    const timeout = options.timeout
      ? setTimeout(() => {
          cleanup()
          socket.on("error", () => {})
          socket.terminate()
          reject(new Error("WebSocket connect timed out"))
        }, options.timeout)
      : undefined

    function cleanup() {
      if (timeout) clearTimeout(timeout)
      socket.off("open", onOpen)
      socket.off("error", onError)
      socket.off("close", onClose)
      options.signal?.removeEventListener("abort", onAbort)
    }

    function onOpen() {
      cleanup()
      resolve(socket)
    }

    function onError(error: unknown) {
      socket.on("error", () => {})
      cleanup()
      reject(error instanceof Error ? error : new Error(errorMessage(error), { cause: error }))
    }

    function onClose(code: number, reason: Buffer) {
      cleanup()
      reject(new Error(closeMessage("WebSocket closed before open", code, reason)))
    }

    function onAbort() {
      cleanup()
      socket.on("error", () => {})
      socket.terminate()
      reject(abortError(options.signal))
    }

    socket.once("open", onOpen)
    socket.once("error", onError)
    socket.once("close", onClose)
    options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function streamResponsesWebSocket(options: StreamResponsesWebSocketOptions) {
  const encoder = new TextEncoder()

  let socket = options.socket
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let cleanupSocket = () => {}
  let completed = false
  let emitted = false
  let announced = false
  let received = false
  let progressed = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const held: Array<{ event: Record<string, unknown>; text: string }> = []

  function cleanup() {
    if (idleTimer) clearTimeout(idleTimer)
    cleanupSocket()
    options.signal?.removeEventListener("abort", onAbort)
  }

  function terminateSocket(target = socket) {
    target.on("error", () => {})
    target.terminate()
  }

  function closeCompleted() {
    cleanup()
    controller?.enqueue(encoder.encode("data: [DONE]\n\n"))
    controller?.close()
  }

  function invalidate(error: ProviderError.ResponseStreamError) {
    if (completed) return
    completed = true
    cleanup()
    options.onConnectionInvalid?.(error)
    controller?.error(error)
  }

  function resetIdleTimeout(message: string) {
    if (completed) return
    if (!options.idleTimeout) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => invalidate(new ProviderError.ResponseStreamError(message)), options.idleTimeout)
  }

  async function onMessage(data: WebSocket.RawData, isBinary: boolean) {
    if (completed) return
    if (!received) {
      received = true
      options.onFirstFrame?.()
    }
    if (isBinary) {
      invalidate(new ProviderError.ResponseStreamError("Unexpected binary WebSocket frame"))
      return
    }

    const text = data.toString()
    const event = (() => {
      try {
        const parsed = JSON.parse(text)
        return isRecord(parsed) && typeof parsed.type === "string"
          ? (parsed as Record<string, unknown> & { type: string })
          : undefined
      } catch {
        return undefined
      }
    })()

    if (!event) {
      invalidate(new ProviderError.ResponseStreamError("Invalid WebSocket response event"))
      return
    }

    // A retry is only safe for an explicit rejection before any provider event was delivered.
    if ((event.type === "error" || event.type === "response.failed") && !emitted && options.onRetryableTerminal) {
      cleanupSocket()
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      try {
        const next = await options.onRetryableTerminal(event)
        if (completed) {
          if (next) terminateSocket(next.socket)
          return
        }
        if (next) {
          held.length = 0
          attach(next.socket, next.body)
          return
        }
      } catch (error) {
        invalidate(
          new ProviderError.ResponseStreamError(error instanceof Error ? error.message : String(error), {
            cause: error,
          }),
        )
        return
      }
    }

    if (!progressed && (event.type.endsWith(".delta") || event.type === "response.output_item.added")) {
      progressed = true
      options.onFirstProgress?.()
    }

    if (options.holdLifecycle && !emitted && LIFECYCLE.has(event.type)) {
      announce()
      held.push({ event, text })
      resetIdleTimeout("idle timeout waiting for websocket")
      return
    }
    held.splice(0).forEach((item) => deliver(item.event, item.text))

    const wrappedError = parseWrappedError(event, text)
    if (wrappedError && event) {
      announce(wrappedError)
      completed = true
      cleanup()
      options.onTerminal?.(event)
      controller?.error(
        new APICallError({
          message: wrappedError.message,
          url: socket.url,
          requestBodyValues: options.body,
          statusCode: wrappedError.status,
          responseHeaders: wrappedError.headers,
          responseBody: wrappedError.body,
        }),
      )
      return
    }

    deliver(event, text)
    resetIdleTimeout("idle timeout waiting for websocket")

    if (event.type === "response.completed" || event.type === "response.done") {
      completed = true
      options.onComplete?.(event)
      options.onTerminal?.(event)
      closeCompleted()
      return
    }

    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
      completed = true
      options.onTerminal?.(event)
      closeCompleted()
    }
  }

  function announce(error?: WrappedError) {
    if (announced) return
    announced = true
    options.onFirstEvent?.(error)
  }

  function deliver(event: Record<string, unknown>, text: string) {
    announce()
    options.onEvent?.(event)
    controller?.enqueue(
      encoder.encode(
        `${text
          .split(/\r?\n/)
          .map((line) => `data: ${line}`)
          .join("\n")}\n\n`,
      ),
    )
    emitted = true
  }

  function onError(error: Error) {
    invalidate(new ProviderError.ResponseStreamError(error.message, { cause: error }))
  }

  function onClose(code: number, reason: Buffer) {
    if (completed) return
    invalidate(
      new ProviderError.ResponseStreamError(closeMessage("WebSocket closed before response.completed", code, reason)),
    )
  }

  function onAbort() {
    const error = abortError(options.signal)
    if (completed) return
    completed = true
    cleanup()
    terminateSocket()
    options.onAbort?.(error)
    controller?.error(error)
  }

  function onCancel(reason: unknown) {
    if (completed) return
    completed = true
    cleanup()
    terminateSocket()
    options.onAbort?.(cancelError(reason))
  }

  function attach(next: WebSocket, body: Record<string, unknown>) {
    cleanupSocket()
    socket = next
    socket.on("message", onMessage)
    socket.once("error", onError)
    socket.once("close", onClose)
    cleanupSocket = () => {
      socket.off("message", onMessage)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    const { stream: _stream, background: _background, ...payload } = body
    const frame = JSON.stringify({ type: "response.create", ...payload })
    resetIdleTimeout("idle timeout sending websocket request")
    socket.send(frame, (error) => {
      if (completed) return
      if (error) {
        invalidate(new ProviderError.ResponseStreamError(error.message, { cause: error }))
        return
      }
      options.onRequestSent?.(Buffer.byteLength(frame))
      resetIdleTimeout("idle timeout waiting for websocket")
    })
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        options.signal?.addEventListener("abort", onAbort, { once: true })

        if (options.signal?.aborted) {
          onAbort()
          return
        }

        attach(socket, options.body)
      },
      cancel(reason) {
        onCancel(reason)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function parseWrappedError(event: Record<string, unknown> | undefined, body: string) {
  if (event?.type !== "error") return
  const status = event.status ?? event.status_code
  if (typeof status !== "number" || (status >= 200 && status < 300)) return
  return {
    status,
    headers: isRecord(event.headers)
      ? Object.fromEntries(
          Object.entries(event.headers).flatMap(([key, value]) =>
            typeof value === "string" || typeof value === "number" || typeof value === "boolean"
              ? [[key, String(value)]]
              : [],
          ),
        )
      : undefined,
    body,
    message: isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : `${status}`,
  }
}

function cancelError(reason: unknown) {
  if (isAbortError(reason)) return reason
  if (reason instanceof Error) return reason
  return new DOMException(typeof reason === "string" ? reason : "Aborted", "AbortError")
}

function abortError(signal: AbortSignal | undefined) {
  const reason = signal?.reason
  if (isAbortError(reason)) return reason
  return new DOMException(reason instanceof Error ? reason.message : "Aborted", "AbortError")
}

function closeMessage(message: string, code: number, reason: Buffer) {
  const details = [`code ${code}`]
  if (code === 1009) details.push("message too big")
  if (reason.length > 0) details.push(reason.toString())
  return `${message} (${details.join(": ")})`
}

export * as OpenAIWebSocket from "./ws"
