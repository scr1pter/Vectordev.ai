import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { WebFetchRequest } from "../../src/util/webfetch-request"

function fixture(reply: (index: number) => Response) {
  const requests: Array<{ url: string; agent: string | null; accept: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        url: request.url,
        agent: request.headers.get("user-agent"),
        accept: request.headers.get("accept"),
      })
      return reply(requests.length)
    },
  })
  return { requests, url: server.url.toString(), [Symbol.dispose]: () => server.stop(true) }
}
const execute = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* WebFetchRequest.execute(
      client,
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("Accept", "text/plain")),
    )
    return yield* response.text
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))

test("a challenge with an unfinished body is aborted before one successful retry", async () => {
  using sample = fixture((index) =>
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
  expect(await Effect.runPromise(execute(sample.url).pipe(Effect.timeout("2 seconds")))).toBe("restored")
  expect(sample.requests).toHaveLength(2)
  expect(sample.requests[0]?.agent).toMatch(/^Mozilla\/.* Vector\//)
  expect(sample.requests[1]?.agent).toMatch(/^Vector\//)
  expect(sample.requests.every((value) => value.url === sample.url && value.accept === "text/plain")).toBe(true)
})

test.each([401, 403, 404, 500])("ordinary HTTP %s failures are not retried", async (status) => {
  using sample = fixture(() => new Response("denied", { status }))
  expect(Exit.isFailure(await Effect.runPromiseExit(execute(sample.url)))).toBe(true)
  expect(sample.requests).toHaveLength(1)
})

test("repeated challenges stop after two requests", async () => {
  using sample = fixture(() => new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }))
  expect(Exit.isFailure(await Effect.runPromiseExit(execute(sample.url)))).toBe(true)
  expect(sample.requests).toHaveLength(2)
})

test("a stalled retry remains inside the caller's deadline", async () => {
  using sample = fixture((index) =>
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
  expect(Exit.isFailure(await Effect.runPromiseExit(execute(sample.url).pipe(Effect.timeout("100 millis"))))).toBe(true)
  expect(sample.requests).toHaveLength(2)
})
