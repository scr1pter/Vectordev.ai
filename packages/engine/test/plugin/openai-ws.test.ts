import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"
import net, { type AddressInfo, type Socket } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import { APICallError } from "ai"
import { ProviderError } from "../../src/provider/error"
import { OpenAIWebSocket } from "../../src/plugin/openai/ws"
import { OpenAIWebSocketPool, TITLE_HEADER } from "../../src/plugin/openai/ws-pool"
import { OpenAITransport } from "../../src/plugin/openai/transport"

describe("plugin.openai.ws", () => {
  test("derives websocket URLs and sends auth plus protocol headers", async () => {
    let headers: IncomingMessage["headers"] | undefined
    await using server = await createWebSocketServer((_socket, request) => {
      headers = request.headers
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({
      url: server.wsUrl,
      headers: { authorization: "Bearer test", "content-length": "123" },
    })

    expect(OpenAIWebSocket.toWebSocketUrl("http://example.com/v1/responses")).toBe("ws://example.com/v1/responses")
    expect(OpenAIWebSocket.toWebSocketUrl("https://example.com/v1/responses")).toBe("wss://example.com/v1/responses")
    expect(headers?.authorization).toBe("Bearer test")
    expect(headers?.["openai-beta"]).toBe(OpenAIWebSocket.PROTOCOL_HEADER)
    expect(headers?.["content-length"]).toBeUndefined()
    socket.terminate()
  })

  test("enforces websocket connect timeout", async () => {
    await using server = await createHangingTcpServer()

    await expect(
      OpenAIWebSocket.connectResponsesWebSocket({
        url: server.wsUrl,
        headers: {},
        timeout: 20,
      }),
    ).rejects.toThrow("WebSocket connect timed out")
  })

  test("surfaces websocket upgrade rejection messages", async () => {
    await using server = await createRejectingWebSocketServer(() => {})

    await expect(
      OpenAIWebSocket.connectResponsesWebSocket({
        url: server.wsUrl,
        headers: {},
      }),
    ).rejects.toThrow("Expected 101 status code")
  })

  test("enforces websocket send idle timeout", async () => {
    const socket = new (class extends EventEmitter {
      send(_data: string, _callback: (error?: Error) => void) {}
    })() as unknown as WebSocket
    const invalid: string[] = []
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      idleTimeout: 20,
      onConnectionInvalid: (error) => invalid.push(error.message),
    })

    expect((await readTextError(response.text())).message).toContain("idle timeout sending websocket request")
    expect(invalid).toEqual(["idle timeout sending websocket request"])
  })

  test("streams websocket events as SSE and handles response.done", async () => {
    let requestBody: unknown
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", (data) => {
        requestBody = JSON.parse(data.toString())
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "hello" }))
        socket.send(JSON.stringify({ type: "response.done", response: { id: "resp_123" } }))
        socket.close(1000, "done")
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({
      url: server.wsUrl,
      headers: { authorization: "Bearer test", "content-length": "123" },
    })
    const completed: Record<string, unknown>[] = []
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, background: true, input: "hi" },
      onComplete: (event) => completed.push(event),
    })

    expect(await response.text()).toBe(
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.done","response":{"id":"resp_123"}}\n\ndata: [DONE]\n\n',
    )
    expect(requestBody).toEqual({ type: "response.create", input: "hi" })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.type).toBe("response.done")
  })

  test("errors the SSE stream when the server closes before a terminal event", async () => {
    const invalid: Error[] = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.close(1009, "payload too large")
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({ url: server.wsUrl, headers: {} })
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      onConnectionInvalid: (error) => invalid.push(error),
    })

    expect((await readTextError(response.text())).message).toContain(
      "WebSocket closed before response.completed (code 1009: message too big: payload too large)",
    )
    expect(invalid[0]).toBeInstanceOf(ProviderError.ResponseStreamError)
    expect(invalid.map((error) => error.message)).toEqual([
      "WebSocket closed before response.completed (code 1009: message too big: payload too large)",
    ])
  })

  test("rejects unexpected binary websocket frames", async () => {
    const invalid: string[] = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(Buffer.from("not json text"))
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({ url: server.wsUrl, headers: {} })
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      onConnectionInvalid: (error) => invalid.push(error.message),
    })

    expect((await readTextError(response.text())).message).toContain("Unexpected binary WebSocket frame")
    expect(invalid).toEqual(["Unexpected binary WebSocket frame"])
  })

  test("rejects malformed protocol frames immediately", async () => {
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => socket.send("not-json"))
    })
    const socket = await OpenAIWebSocket.connectResponsesWebSocket({ url: server.wsUrl, headers: {} })
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true },
      onConnectionInvalid: () => socket.terminate(),
    })
    expect((await readTextError(response.text())).message).toBe("Invalid WebSocket response event")
  })
})

describe("plugin.openai.ws-pool", () => {
  test("reuses one healthy websocket for sequential requests", async () => {
    let connections = 0
    let messages = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        messages += 1
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${messages}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(1)
    expect(messages).toBe(2)
    fetch.close()
  })

  test("records bounded transport timing without request or response contents", async () => {
    const events: OpenAITransport.Diagnostic[] = []
    const headers: IncomingMessage["headers"][] = []
    await using server = await createWebSocketServer((socket, request) => {
      headers.push(request.headers)
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "response.created", response: { id: "private-response" } }))
        Array.from({ length: 30 }).forEach(() =>
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "private-output" })),
        )
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "private-response" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({ onDiagnostic: (event) => events.push(event) })
    for (const requestID of ["request-one", "request-two"]) {
      const response = await fetch(server.url, {
        ...streamRequest({ authorization: "Bearer private-token", [OpenAITransport.REQUEST_ID_HEADER]: requestID }),
        body: JSON.stringify({
          stream: true,
          model: "gpt-6-luna",
          reasoning: { effort: "max", privateNote: "private-note" },
          input: "private-prompt",
          tools: [{ type: "custom", name: "apply_patch", description: "private-description" }],
        }),
      })
      expect(await response.text()).toContain("[DONE]")
      const requestEvents = events.filter((event) => event.requestID === requestID)
      expect(requestEvents.filter((event) => event.phase === "first_frame")).toHaveLength(1)
      expect(requestEvents.filter((event) => event.phase === "first_progress")).toHaveLength(1)
      expect(requestEvents.filter((event) => event.phase === "terminal")).toHaveLength(1)
      expect(requestEvents.every((event) => event.elapsedMs >= 0 && event.transport === "websocket")).toBe(true)
      expect(requestEvents.every((event) => event.model === "gpt-6-luna" && event.reasoningEffort === "max")).toBe(true)
      expect(requestEvents.every((event) => event.patchToolType === "custom")).toBe(true)
      expect(requestEvents.length).toBeLessThanOrEqual(7)
    }
    expect(events.filter((event) => event.phase === "connected").map((event) => event.reused)).toEqual([false, true])
    expect(headers).toHaveLength(1)
    expect(headers[0]?.[OpenAITransport.REQUEST_ID_HEADER]).toBeUndefined()
    expect(JSON.stringify(events)).not.toContain("private-")
    fetch.close()
  })

  test.each(["authorization", "chatgpt-account-id", "openai-organization", "openai-project"])(
    "rotates authenticated sockets when %s changes",
    async (header) => {
      let connections = 0
      await using server = await createWebSocketServer((socket) => {
        connections++
        socket.on("message", () => socket.send(JSON.stringify({ type: "response.completed", response: {} })))
      })
      const fetch = OpenAIWebSocketPool.createWebSocketFetch()
      expect(await (await fetch(server.url, streamRequest({ [header]: "first" }))).text()).toContain("[DONE]")
      expect(await (await fetch(server.url, streamRequest({ [header]: "second" }))).text()).toContain("[DONE]")
      expect(connections).toBe(2)
      fetch.close()
    },
  )

  test("rotates sockets when the endpoint changes within one session", async () => {
    const requests: string[] = []
    await using first = await createWebSocketServer((socket) => {
      socket.on("message", () => {
        requests.push("first")
        socket.send(JSON.stringify({ type: "response.completed", response: {} }))
      })
    })
    await using second = await createWebSocketServer((socket) => {
      socket.on("message", () => {
        requests.push("second")
        socket.send(JSON.stringify({ type: "response.completed", response: {} }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch()
    await (await fetch(first.url, streamRequest())).text()
    await (await fetch(second.url, streamRequest())).text()
    expect(requests).toEqual(["first", "second"])
    fetch.close()
  })

  test.each(["remove", "close"])(
    "%s cancels an in-flight handshake without sending work",
    async (action) => {
      await using server = await createHangingTcpServer()
      await using fallback = await createHttpServer()
      const fetch = OpenAIWebSocketPool.createWebSocketFetch({
        url: server.url,
        connectTimeout: 10_000,
        streamRetries: 0,
      })
      const first = fetch(fallback.url, streamRequest())
      await waitFor(() => server.connections() === 1, "websocket handshake did not start")
      if (action === "remove") fetch.remove("session-1")
      if (action === "close") fetch.close()
      expect(await first.catch((error: unknown) => error)).toBeInstanceOf(DOMException)
      expect(fallback.httpRequests).toHaveLength(0)
      fetch.close()
    },
    2_000,
  )

  test("a closed pool cannot start another request", async () => {
    await using server = await createHttpServer()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch()
    fetch.close()
    await expect(fetch(server.url, streamRequest())).rejects.toThrow("WebSocket pool is closed")
    expect(server.httpRequests).toHaveLength(0)
  })

  test("rotates a socket that exceeds max connection age", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${connections}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      maxConnectionAge: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("falls back to HTTP after websocket setup retries are exhausted", async () => {
    const attempts: string[] = []
    await using server = await createRejectingWebSocketServer(() => attempts.push("websocket"))
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))
    expect(await readTextError(first.text())).toBeInstanceOf(ProviderError.ResponseStreamError)
    const second = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))
    const third = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))

    expect(await second.text()).toBe("http")
    expect(await third.text()).toBe("http")
    expect(attempts).toEqual(["websocket", "websocket"])
    expect(server.httpRequests).toHaveLength(2)
    expect(server.httpRequests[0]?.headers[TITLE_HEADER]).toBeUndefined()
    expect(server.httpRequests[1]?.headers[TITLE_HEADER]).toBeUndefined()
    fetch.close()
  })

  test("keeps HTTP fallback active after its idle timeout", async () => {
    let websocketAttempts = 0
    await using server = await createRejectingWebSocketServer(() => websocketAttempts++)
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      idleTimeout: 20,
      streamRetries: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toBe("http")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(websocketAttempts).toBe(1)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("removes HTTP fallback when its session is deleted", async () => {
    let websocketAttempts = 0
    await using server = await createRejectingWebSocketServer(() => websocketAttempts++)
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      streamRetries: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toBe("http")
    fetch.remove("session-1")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(websocketAttempts).toBe(2)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("terminates active websocket connections when their session is deleted", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_after_remove" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    const firstText = first.text()
    fetch.remove("session-1")
    expect((await readTextError(firstText)).message).toContain("Session was removed")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("prunes idle websocket connections after completed responses", async () => {
    let connections = 0
    let closed = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("close", () => closed++)
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${connections}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 20,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")
    await waitFor(() => closed === 1, "idle websocket was not pruned")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("invalidates but does not reuse a socket after terminal failure frames", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: connections === 1 ? "response.failed" : "response.completed" }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain('data: {"type":"response.failed"}')

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain('data: {"type":"response.completed"}')
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("returns initial websocket error frames as HTTP-style API errors", async () => {
    const error = {
      type: "invalid_request_error",
      message: "The model is not supported when using Codex with a ChatGPT account.",
    }
    const event = {
      type: "error",
      status: 400,
      error,
      headers: {
        "x-codex-primary-window-minutes": 15,
        ignored: { nested: true },
      },
    }
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify(event))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const response = await fetch(server.url, streamRequest())

    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("x-codex-primary-window-minutes")).toBe("15")
    expect(response.headers.get("ignored")).toBeNull()
    expect(await response.json()).toEqual(event)
    fetch.close()
  })

  test("fails mid-stream wrapped websocket errors as HTTP-style API errors", async () => {
    const event = {
      type: "error",
      status_code: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
      },
      headers: {
        "x-codex-primary-used-percent": "100.0",
      },
    }
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
        socket.send(JSON.stringify(event))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const response = await fetch(server.url, streamRequest())
    const error = await readTextError(response.text())

    expect(APICallError.isInstance(error)).toBe(true)
    if (!APICallError.isInstance(error)) throw new Error("Expected APICallError")
    expect(error.statusCode).toBe(429)
    expect(error.responseHeaders).toEqual({ "x-codex-primary-used-percent": "100.0" })
    expect(error.responseBody).toBe(JSON.stringify(event))
    fetch.close()
  })

  test("retries websocket connection limit errors on the next stream attempt", async () => {
    let connections = 0
    let messages = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        messages += 1
        if (connections === 1) {
          socket.send(
            JSON.stringify({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                code: "websocket_connection_limit_reached",
                message: "Responses websocket connection limit reached",
              },
            }),
          )
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_retry" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("Responses websocket connection limit reached")
    const second = await fetch(server.url, streamRequest())
    const text = await second.text()

    expect(text).not.toContain("websocket_connection_limit_reached")
    expect(text).toContain('data: {"type":"response.completed","response":{"id":"resp_retry"}}')
    expect(text).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(messages).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("falls back to HTTP after websocket connection limit retries are exhausted", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            type: "error",
            status: 400,
            error: {
              type: "invalid_request_error",
              code: "websocket_connection_limit_reached",
              message: "Responses websocket connection limit reached",
            },
          }),
        )
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 2,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("Responses websocket connection limit reached")
    const second = await fetch(server.url, streamRequest())
    expect((await readTextError(second.text())).message).toContain("Responses websocket connection limit reached")
    const third = await fetch(server.url, streamRequest())
    const fourth = await fetch(server.url, streamRequest())

    expect(await third.text()).toBe("http")
    expect(await fourth.text()).toBe("http")
    expect(connections).toBe(3)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("shares the websocket retry budget across stream and connection limit failures", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          socket.terminate()
          return
        }
        socket.send(
          JSON.stringify({
            type: "error",
            error: {
              code: "websocket_connection_limit_reached",
              message: "Responses websocket connection limit reached",
            },
          }),
        )
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("retries websocket idle failures before first event then falls back to HTTP", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {})
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 20,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("idle timeout waiting for websocket")
    const second = await fetch(server.url, streamRequest())
    expect((await readTextError(second.text())).message).toContain("idle timeout waiting for websocket")
    const third = await fetch(server.url, streamRequest())

    expect(await third.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("keeps websocket retry state until the failed stream becomes idle", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {})
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 500,
      streamRetries: 1,
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("idle timeout waiting for websocket")
    await new Promise((resolve) => setTimeout(resolve, 300))

    const second = await fetch(server.url, streamRequest())

    expect((await readTextError(second.text())).message).toContain("idle timeout waiting for websocket")
    expect(await (await fetch(server.url, streamRequest())).text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("retries failed websocket streams before using HTTP fallback", async () => {
    const attempts: Array<(socket: WebSocket) => void> = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
        attempts.shift()?.(socket)
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const firstAttempt = new Promise<WebSocket>((resolve) => attempts.push(resolve))
    const first = await fetch(server.url, streamRequest())
    const firstSocket = await firstAttempt
    firstSocket.terminate()
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const secondAttempt = new Promise<WebSocket>((resolve) => attempts.push(resolve))
    const second = await fetch(server.url, streamRequest())
    const secondSocket = await secondAttempt
    secondSocket.terminate()
    expect((await readTextError(second.text())).message).toContain("WebSocket closed before response.completed")
    const third = await fetch(server.url, streamRequest())

    expect(await third.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("resets websocket stream failures after a completed response", async () => {
    let connections = 0
    let requests = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        requests += 1
        if (requests === 1 || requests === 3) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          socket.terminate()
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${requests}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    const third = await fetch(server.url, streamRequest())
    expect((await readTextError(third.text())).message).toContain("WebSocket closed before response.completed")
    const fourth = await fetch(server.url, streamRequest())

    expect(await fourth.text()).toContain("data: [DONE]")
    expect(connections).toBe(3)
    expect(requests).toBe(4)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("falls back to HTTP for missing session and title requests", async () => {
    await using server = await createWebSocketServer(() => {})
    const fetch = OpenAIWebSocketPool.createWebSocketFetch()

    const missingSession = await fetch(server.url, {
      method: "POST",
      headers: { [TITLE_HEADER]: "false" },
      body: JSON.stringify({ stream: true }),
    })
    const title = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "true" }))

    expect(await missingSession.text()).toBe("http")
    expect(await title.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(2)
    expect(server.httpRequests[0]?.headers[TITLE_HEADER]).toBeUndefined()
    expect(server.httpRequests[1]?.headers[TITLE_HEADER]).toBeUndefined()
    fetch.close()
  })

  test("falls back to HTTP while a websocket lane is busy", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
      })
    })
    const abort = new AbortController()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest({}, abort.signal))
    const firstText = first.text()
    await waitFor(() => connections === 1, "websocket did not connect")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(1)
    expect(connections).toBe(1)
    abort.abort(new Error("stop"))
    expect((await readTextError(firstText)).message).toContain("stop")
    fetch.close()
  })

  test("reserves a websocket lane while its socket is connecting", async () => {
    await using server = await createHangingTcpServer()
    await using fallback = await createHttpServer()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 20,
      streamRetries: 0,
    })

    const first = fetch(fallback.url, streamRequest())
    await waitFor(() => server.connections() === 1, "first websocket did not begin connecting")
    const second = fetch(fallback.url, streamRequest())

    expect(await (await second).text()).toBe("http")
    expect(await (await first).text()).toBe("http")
    expect(server.connections()).toBe(1)
    expect(fallback.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("retries unexpected closes before first event then falls back to HTTP", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.close(1001, "server shutdown")
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())
    expect((await readTextError(second.text())).message).toContain("WebSocket closed before response.completed")
    const third = await fetch(server.url, streamRequest())

    expect(await third.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("does not keep HTTP fallback active after aborting a websocket response", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_456" } }))
      })
    })
    const abort = new AbortController()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest({}, abort.signal))
    const firstText = first.text()
    await waitFor(() => connections === 1, "first websocket did not connect")
    abort.abort(new Error("stop"))
    expect((await readTextError(firstText)).message).toContain("stop")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("releases the websocket lane when the response body is cancelled", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_after_cancel" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    await waitFor(() => connections === 1, "first websocket did not connect")
    await first.body!.cancel("stop")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })
})

describe("plugin.openai.http", () => {
  test("strips internal Request headers while preserving body, signal, correlation, and init precedence", async () => {
    const bodies: string[] = []
    await using server = await createHttpServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString())
        response.writeHead(202, "Accepted", { "content-type": "text/plain", "x-upstream": "kept" })
        response.end("private-response")
      })
    })
    const events: OpenAITransport.Diagnostic[] = []
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({ onDiagnostic: (event) => events.push(event) })
    try {
      const response = await fetch(
        new Request(server.url, {
          method: "POST",
          headers: { "x-vector-request-id": "request-native", "x-vector-title": "true", authorization: "private-auth" },
          body: "private-request",
        }),
      )
      expect(response.status).toBe(202)
      expect(response.statusText).toBe("Accepted")
      expect(response.headers.get("x-upstream")).toBe("kept")
      expect(await response.text()).toBe("private-response")
      const override = await fetch(
        new Request(server.url, {
          method: "POST",
          headers: { "x-vector-request-id": "ignored-request", authorization: "ignored-auth" },
          body: "override-request",
        }),
        { headers: { "X-Vector-Request-Id": "override-id", "X-Vector-Title": "true", authorization: "override-auth" } },
      )
      await override.text()
      expect(bodies).toEqual(["private-request", "override-request"])
      expect(server.httpRequests.map((request) => request.method)).toEqual(["POST", "POST"])
      expect(server.httpRequests.map((request) => request.headers.authorization)).toEqual([
        "private-auth",
        "override-auth",
      ])
      expect(
        server.httpRequests.every(
          (request) => !request.headers["x-vector-request-id"] && !request.headers["x-vector-title"],
        ),
      ).toBe(true)
      expect(events.filter((event) => event.phase === "selected").map((event) => event.requestID)).toEqual([
        "request-native",
        "override-id",
      ])
      expect(events.filter((event) => event.phase === "terminal")).toHaveLength(2)
      expect(JSON.stringify(events)).not.toContain("private-")
    } finally {
      fetch.close()
    }
  })

  test.each(["object", "headers", "tuples"])("strips mixed-case internal %s init headers", async (kind) => {
    await using server = await createHttpServer()
    const entries: [string, string][] = [
      ["X-Vector-Request-Id", "private-request"],
      ["X-Vector-Title", "true"],
      ["Authorization", "kept"],
    ]
    const headers =
      kind === "object" ? Object.fromEntries(entries) : kind === "headers" ? new Headers(entries) : entries
    const fetch = OpenAIWebSocketPool.createWebSocketFetch()
    try {
      const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ stream: true }) })
      expect(await response.text()).toBe("http")
      expect(server.httpRequests[0].headers["x-vector-request-id"]).toBeUndefined()
      expect(server.httpRequests[0].headers["x-vector-title"]).toBeUndefined()
      expect(server.httpRequests[0].headers.authorization).toBe("kept")
    } finally {
      fetch.close()
    }
  })

  test("propagates HTTP body cancellation and emits one redacted abort", async () => {
    const cancelled = Promise.withResolvers<unknown>()
    const events: OpenAITransport.Diagnostic[] = []
    // Bun's native HTTP reader cancellation does not close its upstream socket. Use a real stream
    // source to observe cancellation forwarding, including a pending read, without relying on that runtime behavior.
    const response = await OpenAITransport.fetchHttp({
      request: "http://localhost/v1/responses",
      fetch: Object.assign(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("private-first-chunk"))
              },
              cancel(reason) {
                cancelled.resolve(reason)
              },
            }),
          ),
        { preconnect: fetch.preconnect },
      ),
      reason: "disabled",
      trace: OpenAITransport.createTrace({ transport: "http", headers: {}, report: (event) => events.push(event) }),
    })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel("private-cancel-reason")
    expect(await cancelled.promise).toBe("private-cancel-reason")
    expect(events.filter((event) => event.phase === "abort")).toHaveLength(1)
    expect(events.filter((event) => event.phase === "terminal")).toHaveLength(0)
    expect(JSON.stringify(events)).not.toContain("private-")
  })

  test("propagates HTTP stream errors and emits one bounded failure", async () => {
    const upstream = Promise.withResolvers<ServerResponse>()
    await using server = await createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "content-length": "10000" })
      response.write("private-first-chunk")
      upstream.resolve(response)
    })
    const events: OpenAITransport.Diagnostic[] = []
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({ onDiagnostic: (event) => events.push(event) })
    try {
      const response = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "true" }))
      const reader = response.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      ;(await upstream.promise).destroy()
      const error = await reader.read().then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect(events.filter((event) => event.phase === "failure")).toHaveLength(1)
      expect(events.filter((event) => event.phase === "terminal")).toHaveLength(0)
      expect(JSON.stringify(events)).not.toContain("private-")
    } finally {
      fetch.close()
    }
  })

  test("preserves a native Request abort signal before headers arrive", async () => {
    const received = Promise.withResolvers<void>()
    await using server = await createHttpServer(() => received.resolve())
    const events: OpenAITransport.Diagnostic[] = []
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({ onDiagnostic: (event) => events.push(event) })
    const controller = new AbortController()
    try {
      const pending = fetch(
        new Request(server.url, { method: "POST", body: "private-prompt", signal: controller.signal }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      )
      await received.promise
      controller.abort(new DOMException("private-abort", "AbortError"))
      expect(await pending).toBeInstanceOf(Error)
      expect(events.filter((event) => event.phase === "abort")).toHaveLength(1)
      expect(JSON.stringify(events)).not.toContain("private-")
    } finally {
      fetch.close()
    }
  })
})

function streamRequest(headers?: Record<string, string>, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: {
      "session-id": "session-1",
      authorization: "Bearer test",
      ...headers,
    },
    body: JSON.stringify({ stream: true, input: "hi" }),
    signal,
  }
}

async function readTextError(promise: Promise<string>) {
  // Bun 1.3.14 hangs on expect(response.text()).rejects for streams errored from ws callbacks.
  return promise.then(
    () => {
      throw new Error("Expected response text to reject")
    },
    (error) => {
      expect(error).toBeInstanceOf(Error)
      return error as Error
    },
  )
}

async function createWebSocketServer(onConnection: (socket: WebSocket, request: IncomingMessage) => void) {
  const http = await createHttpServer()
  const server = new WebSocketServer({ server: http.server })
  server.on("connection", onConnection)
  return websocketServerHandle(server, http)
}

async function createHangingTcpServer() {
  const sockets = new Set<Socket>()
  let connections = 0
  const server = net.createServer((socket) => {
    connections += 1
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    wsUrl: `ws://127.0.0.1:${address.port}/v1/responses`,
    connections: () => connections,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

async function createRejectingWebSocketServer(onAttempt: () => void) {
  const http = await createHttpServer()
  const server = new WebSocketServer({
    server: http.server,
    verifyClient(_info, callback) {
      onAttempt()
      callback(false, 401, "denied")
    },
  })
  return websocketServerHandle(server, http)
}

async function createHttpServer(handle?: (request: IncomingMessage, response: ServerResponse) => void) {
  const httpRequests: IncomingMessage[] = []
  const server = createServer((request, response) => {
    httpRequests.push(request)
    if (handle) return handle(request, response)
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("http")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return {
    server,
    httpRequests,
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    async [Symbol.asyncDispose]() {
      await closeHttpServer(server)
    },
  }
}

function websocketServerHandle(server: WebSocketServer, http: Awaited<ReturnType<typeof createHttpServer>>) {
  return {
    url: http.url,
    wsUrl: http.url.replace(/^http/, "ws"),
    httpRequests: http.httpRequests,
    async [Symbol.asyncDispose]() {
      for (const socket of server.clients) socket.terminate()
      server.close()
      http.server.close()
    },
  }
}

function closeHttpServer(server: HttpServer) {
  // Bun may stop listening while closing aborted HTTP connections.
  server.closeAllConnections()
  return new Promise<void>((resolve, reject) => {
    server.close((error: NodeJS.ErrnoException | undefined) =>
      error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve(),
    )
  })
}

async function waitFor(predicate: () => boolean, message: string) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

test.each([
  "{broken",
  JSON.stringify({ model: "private prompt with spaces", reasoning: { effort: "private-effort" } }),
])("transport diagnostics ignore invalid routing fields in %s", (body) => {
  const events: OpenAITransport.Diagnostic[] = []
  OpenAITransport.createTrace({ transport: "http", headers: {}, body, report: (event) => events.push(event) })(
    "selected",
  )
  expect(events[0].model).toBeUndefined()
  expect(events[0].reasoningEffort).toBeUndefined()
  expect(JSON.stringify(events)).not.toContain("private")
})

test("HTTP diagnostics capture only bounded serialized routing and patch mode", () => {
  const events: OpenAITransport.Diagnostic[] = []
  OpenAITransport.createTrace({
    transport: "http",
    headers: {},
    body: JSON.stringify({ model: "gpt-6.1-sol", reasoning: { effort: "low" }, input: "private-prompt" }),
    report: (event) => events.push(event),
  })("selected")
  expect(events[0]).toMatchObject({ model: "gpt-6.1-sol", reasoningEffort: "low", patchToolType: "absent" })
  expect(JSON.stringify(events)).not.toContain("private-prompt")
})

test("transport diagnostics distinguish patch protocols without retaining tool contents", () => {
  const cases: { tools: unknown; expected: OpenAITransport.Diagnostic["patchToolType"] }[] = [
    { tools: undefined, expected: "absent" },
    { tools: [], expected: "absent" },
    { tools: [{ type: "function", name: "other-private-tool" }], expected: "absent" },
    { tools: [{ type: "function", name: "apply_patch", parameters: { private: "schema" } }], expected: "function" },
    { tools: [{ type: "custom", name: "apply_patch", description: "private-description" }], expected: "custom" },
    { tools: [{ type: "apply_patch" }], expected: "other" },
    { tools: [{ type: "private-type", name: "apply_patch" }], expected: "other" },
    {
      tools: [
        { type: "custom", name: "apply_patch" },
        { type: "function", name: "apply_patch" },
      ],
      expected: "other",
    },
    { tools: { private: "invalid-tools" }, expected: "other" },
  ]
  for (const item of cases) {
    const events: OpenAITransport.Diagnostic[] = []
    OpenAITransport.createTrace({
      transport: "http",
      headers: {},
      body: JSON.stringify({ tools: item.tools }),
      report: (event) => events.push(event),
    })("selected")
    expect(events[0].patchToolType).toBe(item.expected)
    expect(JSON.stringify(events)).not.toContain("private")
    expect(events[0]).not.toHaveProperty("tools")
  }
})
