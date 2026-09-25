import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { assertListenSecurity } from "../../src/server/listen-policy"
import { Server } from "../../src/server/server"

const unprotected = { username: "vector", password: Option.none<string>() }

describe("server bind security", () => {
  test("the public listener refuses an unprotected network bind before starting routes", async () => {
    await expect(Server.listen({ hostname: "0.0.0.0", port: 0 })).rejects.toThrow("VECTOR_SERVER_PASSWORD")
  })
  test("allows only loopback addresses without authentication by default", () => {
    for (const hostname of [
      "localhost",
      "LOCALHOST.",
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(() => assertListenSecurity({ hostname }, unprotected)).not.toThrow()
    }
    for (const hostname of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "example.com",
      "localhost.example.com",
      "::ffff:192.168.1.10",
      "",
    ]) {
      expect(() => assertListenSecurity({ hostname }, unprotected)).toThrow("VECTOR_SERVER_PASSWORD")
      expect(() => assertListenSecurity({ hostname, unsecured: false }, unprotected)).toThrow("--unsecured")
    }
  })

  test("requires explicit unsecured permission or a nonempty owner or guest password", () => {
    expect(() => assertListenSecurity({ hostname: "0.0.0.0", unsecured: true }, unprotected)).not.toThrow()
    expect(() =>
      assertListenSecurity({ hostname: "0.0.0.0" }, { ...unprotected, password: Option.some("secret") }),
    ).not.toThrow()
    expect(() =>
      assertListenSecurity({ hostname: "0.0.0.0" }, { ...unprotected, guestPassword: Option.some("secret") }),
    ).not.toThrow()
    expect(() =>
      assertListenSecurity(
        { hostname: "0.0.0.0" },
        { ...unprotected, password: Option.some(""), guestPassword: Option.some("") },
      ),
    ).toThrow()
  })
})
