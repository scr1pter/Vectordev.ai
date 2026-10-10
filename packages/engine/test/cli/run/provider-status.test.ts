import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"

for (const mode of ["available", "unavailable", "older-server"] as const) {
  cliIt.live(
    `attached run checks provider status in the session directory (${mode})`,
    ({ vector, home }) =>
      Effect.gen(function* () {
        const directory = path.join(home, "remote-session")
        const requests: { path: string; directory: string | null }[] = []
        const notice = { id: "lmstudio", reason: "disabled", message: "Provider disabled in the session directory" }
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                const url = new URL(request.url)
                const header = request.headers.get("x-vector-directory")
                const current = header ? decodeURIComponent(header) : null
                requests.push({ path: url.pathname, directory: current })
                if (url.pathname === "/config/providers") {
                  return Response.json({
                    providers: [{ id: "lmstudio", models: { "test-model": {} } }],
                    default: { lmstudio: "test-model" },
                    ...(mode === "older-server"
                      ? {}
                      : { unavailable: mode === "unavailable" && current === directory ? [notice] : [] }),
                  })
                }
                if (url.pathname === "/session") {
                  return Response.json({ id: "session-fixture", title: "Fixture", directory })
                }
                if (url.pathname === "/provider") {
                  return Response.json({ all: [], default: {}, connected: [], unavailable: [notice] })
                }
                if (url.pathname === "/event") {
                  return new Response(
                    `data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "session-fixture", status: { type: "idle" } } })}\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                  )
                }
                if (url.pathname === "/session/session-fixture/message") return Response.json({})
                return new Response("Unexpected fixture route", { status: 404 })
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const result = yield* vector.run("hello", {
          format: "json",
          extraArgs: ["--attach", server.url.toString()],
        })

        expect(result.timedOut).toBe(false)
        vector.expectExit(result, mode === "available" ? 0 : 1)
        expect(requests.filter((request) => request.path === "/config/providers")).toEqual([
          { path: "/config/providers", directory: null },
          { path: "/config/providers", directory },
        ])
        expect(requests.filter((request) => request.path === "/provider")).toEqual(
          mode === "older-server" ? [{ path: "/provider", directory }] : [],
        )
        if (mode !== "available") {
          expect(result.stdout).toContain("Provider disabled in the session directory")
          expect(requests.some((request) => request.path.endsWith("/message"))).toBe(false)
        }
      }),
    30_000,
  )
}
