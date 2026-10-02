import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { allowedHost, assertListenSecurity, guardedHostname } from "../../src/server/listen-policy"
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

  test("guards the Host header only on a passwordless loopback listener", () => {
    expect(guardedHostname({ hostname: "127.0.0.1" }, unprotected)).toBe("127.0.0.1")
    expect(guardedHostname({ hostname: "localhost" }, unprotected)).toBe("localhost")
    expect(guardedHostname({ hostname: "::1" }, unprotected)).toBe("::1")
    expect(guardedHostname({ hostname: "127.0.0.1" }, { ...unprotected, password: Option.some("secret") })).toBe(
      undefined,
    )
    expect(guardedHostname({ hostname: "127.0.0.1" }, { ...unprotected, guestPassword: Option.some("secret") })).toBe(
      undefined,
    )
    expect(guardedHostname({ hostname: "0.0.0.0" }, unprotected)).toBe(undefined)
  })

  test("accepts loopback names and the configured hostname as Host", () => {
    for (const host of [
      "localhost",
      "localhost:4096",
      "LOCALHOST:4096",
      "localhost.:4096",
      "127.0.0.1",
      "127.0.0.1:4096",
      "127.0.0.2:4096",
      "[::1]:4096",
      "[::ffff:127.0.0.1]:4096",
      undefined,
    ]) {
      expect({ host, allowed: allowedHost(host, "127.0.0.1") }).toEqual({ host, allowed: true })
    }
    expect(allowedHost("[::1]:4096", "::1")).toBe(true)
  })

  test("rejects any other Host, which is what a DNS rebinding page sends", () => {
    for (const host of [
      "attacker.example:4096",
      "attacker.example",
      "localhost.attacker.example:4096",
      "127.0.0.1.attacker.example",
      "192.168.1.10:4096",
      "[::]:4096",
      "evil@127.0.0.1",
      "127.0.0.1/evil",
      "",
    ]) {
      expect({ host, allowed: allowedHost(host, "127.0.0.1") }).toEqual({ host, allowed: false })
    }
  })
})
