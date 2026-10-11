import { describe, expect, test } from "bun:test"
import { webSocketTransport } from "../../src/plugin"

describe("plugin.openai.websocket rollout", () => {
  test("uses websockets for ChatGPT sign-in on every channel", () => {
    for (const channel of ["local", "dev", "beta", "latest", "prod"])
      expect(webSocketTransport({ enabled: false, disabled: false, channel }).signIn).toBe(true)
  })

  test("uses websockets for API keys only on pre-release channels unless opted in", () => {
    expect(webSocketTransport({ enabled: false, disabled: false, channel: "local" }).apiKey).toBe(true)
    expect(webSocketTransport({ enabled: false, disabled: false, channel: "dev" }).apiKey).toBe(true)
    expect(webSocketTransport({ enabled: false, disabled: false, channel: "beta" }).apiKey).toBe(true)
    expect(webSocketTransport({ enabled: false, disabled: false, channel: "latest" }).apiKey).toBe(false)
    expect(webSocketTransport({ enabled: false, disabled: false, channel: "prod" }).apiKey).toBe(false)
    expect(webSocketTransport({ enabled: true, disabled: false, channel: "latest" }).apiKey).toBe(true)
    expect(webSocketTransport({ enabled: true, disabled: false, channel: "prod" }).apiKey).toBe(true)
  })

  test("the opt-out keeps every credential on HTTP", () => {
    for (const channel of ["local", "latest"])
      expect(webSocketTransport({ enabled: true, disabled: true, channel })).toEqual({ signIn: false, apiKey: false })
  })
})
