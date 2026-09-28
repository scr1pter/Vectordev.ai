// Subprocess integration tests for `vector serve`. Spawns the real CLI in
// headless mode and exercises it over HTTP — this is the only test tier that
// catches bugs spanning argv → server boot → routing → instance loading.
//
// `serve` is long-lived: the harness returns a handle (url/port/kill/exited)
// and kills the process when the test scope closes. The OS-assigned port is
// parsed off the "listening on http://..." line.
import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { cliIt } from "../../lib/cli-process"

describe("vector serve (subprocess)", () => {
  cliIt.live(
    "starts despite other tools' security variables and never prints them",
    ({ home }) =>
      Effect.gen(function* () {
        // Another tool's SERVER_PASSWORD or PERMISSION in the user's shell must neither stop
        // the server nor be read by it. Only Vector's own names and the earlier product's
        // exact prefix count, and those are covered by the environment migration tests.
        for (const suffix of ["SERVER_PASSWORD", "SERVER_USERNAME", "PERMISSION", "SHELL_SANDBOX"]) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              // AppProcess deliberately strips foreign secrets, so launch the CLI directly.
              const child = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  Bun.spawn(
                    [
                      process.execPath,
                      "run",
                      "--conditions=browser",
                      path.resolve(import.meta.dir, "../../../src/index.ts"),
                      "serve",
                      "--hostname",
                      "127.0.0.1",
                      "--port",
                      "0",
                    ],
                    {
                      cwd: home,
                      env: {
                        PATH: path.dirname(process.execPath),
                        HOME: home,
                        VECTOR_TEST_HOME: home,
                        XDG_CONFIG_HOME: path.join(home, ".config"),
                        XDG_DATA_HOME: path.join(home, ".local/share"),
                        XDG_STATE_HOME: path.join(home, ".local/state"),
                        XDG_CACHE_HOME: path.join(home, ".cache"),
                        VECTOR_CONFIG_CONTENT: "{}",
                        VECTOR_AUTH_CONTENT: "{}",
                        VECTOR_DISABLE_PROJECT_CONFIG: "1",
                        VECTOR_PURE: "1",
                        VECTOR_DISABLE_AUTOUPDATE: "1",
                        VECTOR_DISABLE_MODELS_FETCH: "1",
                        [`OTHER_TOOL_${suffix}`]: "private-fixture-value",
                      },
                      stdin: "ignore",
                      stdout: "pipe",
                      stderr: "pipe",
                    },
                  ),
                ),
                (child) =>
                  Effect.promise(() => {
                    if (child.exitCode === null) child.kill("SIGKILL")
                    return child.exited
                  }).pipe(Effect.ignore),
              )
              const output = yield* Effect.promise(async () => {
                const reader = child.stdout.getReader()
                const chunks: string[] = []
                while (!chunks.join("").includes("server listening")) {
                  const next = await reader.read()
                  if (next.done) break
                  chunks.push(new TextDecoder().decode(next.value))
                }
                return chunks.join("")
              }).pipe(Effect.timeout("20 seconds"))
              expect(output).toContain("server listening")
              expect(output).not.toContain("private-fixture-value")
            }),
          )
        }
      }),
    120_000,
  )

  cliIt.live(
    "refuses unprotected network and mDNS listeners for serve and web",
    ({ vector }) =>
      Effect.gen(function* () {
        for (const args of [
          ["serve", "--hostname", "0.0.0.0"],
          ["web", "--hostname", "0.0.0.0"],
          ["serve", "--mdns"],
        ]) {
          const result = yield* vector.spawn(args)
          expect(result.exitCode).toBe(1)
          expect(result.timedOut).toBe(false)
          expect(result.stderr).toContain("VECTOR_SERVER_PASSWORD")
          expect(result.stderr).toContain("--unsecured")
          expect(result.stdout).not.toContain("server listening")
        }
      }),
    60_000,
  )

  cliIt.live(
    "starts an explicitly unsecured listener and keeps configured authentication active",
    ({ vector }) =>
      Effect.gen(function* () {
        const unsecured = yield* vector.serve({ hostname: "0.0.0.0", extraArgs: ["--unsecured"] })
        const open = yield* HttpClient.get(`http://127.0.0.1:${unsecured.port}/config`)
        expect(open.status).toBe(200)
        unsecured.kill()
        yield* Effect.promise(() => unsecured.exited)

        const secured = yield* vector.serve({
          hostname: "0.0.0.0",
          extraArgs: ["--unsecured"],
          env: {
            VECTOR_SERVER_PASSWORD: "owner-secret",
            VECTOR_SERVER_USERNAME: "alice",
          },
        })
        const unauthorized = yield* HttpClientRequest.get(`http://127.0.0.1:${secured.port}/config`).pipe(
          HttpClientRequest.setHeader("authorization", `Basic ${btoa("vector:owner-secret")}`),
          HttpClient.execute,
        )
        expect(unauthorized.status).toBe(401)
        expect(yield* unauthorized.json).toEqual({
          _tag: "UnauthorizedError",
          message: "Authentication required. Use the configured server username: alice.",
        })
        const authorized = yield* HttpClientRequest.get(`http://127.0.0.1:${secured.port}/config`).pipe(
          HttpClientRequest.setHeader("authorization", `Basic ${btoa("alice:owner-secret")}`),
          HttpClient.execute,
        )
        expect(authorized.status).toBe(200)
      }),
    60_000,
  )
  // Smoke test: server starts, binds a port, and /global/health responds.
  // If this fails, all other serve tests likely will too — debug here first.
  cliIt.live(
    "starts, binds a port, and serves /global/health",
    ({ vector }) =>
      Effect.gen(function* () {
        const server = yield* vector.serve()
        expect(server.port).toBeGreaterThan(0)
        expect(server.url).toMatch(/^http:\/\//)

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${server.url}/global/health`)
        expect(res.status).toBe(200)
        // GlobalHealth schema is { success: true, ... } | { success: false, error }.
        // We don't lock in further shape here — any 200 with parseable JSON is
        // enough proof the routing + auth-bypass + instance loading is alive.
        const body = yield* res.json
        expect(body).toBeDefined()
      }),
    60_000,
  )

  // The scope-close finalizer must actually terminate the child. Without this
  // test a regression in the kill path (e.g. a future refactor that forgets
  // to wire the finalizer) would leak processes on every test run.
  cliIt.live(
    "kills the subprocess on scope close",
    ({ vector }) =>
      Effect.gen(function* () {
        // Inner scope so we can observe `.exited` resolving after it closes.
        const exitedPromise = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* vector.serve()
            // Capture the Promise, not the resolved value — scope closes after
            // this gen returns, at which point the finalizer kills the child.
            return server.exited
          }),
        )
        // After scope close: finalizer fired, process must have exited.
        const code = yield* Effect.promise(() => exitedPromise)
        // Bun reports the exit code; SIGTERM-killed processes return non-null
        // (typically 143 on POSIX). We just require resolution within a sane
        // window — anything else means the kill didn't take.
        expect(typeof code === "number" || code === null).toBe(true)
      }),
    60_000,
  )
})
