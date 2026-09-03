import { beforeEach, describe, expect, test } from "bun:test"
import { mintCliToken, verifyCliToken } from "../api/_lib/cli-token.js"
import { ApiError } from "../api/_lib/http.js"

describe("cli tokens", () => {
  beforeEach(() => {
    process.env.VECTOR_LICENSE_SECRET = "a".repeat(48)
  })

  test("mint then verify round-trips the user", () => {
    const { token, expiresAt } = mintCliToken({ id: "3f2b9c9a-1111-4222-8333-444455556666", email: "k@vectordev.ai" })
    expect(token.startsWith("vct_")).toBe(true)
    expect(expiresAt).toBeGreaterThan(Date.now())
    const user = verifyCliToken(token)
    expect(user).toEqual({ id: "3f2b9c9a-1111-4222-8333-444455556666", email: "k@vectordev.ai" })
  })

  test("rejects tampered payloads", () => {
    const { token } = mintCliToken({ id: "u1", email: "k@vectordev.ai" })
    const [payload, signature] = token.slice(4).split(".")
    const forged = Buffer.from(JSON.stringify({ v: 1, sub: "someone-else", email: "x@y.z", exp: Date.now() + 1e9 }))
      .toString("base64url")
    expect(() => verifyCliToken(`vct_${forged}.${signature}`)).toThrow(ApiError)
    expect(() => verifyCliToken(`vct_${payload}.AAAA`)).toThrow(ApiError)
  })

  test("rejects expired tokens with CLI_TOKEN_EXPIRED", () => {
    const { token } = mintCliToken({ id: "u1", email: "k@vectordev.ai" }, Date.now() - 91 * 24 * 60 * 60 * 1000)
    try {
      verifyCliToken(token)
      throw new Error("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe("CLI_TOKEN_EXPIRED")
    }
  })

  test("rejects garbage", () => {
    for (const bad of ["", "vct_", "vct_x", "nope", "vct_a.b.c"]) {
      expect(() => verifyCliToken(bad)).toThrow(ApiError)
    }
  })

  test("refuses to mint without a configured secret", () => {
    process.env.VECTOR_LICENSE_SECRET = "short"
    expect(() => mintCliToken({ id: "u1", email: "k@vectordev.ai" })).toThrow(ApiError)
  })
})
