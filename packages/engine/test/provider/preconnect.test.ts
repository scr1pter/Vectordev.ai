import { afterEach, expect } from "bun:test"
import { createServer } from "node:net"
import { streamText } from "ai"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

// Bun 1.3.14 exposes fetch.preconnect on Windows, but its native implementation only supports POSIX.
// https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/bun_core/feature_flags.zig#L119-L120
const supportsPreconnect = process.platform !== "win32"

it.live("reuses a speculative connection when supported and serves the first request on every platform", () =>
  Effect.gen(function* () {
    const server = yield* endpoint()
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("test-model"))

          yield* provider.preconnect(model)
          if (supportsPreconnect) yield* until(() => server.connections === 1)
          expect(server.connections).toBe(supportsPreconnect ? 1 : 0)
          // Opening the connection sends nothing.
          expect(server.requests).toBe(0)

          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })
          expect(yield* Effect.promise(() => result.text)).toBe("ok")
          expect(server.requests).toBe(1)
          expect(server.connections).toBe(1)
        }),
      { trusted: true, config: testProviderConfig(server.url) },
    )
  }),
)

it.live("uses a plugin's speculative endpoint when supported without changing actual SDK requests", () =>
  Effect.gen(function* () {
    const sdk = yield* endpoint()
    const named = yield* endpoint()
    const config = testProviderConfig(sdk.url)
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("test-model"))

          yield* provider.preconnect(model)
          if (supportsPreconnect) yield* until(() => named.connections === 1)
          expect(named.connections).toBe(supportsPreconnect ? 1 : 0)
          expect(sdk.connections).toBe(0)

          // The option is Vector's own and never reaches the SDK, whose requests still go to its endpoint.
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })
          expect(yield* Effect.promise(() => result.text)).toBe("ok")
          expect(sdk.requests).toBe(1)
          expect(named.requests).toBe(0)
        }),
      {
        trusted: true,
        config: {
          ...config,
          provider: {
            lmstudio: {
              ...config.provider.lmstudio,
              options: { ...config.provider.lmstudio.options, preconnect: named.url },
            },
          },
        },
      },
    )
  }),
)

it.live("a rejected speculative connection does not prevent the actual provider request", () =>
  Effect.gen(function* () {
    const server = yield* endpoint()
    const config = testProviderConfig(server.url)
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("test-model"))
          yield* provider.preconnect(model)
          expect(server.requests).toBe(0)

          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })
          expect(yield* Effect.promise(() => result.text)).toBe("ok")
          expect(server.requests).toBe(1)
        }),
      {
        trusted: true,
        config: {
          ...config,
          provider: {
            lmstudio: {
              ...config.provider.lmstudio,
              // URL accepts port zero, but Bun's speculative connection rejects it synchronously.
              options: { ...config.provider.lmstudio.options, preconnect: "http://127.0.0.1:0" },
            },
          },
        },
      },
    )
  }),
)

// An OpenAI-compatible endpoint that counts the TCP connections opened to it and the requests sent over them. It sits
// on a plain socket server because an HTTP server reports a connection only once a request arrives on it.
const endpoint = () =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const state = { connections: 0, requests: 0, url: "" }
      const body = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
      const server = createServer((socket) => {
        state.connections++
        let buffer = Buffer.alloc(0)
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk])
          while (true) {
            const end = buffer.indexOf("\r\n\r\n")
            if (end === -1) return
            const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1] ?? 0)
            if (buffer.length < end + 4 + length) return
            buffer = buffer.subarray(end + 4 + length)
            state.requests++
            socket.write(
              `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            )
          }
        })
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
      state.url = `http://127.0.0.1:${address.port}/v1`
      return { state, server }
    }),
    (input) => Effect.sync(() => input.server.close()),
  ).pipe(Effect.map((input) => input.state))

const until = (done: () => boolean) =>
  Effect.gen(function* () {
    const stop = Date.now() + 5_000
    while (!done()) {
      if (Date.now() > stop) return yield* Effect.die(new Error("timed out waiting for the connection"))
      yield* Effect.sleep("10 millis")
    }
  })
