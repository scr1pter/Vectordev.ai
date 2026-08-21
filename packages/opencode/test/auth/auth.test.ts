import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth, AuthStorage } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

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
