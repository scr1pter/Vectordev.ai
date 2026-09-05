import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Queue, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { Authorization, authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const credential = (username: string, password: string) => ({ username, password: Redacted.make(password) })

describe("ServerAuth guest credentials", () => {
  const config = {
    password: Option.some("owner-secret"),
    username: "alice",
    guestPassword: Option.some("guest-secret"),
    guestUsername: "guest",
  }

  test("identity reports which pair matched", () => {
    expect(ServerAuth.identity(credential("alice", "owner-secret"), config)).toBe("owner")
    expect(ServerAuth.identity(credential("guest", "guest-secret"), config)).toBe("guest")
    expect(ServerAuth.identity(credential("guest", "owner-secret"), config)).toBeUndefined()
    expect(ServerAuth.identity(credential("alice", "guest-secret"), config)).toBeUndefined()
    expect(ServerAuth.identity(credential("mallory", "guest-secret"), config)).toBeUndefined()
    expect(ServerAuth.authorized(credential("guest", "guest-secret"), config)).toBe(true)
  })

  test("owner-only configs never admit a guest", () => {
    const ownerOnly = { password: Option.some("owner-secret"), username: "alice" }
    expect(ServerAuth.authorized(credential("alice", "owner-secret"), ownerOnly)).toBe(true)
    expect(ServerAuth.authorized(credential("guest", "guest-secret"), ownerOnly)).toBe(false)
    expect(ServerAuth.authorized(credential("guest", ""), ownerOnly)).toBe(false)
    expect(ServerAuth.authorized(credential("guest", ""), { ...ownerOnly, guestPassword: Option.some("") })).toBe(false)
  })

  test("guest username defaults to guest and is configurable", () => {
    expect(ServerAuth.identity(credential("guest", "guest-secret"), { ...config, guestUsername: undefined })).toBe(
      "guest",
    )
    expect(
      ServerAuth.identity(credential("guest", "guest-secret"), { ...config, guestUsername: "pair" }),
    ).toBeUndefined()
    expect(ServerAuth.identity(credential("pair", "guest-secret"), { ...config, guestUsername: "pair" })).toBe("guest")
  })

  test("a guest password alone does not make auth required", () => {
    expect(ServerAuth.required({ ...config, password: Option.none() })).toBe(false)
    expect(ServerAuth.required(config)).toBe(true)
  })
})

const Api = HttpApi.make("test-guest-authorization").add(
  HttpApiGroup.make("test")
    .add(HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }))
    .middleware(Authorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) => handlers.handle("probe", () => Effect.succeed("ok")))

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const guestLayer = ServerAuth.Config.configLayer({
  password: Option.some("owner-secret"),
  username: "opencode",
  guestPassword: Option.some("guest-secret"),
  guestUsername: "guest",
})
const ownerOnlyLayer = ServerAuth.Config.configLayer({ password: Option.some("owner-secret"), username: "opencode" })

const itGuest = testEffect(apiLayer.pipe(Layer.provide(guestLayer)))
const itOwnerOnly = testEffect(apiLayer.pipe(Layer.provide(ownerOnlyLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")
const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi authorization middleware with a guest pair", () => {
  itGuest.live("accepts either credential pair and nothing else", () =>
    Effect.gen(function* () {
      const [owner, guest, missing, swapped, wrong] = yield* Effect.all(
        [
          getProbe({ authorization: basic("opencode", "owner-secret") }),
          getProbe({ authorization: basic("guest", "guest-secret") }),
          getProbe(),
          getProbe({ authorization: basic("opencode", "guest-secret") }),
          getProbe({ authorization: basic("guest", "owner-secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(owner.status).toBe(200)
      expect(guest.status).toBe(200)
      expect(missing.status).toBe(401)
      expect(swapped.status).toBe(401)
      expect(wrong.status).toBe(401)
      expect(wrong.headers["www-authenticate"] ?? "").toContain("Basic")
    }),
  )

  itGuest.live("accepts the guest pair as an invite-link auth token", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("guest", "guest-secret"))}`)

      expect(response.status).toBe(200)
    }),
  )

  itOwnerOnly.live("rejects guest credentials when no guest password is configured", () =>
    Effect.gen(function* () {
      const [owner, guest] = yield* Effect.all(
        [
          getProbe({ authorization: basic("opencode", "owner-secret") }),
          getProbe({ authorization: basic("guest", "guest-secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(owner.status).toBe(200)
      expect(guest.status).toBe(401)
    }),
  )
})

// Presence on the directory event stream. The test server has no password, so
// the username comes straight from whatever credential the client presents.
const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})
type EventData = typeof EventData.Type

// SSE frames can share a chunk, so buffer and split on the blank line between events.
function frames(buffer: { pending: string }, chunk: string) {
  buffer.pending += chunk
  const parts = buffer.pending.split("\n\n")
  buffer.pending = parts.pop() ?? ""
  return parts.flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    return data ? [Schema.decodeUnknownSync(EventData)(JSON.parse(data))] : []
  })
}

const openEventStream = (directory: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory, { headers })
    const events = yield* Queue.unbounded<EventData>()
    const buffer = { pending: "" }
    const decoder = new TextDecoder()
    yield* response.stream.pipe(
      Stream.runForEach((chunk) => Queue.offerAll(events, frames(buffer, decoder.decode(chunk, { stream: true })))),
      Effect.forkScoped,
    )
    return { response, events }
  })

// A stream we can actually hang up on: the Effect test client keeps the socket
// open when its reader is interrupted, whereas aborting a fetch closes it, which
// is what the server needs to observe a departure.
const openAbortableEventStream = (directory: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const address = (yield* HttpServer.HttpServer).address
    if (address._tag !== "TcpAddress") return yield* Effect.die(new Error("expected a tcp test server"))
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
    const response = yield* Effect.promise(() =>
      fetch(`http://localhost:${address.port}${EventPaths.event}`, {
        headers: { ...headers, "x-opencode-directory": directory },
        signal: controller.signal,
      }),
    )
    expect(response.status).toBe(200)
    const events = yield* Queue.unbounded<EventData>()
    const buffer = { pending: "" }
    const decoder = new TextDecoder()
    yield* Effect.promise(async () => {
      const reader = response.body?.getReader()
      if (!reader) return
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) return
          for (const event of frames(buffer, decoder.decode(value, { stream: true }))) Queue.offerUnsafe(events, event)
        }
      } catch {
        // aborted on purpose
      }
    }).pipe(Effect.forkScoped)
    return { events, close: () => controller.abort() }
  })

const next = (events: Queue.Dequeue<EventData>, type: string) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error(`timed out waiting for ${type}`)),
        }),
      )
      if (event.type === type) return event
    }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event stream presence", () => {
  it.instance(
    "announces guests to peers and replays the roster to newcomers",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance

        const owner = yield* openEventStream(directory, { authorization: basic("opencode", "anything") })
        expect(yield* next(owner.events, "server.connected")).toMatchObject({ type: "server.connected" })

        const guest = yield* openAbortableEventStream(directory, { authorization: basic("guest", "guest-secret") })

        // The owner learns about the guest; the guest is not told about itself.
        const joined = yield* next(owner.events, "client.joined")
        expect(joined.properties.username).toBe("guest")
        expect(typeof joined.properties.clientID).toBe("string")
        expect(typeof joined.properties.at).toBe("number")

        // The guest's stream opens with the roster of peers already connected.
        expect(yield* next(guest.events, "server.connected")).toMatchObject({ type: "server.connected" })
        const peer = yield* next(guest.events, "client.joined")
        expect(peer.properties.username).toBe("opencode")
        expect(peer.properties.clientID).not.toBe(joined.properties.clientID)

        // Hanging up tells the owner the guest left.
        guest.close()
        const left = yield* next(owner.events, "client.left")
        expect(left.properties.clientID).toBe(joined.properties.clientID)
        expect(left.properties.username).toBe("guest")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )
})
