import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
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
      expect((yield* request("/config/trust")).body).toMatchObject({ trusted: false, ignored: true, settings: true })
      const ignored = (yield* Fiber.join(notice)).payload.properties
      expect(ignored).toMatchObject({ title: "Repository settings ignored" })
      expect(`${ignored.title} ${ignored.message}`).not.toMatch(/project/i)

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

      // The project has no settings of its own, so the notice says it is untrusted rather than that settings are ignored.
      expect((yield* request(tmp.path, "/config/trust")).body).toMatchObject({
        trusted: false,
        ignored: true,
        settings: false,
      })
      const held = (yield* Fiber.join(notice)).payload.properties
      expect(held).toMatchObject({ title: "Repository not trusted" })
      expect(`${held.title} ${held.message}`).not.toMatch(/project/i)
      expect(held.message).toContain("language servers")
      expect(held.message).not.toContain("vector.json")
      expect(held.message).toContain("vector trust approve")

      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const approved = yield* request(tmp.path, "/config/trust", { method: "POST" })
      expect(approved).toMatchObject({ status: 200, body: { trusted: true, ignored: false } })
      yield* Fiber.join(disposed)
    }),
  )

  it.live(
    "points the desktop engine's held-back notice at Settings, Repository trust only",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({})
      const original = { config: process.env.VECTOR_CONFIG_CONTENT, client: process.env.VECTOR_CLIENT }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (original.config === undefined) delete process.env.VECTOR_CONFIG_CONTENT
          else process.env.VECTOR_CONFIG_CONTENT = original.config
          if (original.client === undefined) delete process.env.VECTOR_CLIENT
          else process.env.VECTOR_CLIENT = original.client
        }),
      )
      process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ lsp: true })
      process.env.VECTOR_CLIENT = "desktop"
      const notice = yield* waitGlobalBusEvent({
        message: "timed out waiting for the held-back notice",
        predicate: (event) => event.payload.type === "tui.toast.show",
      }).pipe(Effect.forkScoped({ startImmediately: true }))

      yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/trust", { headers: { "x-vector-directory": tmp.path } })),
      )
      const held = (yield* Fiber.join(notice)).payload.properties
      // The app never asks about a repository without settings of its own, so the notice says where trust lives.
      expect(held).toMatchObject({ title: "Repository not trusted" })
      expect(held.message).toContain("Trust it in Settings, under Repository trust.")
      expect(held.message).not.toContain("session header")
      expect(held.message).not.toContain("vector trust")
      expect(held.message).not.toContain("/trust")
    }),
  )

  it.live(
    "leaves a desktop repository's ignored settings to the app's one-time question",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { model: "test/project-model", formatter: false }, trusted: false })
      const original = process.env.VECTOR_CLIENT
      const toasts: unknown[] = []
      const listener = (event: GlobalEvent) => {
        if (event.payload.type === "tui.toast.show") toasts.push(event.payload.properties)
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          GlobalBus.off("event", listener)
          if (original === undefined) delete process.env.VECTOR_CLIENT
          else process.env.VECTOR_CLIENT = original
        }),
      )
      process.env.VECTOR_CLIENT = "desktop"

      // Reading the status loads the config, which is where the notice would be sent.
      const response = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/trust", { headers: { "x-vector-directory": tmp.path } })),
      )
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        trusted: false,
        ignored: true,
        settings: true,
      })
      // The app asks once and remembers "Not now"; a warning on every load would undo that answer.
      expect(toasts).toEqual([])
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
