import { describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Effect, Result } from "effect"
import { Auth, AuthStorage } from "../../src/auth"
import path from "node:path"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Auth.node, CrossSpawnSpawner.node])))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.live("carries a Kimi For Coding credential saved under its old provider ID to the renamed provider", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.remove("kimi-code-plan-cn")
      yield* auth.set("kimi-for-coding", { type: "api", key: "kimi-fixture" })

      const data = yield* auth.all()
      expect(data["kimi-code-plan-cn"]).toEqual({ type: "api", key: "kimi-fixture" })
      expect(data["kimi-for-coding"]).toBeUndefined()
      // The move is saved, so removing the renamed credential does not bring the old one back.
      yield* auth.remove("kimi-code-plan-cn")
      expect(yield* auth.get("kimi-code-plan-cn")).toBeUndefined()
      expect(yield* auth.get("kimi-for-coding")).toBeUndefined()
    }),
  )

  it.live("keeps a credential already saved under the renamed Kimi provider", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("kimi-code-plan-cn", { type: "api", key: "current-fixture" })
      yield* auth.set("kimi-for-coding", { type: "api", key: "legacy-fixture" })

      const data = yield* auth.all()
      expect(data["kimi-code-plan-cn"]).toEqual({ type: "api", key: "current-fixture" })
      expect(data["kimi-for-coding"]).toEqual({ type: "api", key: "legacy-fixture" })
      yield* Effect.forEach(["kimi-code-plan-cn", "kimi-for-coding"], auth.remove)
    }),
  )

  it.live("create preserves an existing credential while ordinary set still replaces it", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const providerID = "create-only-existing"
      yield* auth.set(providerID, { type: "api", key: "original-fixture" })
      expect(yield* auth.exists(providerID + "/")).toBe(true)
      const result = yield* auth
        .create(providerID + "/", { type: "api", key: "replacement-fixture" })
        .pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("AuthExistsError")
      expect(yield* auth.get(providerID)).toEqual({ type: "api", key: "original-fixture" })
      yield* auth.set(providerID, { type: "api", key: "intentional-replacement" })
      expect(yield* auth.get(providerID)).toEqual({ type: "api", key: "intentional-replacement" })
      yield* auth.remove(providerID)
      expect(yield* auth.exists(providerID)).toBe(false)
    }),
  )

  it.live("concurrent creates admit one credential and preserve unrelated writes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const providerID = "create-only-concurrent"
      yield* auth.remove(providerID)
      const results = yield* Effect.all(
        Array.from({ length: 5 }, (_, index) =>
          auth.create(providerID, { type: "api", key: `fixture-${index}` }).pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      )
      expect(results.filter(Result.isSuccess)).toHaveLength(1)
      expect(results.filter(Result.isFailure)).toHaveLength(4)
      yield* Effect.all(
        Array.from({ length: 5 }, (_, index) =>
          auth.set(`unrelated-${index}`, { type: "api", key: `fixture-${index}` }),
        ),
        { concurrency: "unbounded" },
      )
      const stored = yield* auth.all()
      expect(stored[providerID]).toEqual({ type: "api", key: `fixture-${results.findIndex(Result.isSuccess)}` })
      Array.from({ length: 5 }, (_, index) =>
        expect(stored[`unrelated-${index}`]).toEqual({ type: "api", key: `fixture-${index}` }),
      )
      yield* Effect.forEach([providerID, ...Array.from({ length: 5 }, (_, index) => `unrelated-${index}`)], auth.remove)
    }),
  )

  it.live(
    "create-only is atomic across separate processes sharing a credential store",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.promise(async () => {
          const children = Array.from({ length: 3 }, (_, index) =>
            Bun.spawn({
              cmd: [
                process.execPath,
                "run",
                path.join(import.meta.dir, "fixtures/create-credential.ts"),
                `process-fixture-${index}`,
              ],
              env: {
                PATH: process.env.PATH,
                HOME: tmp,
                VECTOR_TEST_HOME: tmp,
                XDG_DATA_HOME: path.join(tmp, "data"),
                XDG_STATE_HOME: path.join(tmp, "state"),
                XDG_CONFIG_HOME: path.join(tmp, "config"),
                XDG_CACHE_HOME: path.join(tmp, "cache"),
              },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          )
          try {
            const readers = children.map((child) => child.stdout.getReader())
            await Promise.all(
              readers.map(async (reader) => {
                const ready = await reader.read()
                expect(new TextDecoder().decode(ready.value)).toBe("ready\n")
              }),
            )
            children.forEach((child) => child.stdin.end())
            const results = await Promise.all(
              readers.map(async (reader) => {
                const result = await reader.read()
                reader.releaseLock()
                return new TextDecoder().decode(result.value).trim()
              }),
            )
            expect(results.filter((result) => result === "created")).toHaveLength(1)
            expect(results.filter((result) => result === "exists")).toHaveLength(2)
            expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0])
            const stored = AuthStorage.decode(await Bun.file(path.join(tmp, "data/vector/auth.json")).text())
            expect(stored["process-race"]).toEqual({
              type: "api",
              key: `process-fixture-${results.indexOf("created")}`,
            })
          } finally {
            children.forEach((child) => child.kill())
            await Promise.all(children.map((child) => child.exited))
          }
        })
      }),
    30000,
  )

  test("encrypts provider credentials with Vector's vault key", () => {
    const key = Buffer.alloc(32, 7)
    const encoded = AuthStorage.encode(
      {
        "encrypted-provider": {
          type: "api",
          key: "provider-secret-value",
        },
      },
      key,
    )
    expect(encoded).not.toContain("provider-secret-value")
    expect(JSON.parse(encoded).ciphertext).toBeString()
    expect(AuthStorage.decode(encoded, key)).toEqual({
      "encrypted-provider": {
        type: "api",
        key: "provider-secret-value",
      },
    })
  })

  test("refuses to persist provider credentials when secure storage is required but unavailable", () => {
    const previousKey = process.env.VECTOR_CREDENTIAL_KEY
    const previousRequirement = process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE
    delete process.env.VECTOR_CREDENTIAL_KEY
    process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE = "1"

    try {
      expect(() =>
        AuthStorage.encode({
          anthropic: {
            type: "api",
            key: "provider-secret-value",
          },
        }),
      ).toThrow("secure runtime vault")
    } finally {
      if (previousKey === undefined) delete process.env.VECTOR_CREDENTIAL_KEY
      else process.env.VECTOR_CREDENTIAL_KEY = previousKey
      if (previousRequirement === undefined) delete process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE
      else process.env.VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE = previousRequirement
    }
  })
})
