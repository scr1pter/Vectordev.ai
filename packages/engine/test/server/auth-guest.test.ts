import { NodeHttpServer } from "@effect/platform-node"
import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Queue, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { Authorization, authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { allowsSession, allowsWorkspace, RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { Server } from "../../src/server/server"
import { Flag } from "@vectordevai/core/flag/flag"
import { SessionV2 } from "@vectordevai/core/session"

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

  test("a guest password alone still enforces authentication, admitting guests only", () => {
    const guestOnly = { ...config, password: Option.none() }
    // Configuring any password must switch authentication on. Treating a
    // guest-only server as unauthenticated would serve the workspace to anyone.
    expect(ServerAuth.required(guestOnly)).toBe(true)
    expect(ServerAuth.identity(credential("guest", "guest-secret"), guestOnly)).toBe("guest")
    expect(ServerAuth.identity(credential("vector", "owner-secret"), guestOnly)).toBeUndefined()
    expect(ServerAuth.identity(credential("vector", ""), { ...guestOnly, password: Option.some("") })).toBeUndefined()
    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.required({ ...config, password: Option.none(), guestPassword: Option.none() })).toBe(false)
    expect(ServerAuth.required({ ...config, password: Option.none(), guestPassword: Option.some("") })).toBe(false)
  })

  test("guest principals carry only configured workspace and session claims", () => {
    const principal = ServerAuth.principal("guest", {
      ...config,
      guestWorkspaceIDs: ["wrk_allowed"],
      guestWorkspaceDirectories: { wrk_allowed: process.cwd() },
      guestSessionIDs: ["ses_allowed"],
    })
    expect(allowsWorkspace(principal, "wrk_allowed")).toBe(true)
    expect(allowsWorkspace(principal, "wrk_other")).toBe(false)
    expect(principal.kind === "guest" && principal.workspaceDirectories.get("wrk_allowed")).toBe(process.cwd())
    expect(allowsSession(principal, "ses_allowed")).toBe(true)
    expect(allowsSession(principal, "ses_other")).toBe(false)
    expect(allowsWorkspace(ServerAuth.principal("owner", config), "wrk_other")).toBe(true)
  })
})

const Api = HttpApi.make("test-guest-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }),
      HttpApiEndpoint.get("principal", "/principal", { success: Schema.String }),
      HttpApiEndpoint.get("owner", "/api/pty", { success: Schema.String }),
    )
    .middleware(Authorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("principal", () => RequestPrincipal.pipe(Effect.map((principal) => principal.username)))
    .handle("owner", () => Effect.succeed("owner")),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const guestLayer = ServerAuth.Config.configLayer({
  password: Option.some("owner-secret"),
  username: "vector",
  guestPassword: Option.some("guest-secret"),
  guestUsername: "guest",
})
const ownerOnlyLayer = ServerAuth.Config.configLayer({ password: Option.some("owner-secret"), username: "vector" })

const itGuest = testEffect(apiLayer.pipe(Layer.provide(guestLayer)))
const itOwnerOnly = testEffect(apiLayer.pipe(Layer.provide(ownerOnlyLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")

async function* vectorEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }
      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield JSON.parse(data.join("\n")) as Record<string, unknown>
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
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
          getProbe({ authorization: basic("vector", "owner-secret") }),
          getProbe({ authorization: basic("guest", "guest-secret") }),
          getProbe(),
          getProbe({ authorization: basic("vector", "guest-secret") }),
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

  itGuest.live("enforces the owner and guest endpoint matrix", () =>
    Effect.gen(function* () {
      const [owner, guest] = yield* Effect.all([
        HttpClientRequest.get("/api/pty").pipe(
          HttpClientRequest.setHeader("authorization", basic("vector", "owner-secret")),
          HttpClient.execute,
        ),
        HttpClientRequest.get("/api/pty").pipe(
          HttpClientRequest.setHeader("authorization", basic("guest", "guest-secret")),
          HttpClient.execute,
        ),
      ])
      expect(owner.status).toBe(200)
      expect(guest.status).toBe(403)
    }),
  )

  itGuest.live("rejects encoded owner-only routes before decoded routing", () =>
    Effect.gen(function* () {
      const [encoded, doubleEncoded] = yield* Effect.all(
        ["/api/%70ty", "/api/%2570ty"].map((route) =>
          HttpClientRequest.get(route).pipe(
            HttpClientRequest.setHeader("authorization", basic("guest", "guest-secret")),
            HttpClient.execute,
          ),
        ),
      )

      expect(encoded.status).toBe(403)
      expect(doubleEncoded.status).not.toBe(200)
    }),
  )

  itGuest.live("provides the authenticated request principal to handlers", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/principal").pipe(
        HttpClientRequest.setHeader("authorization", basic("guest", "guest-secret")),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("guest")
    }),
  )

  itGuest.live("rejects the guest pair as a reusable query credential", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("guest", "guest-secret"))}`)

      expect(response.status).toBe(401)
    }),
  )

  itOwnerOnly.live("rejects guest credentials when no guest password is configured", () =>
    Effect.gen(function* () {
      const [owner, guest] = yield* Effect.all(
        [
          getProbe({ authorization: basic("vector", "owner-secret") }),
          getProbe({ authorization: basic("guest", "guest-secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(owner.status).toBe(200)
      expect(guest.status).toBe(401)
    }),
  )
})

test("guest session lists and replay routes stay within canonical claims", async () => {
  await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
  await using other = await tmpdir({ config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_SERVER_GUEST_SESSIONS",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const claimedID = SessionV2.ID.create()
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_SERVER_GUEST_SESSIONS: claimedID,
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret") }
  const create = async (workspaceID: string, directory = tmp.path, id?: SessionV2.ID) => {
    const response = await fetch(new URL("/api/session", listener.url), {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ id, location: { directory, workspaceID } }),
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: { id: string } }).data.id
  }
  let events: AsyncGenerator<Record<string, unknown>> | undefined
  try {
    const eventResponse = await fetch(new URL("/api/event", listener.url), { headers: guest })
    expect(eventResponse.status).toBe(200)
    events = vectorEvents(eventResponse.body!)
    expect((await events.next()).value).toMatchObject({ type: "server.connected" })

    const denied = await create("wrk_denied")
    const allowed = await create("wrk_allowed")
    const escaped = await create("wrk_allowed", other.path)
    const claimed = await create("wrk_allowed", other.path, claimedID)
    expect(claimed).toBe(claimedID)
    expect((await events.next()).value).toMatchObject({ location: { workspaceID: "wrk_allowed" } })
    const list = await fetch(new URL("/api/session", listener.url), { headers: guest })
    expect(list.status).toBe(200)
    const ids = ((await list.json()) as { data: Array<{ id: string }> }).data.map((item) => item.id)
    expect(ids).toContain(allowed)
    expect(ids).toContain(claimed)
    expect(ids).not.toContain(denied)
    expect(ids).not.toContain(escaped)

    expect((await fetch(new URL(`/api/session/${allowed}`, listener.url), { headers: guest })).status).toBe(200)
    expect((await fetch(new URL(`/api/session/${denied}`, listener.url), { headers: guest })).status).toBe(403)
    expect((await fetch(new URL(`/api/session/${escaped}`, listener.url), { headers: guest })).status).toBe(403)
    expect((await fetch(new URL(`/api/session/${allowed}/history`, listener.url), { headers: guest })).status).toBe(200)
    expect((await fetch(new URL(`/api/session/${denied}/history`, listener.url), { headers: guest })).status).toBe(403)

    expect((await fetch(new URL(`/api/session/${denied}/event`, listener.url), { headers: guest })).status).toBe(403)

    await events.return(undefined)
    events = undefined
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"

    const legacyList = await fetch(new URL("/session", listener.url), { headers: guest })
    expect(legacyList.status).toBe(200)
    const legacyIDs = ((await legacyList.json()) as Array<{ id: string }>).map((item) => item.id)
    expect(legacyIDs).toContain(allowed)
    expect(legacyIDs).toContain(claimed)
    expect(legacyIDs).not.toContain(escaped)

    const selectedList = await fetch(new URL(`/session?directory=${encodeURIComponent(other.path)}`, listener.url), {
      headers: guest,
    })
    expect(selectedList.status).toBe(200)
    const selectedIDs = ((await selectedList.json()) as Array<{ id: string }>).map((item) => item.id)
    expect(selectedIDs).toContain(allowed)
    expect(selectedIDs).not.toContain(escaped)

    const status = await fetch(new URL("/session/status", listener.url), { headers: guest })
    expect(status.status).toBe(200)
    expect(await status.json()).not.toHaveProperty(escaped)

    const allowedRead = await fetch(
      new URL(`/session/${allowed}?directory=${encodeURIComponent(other.path)}`, listener.url),
      { headers: guest },
    )
    expect(allowedRead.status).toBe(200)
    expect(((await allowedRead.json()) as { directory: string }).directory).toBe(tmp.path)
    expect(
      (
        await fetch(new URL(`/session/${escaped}?directory=${encodeURIComponent(other.path)}`, listener.url), {
          headers: guest,
        })
      ).status,
    ).toBe(403)
    const claimedRead = await fetch(
      new URL(`/session/${claimed}?directory=${encodeURIComponent(tmp.path)}`, listener.url),
      { headers: guest },
    )
    expect(claimedRead.status).toBe(200)
    expect(((await claimedRead.json()) as { directory: string }).directory).toBe(other.path)

    const deniedMutation = await fetch(new URL(`/session/${escaped}`, listener.url), {
      method: "PATCH",
      headers: { ...guest, "content-type": "application/json" },
      body: JSON.stringify({ title: "guest-must-not-write" }),
    })
    expect(deniedMutation.status).toBe(403)
    const allowedMutation = await fetch(new URL(`/session/${allowed}`, listener.url), {
      method: "PATCH",
      headers: { ...guest, "content-type": "application/json" },
      body: JSON.stringify({ title: "guest-can-write" }),
    })
    expect(allowedMutation.status).toBe(200)
    const ownerRead = await fetch(new URL(`/session/${escaped}`, listener.url), { headers: owner })
    expect(ownerRead.status).toBe(200)
    expect(((await ownerRead.json()) as { title: string }).title).not.toBe("guest-must-not-write")

    const claimedMutation = await fetch(new URL(`/session/${claimed}`, listener.url), {
      method: "PATCH",
      headers: { ...guest, "content-type": "application/json" },
      body: JSON.stringify({ title: "explicit-session-claim" }),
    })
    expect(claimedMutation.status).toBe(200)
    expect((await claimedMutation.json()) as { directory: string; title: string }).toMatchObject({
      directory: other.path,
      title: "explicit-session-claim",
    })
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await events?.return(undefined)
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("guests cannot run host commands or answer permission requests", async () => {
  await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
  await using outside = await tmpdir()
  const secret = path.join(outside.path, "host-secret.bin")
  await fs.writeFile(secret, "HOST-ONLY-SECRET-VALUE")
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  // Server.listen prefers port 4096, so this listener reuses the earlier test's port. A pooled keep-alive
  // socket left from that server would swallow the first request.
  const call = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, keepalive: false })
  const at = (route: string) => new URL(`${route}?directory=${encodeURIComponent(tmp.path)}`, listener.url)
  const model = { providerID: "probe", modelID: "probe" }
  // A binary file part outside the workspace parks its session on an external_directory request.
  const askOutside = (sessionID: string, headers: Record<string, string>) =>
    call(at(`/session/${sessionID}/prompt_async`), {
      method: "POST",
      headers,
      body: JSON.stringify({
        noReply: true,
        model,
        parts: [{ type: "file", mime: "application/octet-stream", filename: "x.bin", url: `file://${secret}` }],
      }),
    })
  const pending = async (headers: Record<string, string>) =>
    (await (await call(at("/permission"), { headers })).json()) as Array<{ id: string; sessionID: string }>
  try {
    // The owner's own session in the same directory, outside the guest's workspace claim.
    const ownerSession = (await (
      await call(at("/session"), { method: "POST", headers: owner, body: "{}" })
    ).json()) as {
      id: string
    }
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    const created = await call(at("/session"), { method: "POST", headers: guest, body: "{}" })
    expect(created.status).toBe(200)
    const guestSession = (await created.json()) as { id: string }

    const shell = await call(at(`/session/${guestSession.id}/shell`), {
      method: "POST",
      headers: guest,
      body: JSON.stringify({ agent: "build", model, command: `cat ${secret}; id -un` }),
    })
    expect(shell.status).toBe(403)
    expect(await shell.text()).not.toContain("HOST-ONLY-SECRET-VALUE")
    const command = await call(at(`/session/${guestSession.id}/command`), {
      method: "POST",
      headers: guest,
      body: JSON.stringify({ command: "init", arguments: "" }),
    })
    expect(command.status).toBe(403)

    expect((await askOutside(ownerSession.id, owner)).status).toBe(204)
    expect((await askOutside(guestSession.id, guest)).status).toBe(204)
    const deadline = Date.now() + 15_000
    while ((await pending(owner)).length < 2 && Date.now() < deadline) await Bun.sleep(50)
    const all = await pending(owner)
    expect(all.map((item) => item.sessionID).sort()).toEqual([ownerSession.id, guestSession.id].sort())

    // A guest sees what its own session waits on, never the owner's requests.
    expect((await pending(guest)).map((item) => item.sessionID)).toEqual([guestSession.id])
    expect((await call(new URL("/api/permission/request", listener.url), { headers: guest })).status).toBe(403)

    // Approving crosses the workspace boundary, so it stays with the owner even for the guest's session.
    for (const item of all) {
      const reply = await call(at(`/permission/${item.id}/reply`), {
        method: "POST",
        headers: guest,
        body: JSON.stringify({ reply: "always" }),
      })
      expect(reply.status).toBe(403)
      const legacy = await call(at(`/session/${item.sessionID}/permissions/${item.id}`), {
        method: "POST",
        headers: guest,
        body: JSON.stringify({ response: "always" }),
      })
      expect(legacy.status).toBe(403)
    }
    expect((await pending(owner)).length).toBe(2)
    for (const item of all) {
      const reply = await call(at(`/permission/${item.id}/reply`), {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ reply: "reject" }),
      })
      expect(reply.status).toBe(200)
    }

    const messages = await (await call(at(`/session/${guestSession.id}/message`), { headers: guest })).text()
    expect(messages).not.toContain(Buffer.from("HOST-ONLY-SECRET-VALUE").toString("base64"))
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

// Presence on the directory event stream. This test server has no password,
// so every connection has the default owner principal regardless of headers.
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
        headers: { ...headers, "x-vector-directory": directory },
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
    "announces peers and replays the roster to newcomers",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance

        const owner = yield* openEventStream(directory, { authorization: basic("vector", "anything") })
        expect(yield* next(owner.events, "server.connected")).toMatchObject({ type: "server.connected" })

        const guest = yield* openAbortableEventStream(directory, { authorization: basic("guest", "guest-secret") })

        // The existing connection learns about the newcomer, which is not told about itself.
        const joined = yield* next(owner.events, "client.joined")
        expect(joined.properties.username).toBe("vector")
        expect(typeof joined.properties.clientID).toBe("string")
        expect(typeof joined.properties.at).toBe("number")

        // The new stream opens with the roster of peers already connected.
        expect(yield* next(guest.events, "server.connected")).toMatchObject({ type: "server.connected" })
        const peer = yield* next(guest.events, "client.joined")
        expect(peer.properties.username).toBe("vector")
        expect(peer.properties.clientID).not.toBe(joined.properties.clientID)

        // Hanging up tells the existing peer that the newcomer left.
        guest.close()
        const left = yield* next(owner.events, "client.left")
        expect(left.properties.clientID).toBe(joined.properties.clientID)
        expect(left.properties.username).toBe("vector")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )
})
