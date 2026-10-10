import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { WebFetchRequest } from "../../src/util/webfetch-request"

function fixture(reply: (index: number) => Response) {
  const requests: Array<{ url: string; agent: string | null; accept: string | null }> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({
        url: request.url,
        agent: request.headers["user-agent"] ?? null,
        accept: request.headers.accept ?? null,
      })
      return HttpClientResponse.fromWeb(request, reply(requests.length))
    }),
  )
  return { client, requests, url: "https://1.1.1.1/" }
}
const execute = (client: HttpClient.HttpClient, url: string, options?: WebFetchRequest.Options) =>
  Effect.gen(function* () {
    const response = yield* WebFetchRequest.execute(
      client,
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("Accept", "text/plain")),
      options,
    )
    return yield* response.text
  }).pipe(Effect.scoped)

test("authorization happens before DNS resolution", async () => {
  const sample = fixture(() => new Response("unexpected"))
  let authorizations = 0
  const error = await Effect.runPromise(
    Effect.flip(
      execute(sample.client, "https://permission-denied-before-dns.invalid/", {
        authorize: () => {
          authorizations++
          return Effect.fail(new Error("permission denied before DNS"))
        },
      }),
    ),
  )
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected authorization error")
  expect(error.message).toBe("permission denied before DNS")
  expect(authorizations).toBe(1)
  expect(sample.requests).toHaveLength(0)
})

test("rejects a private address returned by DNS", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      WebFetchRequest.resolvePublicDestination("https://rebinding.example/", () =>
        Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      ),
    ),
  )
  expect(error.message).toBe("Private network destinations are not allowed")
})

test("rejects URL credentials", async () => {
  const error = await Effect.runPromise(
    Effect.flip(WebFetchRequest.resolvePublicDestination("https://user:secret@example.com/")),
  )
  expect(error.message).toBe("URL credentials are not allowed")
})

test("the real transport connects only to the pinned address", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new Response(request.headers.get("host")),
  })
  try {
    const response = await WebFetchRequest.pinnedFetch(["127.0.0.1"])(
      `http://dns-must-not-resolve.invalid:${server.port}/`,
    )
    expect(await response.text()).toBe(`dns-must-not-resolve.invalid:${server.port}`)
  } finally {
    await server.stop(true)
  }
})

test("a challenge with an unfinished body is aborted before one successful retry", async () => {
  const sample = fixture((index) =>
    index === 1
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("challenge"))
            },
          }),
          { status: 403, headers: { "cf-mitigated": "challenge" } },
        )
      : new Response("restored"),
  )
  expect(await Effect.runPromise(execute(sample.client, sample.url).pipe(Effect.timeout("2 seconds")))).toBe("restored")
  expect(sample.requests).toHaveLength(2)
  expect(sample.requests[0]?.agent).toMatch(/^Mozilla\/.* Vector\//)
  expect(sample.requests[1]?.agent).toMatch(/^Vector\//)
  expect(sample.requests.every((value) => value.url === sample.url && value.accept === "text/plain")).toBe(true)
})

test.each([401, 403, 404, 500])("ordinary HTTP %s failures are not retried", async (status) => {
  const sample = fixture(() => new Response("denied", { status }))
  expect(Exit.isFailure(await Effect.runPromiseExit(execute(sample.client, sample.url)))).toBe(true)
  expect(sample.requests).toHaveLength(1)
})

test("repeated challenges stop after two requests", async () => {
  const sample = fixture(() => new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }))
  expect(Exit.isFailure(await Effect.runPromiseExit(execute(sample.client, sample.url)))).toBe(true)
  expect(sample.requests).toHaveLength(2)
})

test("a stalled retry remains inside the caller's deadline", async () => {
  const sample = fixture((index) =>
    index === 1
      ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"))
            },
          }),
        ),
  )
  expect(
    Exit.isFailure(await Effect.runPromiseExit(execute(sample.client, sample.url).pipe(Effect.timeout("100 millis")))),
  ).toBe(true)
  expect(sample.requests).toHaveLength(2)
})

test("a private destination is reached only through authorizePrivate", async () => {
  const sample = fixture(() => new Response("local"))
  const url = "http://127.0.0.1:3000/"
  const refused = await Effect.runPromise(Effect.flip(execute(sample.client, url, { authorize: () => Effect.void })))
  expect(refused).toBeInstanceOf(Error)
  expect(refused instanceof Error ? refused.message : "").toBe("Private network destinations are not allowed")
  expect(sample.requests).toHaveLength(0)

  const approved: string[] = []
  const body = await Effect.runPromise(
    execute(sample.client, url, {
      authorize: () => Effect.void,
      authorizePrivate: (target) => Effect.sync(() => approved.push(target)),
    }),
  )
  expect(body).toBe("local")
  expect(approved).toEqual([url])
  expect(sample.requests.map((request) => request.url)).toEqual([url])
})

test("a public destination never asks for private network approval", async () => {
  const sample = fixture(() => new Response("public"))
  const body = await Effect.runPromise(
    execute(sample.client, sample.url, {
      authorize: () => Effect.void,
      authorizePrivate: () => Effect.fail(new Error("unexpected private approval")),
    }),
  )
  expect(body).toBe("public")
})
