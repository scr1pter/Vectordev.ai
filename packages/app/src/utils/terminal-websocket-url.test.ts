import { describe, expect, test } from "bun:test"
import { terminalWebSocketURL } from "./terminal-websocket-url"

describe("terminalWebSocketURL", () => {
  test("never puts reusable credentials in websocket URLs", () => {
    const url = terminalWebSocketURL({
      url: "http://127.0.0.1:49365",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 0,
      sameOrigin: false,
      username: "vector",
      password: "secret",
    })

    expect(url.protocol).toBe("ws:")
    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("omits query auth for same-origin saved credentials", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: true,
      username: "vector",
      password: "secret",
    })

    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("uses only a scoped ticket for websocket authentication", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: true,
      username: "vector",
      password: "secret",
      ticket: "single-use-ticket",
    })

    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.get("ticket")).toBe("single-use-ticket")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("rejects password-authenticated remote plaintext websockets", () => {
    expect(() =>
      terminalWebSocketURL({
        url: "http://engine.example.test",
        id: "pty_test",
        directory: "/tmp/project",
        cursor: 0,
        password: "secret",
      }),
    ).toThrow("server.insecure.httpsRequired")
  })
})
