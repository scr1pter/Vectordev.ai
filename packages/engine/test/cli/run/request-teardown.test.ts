import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

for (const rejected of [true, false]) {
  cliIt.live(
    rejected
      ? "a rejected request does not report its stream teardown as another failure"
      : "an accepted request still fails when its unfinished event stream disconnects",
    ({ vector, home }) =>
      Effect.gen(function* () {
        const stream = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
        const requests: string[] = []
        const error = { name: "UnknownError", data: { message: "Rejected command fixture" } }
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              idleTimeout: 0,
              async fetch(request) {
                const pathname = new URL(request.url).pathname
                requests.push(pathname)
                if (pathname === "/config/providers")
                  return Response.json({
                    providers: [{ id: "lmstudio", models: { "test-model": {} } }],
                    default: { lmstudio: "test-model" },
                    unavailable: [],
                  })
                if (pathname === "/session")
                  return Response.json({ id: "session-fixture", title: "Fixture", directory: home })
                if (pathname === "/session/session-fixture/share")
                  return Response.json({
                    id: "a".repeat(32),
                    url: `https://vectordev.ai/s/${"a".repeat(32)}`,
                    expiresAt: Date.now() + 60_000,
                    updatedAt: Date.now(),
                    revision: 0,
                    updates: true,
                  })
                if (pathname === "/event")
                  return new Response(
                    new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(new TextEncoder().encode(": connected\n\n"))
                        stream.resolve(controller)
                      },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                  )
                if (pathname === "/session/session-fixture/command") {
                  if (!rejected) (await stream.promise).close()
                  return Response.json(rejected ? error : {}, { status: rejected ? 400 : 200 })
                }
                if (pathname === "/session/session-fixture/abort") return Response.json(true)
                if (pathname === "/session/session-fixture/share/flush") {
                  // The flush begins only after request rejection has been reported. Keep the real CLI alive
                  // while its pending iterator observes EOF, rather than relying on process-exit timing.
                  if (rejected) (await stream.promise).close()
                  await Bun.sleep(250)
                  return Response.json(true)
                }
                return new Response("Unexpected fixture route", { status: 404 })
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const result = yield* vector.run("arguments", {
          command: "fixture-command",
          format: "json",
          extraArgs: ["--attach", server.url.toString(), "--share"],
        })
        expect(result.timedOut).toBe(false)
        vector.expectExit(result, 1)
        const errors = vector.parseJsonEvents(result.stdout).filter((event) => event.type === "error")
        expect(errors, result.stdout).toHaveLength(1)
        expect(errors[0]?.error).toMatchObject({ name: rejected ? "UnknownError" : "EventStreamDisconnected" })
        expect(requests.filter((pathname) => pathname.endsWith("/abort"))).toHaveLength(rejected ? 0 : 1)
        expect(requests.filter((pathname) => pathname.endsWith("/share/flush"))).toHaveLength(1)
      }),
    30_000,
  )
}
