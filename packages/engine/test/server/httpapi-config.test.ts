import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "reports ignored project config and loads it once the project is trusted",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { model: "test/project-model", formatter: false }, trusted: false })
      const request = (route: string, init: RequestInit = {}) =>
        Effect.promise(async () => {
          const response = await app().request(route, {
            ...init,
            headers: { "content-type": "application/json", "x-vector-directory": tmp.path },
          })
          return { status: response.status, body: await response.json() }
        })
      const notice = yield* waitGlobalBusEvent({
        message: "timed out waiting for the ignored-config notice",
        predicate: (event) => event.payload.type === "tui.toast.show",
      }).pipe(Effect.forkScoped({ startImmediately: true }))

      // The project's settings are not loaded, and clients can see why.
      expect((yield* request("/config")).body.model).not.toBe("test/project-model")
      expect((yield* request("/config/trust")).body).toMatchObject({ trusted: false, ignored: true })
      expect((yield* Fiber.join(notice)).payload.properties).toMatchObject({ title: "Project settings ignored" })

      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const approved = yield* request("/config/trust", { method: "POST" })
      expect(approved).toMatchObject({ status: 200, body: { trusted: true, ignored: false } })
      yield* Fiber.join(disposed)
      expect((yield* request("/config")).body.model).toBe("test/project-model")
    }),
  )

  it.live(
    "reports the user's language servers held back in an untrusted project without its own config",
    Effect.gen(function* () {
      const plain = yield* tmpdirEffect({})
      const tmp = yield* tmpdirEffect({})
      const request = (directory: string, route: string, init: RequestInit = {}) =>
        Effect.promise(async () => {
          const response = await app().request(route, {
            ...init,
            headers: { "content-type": "application/json", "x-vector-directory": directory },
          })
          return { status: response.status, body: await response.json() }
        })
      // Nothing is held back without project config or user tooling, so no notice.
      expect((yield* request(plain.path, "/config/trust")).body).toMatchObject({ trusted: false, ignored: false })

      const original = process.env.VECTOR_CONFIG_CONTENT
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (original === undefined) delete process.env.VECTOR_CONFIG_CONTENT
          else process.env.VECTOR_CONFIG_CONTENT = original
        }),
      )
      process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ lsp: true })
      const notice = yield* waitGlobalBusEvent({
        message: "timed out waiting for the held-back notice",
        predicate: (event) => event.payload.type === "tui.toast.show",
      }).pipe(Effect.forkScoped({ startImmediately: true }))

      expect((yield* request(tmp.path, "/config/trust")).body).toMatchObject({ trusted: false, ignored: true })
      expect((yield* Fiber.join(notice)).payload.properties.message).toContain("language servers")

      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const approved = yield* request(tmp.path, "/config/trust", { method: "POST" })
      expect(approved).toMatchObject({ status: 200, body: { trusted: true, ignored: false } })
      yield* Fiber.join(disposed)
    }),
  )

  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ trusted: true, config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-vector-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "vector.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        trusted: true,
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-vector-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
