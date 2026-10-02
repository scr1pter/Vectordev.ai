import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Redaction } from "@vectordevai/core/redaction"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { waitGlobalBusEvent } from "./global-bus"
import { Effect } from "effect"

const secrets = ["sk-config-secret", "header-secret", "model-header-secret", "env-secret", "mcp-header-secret"]

const config = {
  formatter: false,
  lsp: false,
  provider: {
    custom: {
      name: "Custom",
      npm: "@ai-sdk/openai-compatible",
      options: {
        apiKey: "sk-config-secret",
        baseURL: "https://api.example.com/v1",
        headers: { Authorization: "Bearer header-secret", "User-Agent": "vector-test" },
      },
      models: {
        small: { name: "Small", headers: { "x-api-key": "model-header-secret" } },
      },
    },
  },
  mcp: {
    tools: {
      type: "local",
      command: ["tools-server"],
      enabled: false,
      environment: { GITHUB_TOKEN: "env-secret", DEBUG: "1" },
    },
    remote: {
      type: "remote",
      url: "https://mcp.example.com",
      enabled: false,
      headers: { Authorization: "Bearer mcp-header-secret" },
    },
  },
}

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-vector-directory", directory)
  return Promise.resolve(Server.Default().app.request(route, { ...init, headers }))
}

async function text(route: string, directory: string) {
  const response = await request(route, directory)
  expect(response.status).toBe(200)
  return response.text()
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config and provider responses", () => {
  test("never carry a stored secret to the client", async () => {
    await using tmp = await tmpdir({ config })
    for (const route of ["/config", "/provider", "/config/providers"]) {
      const body = await text(route, tmp.path)
      // The custom provider must be listed, or the check below proves nothing.
      expect({ route, listed: body.includes("api.example.com") }).toEqual({ route, listed: true })
      for (const secret of secrets) expect({ route, leaked: body.includes(secret) }).toEqual({ route, leaked: false })
    }
  })

  test("GET /config marks each secret and keeps everything else", async () => {
    await using tmp = await tmpdir({ config })
    const body = JSON.parse(await text("/config", tmp.path))
    expect(body.provider.custom.options).toMatchObject({
      apiKey: Redaction.MARKER,
      baseURL: "https://api.example.com/v1",
      headers: { Authorization: Redaction.MARKER, "User-Agent": "vector-test" },
    })
    expect(body.provider.custom.models.small.headers["x-api-key"]).toBe(Redaction.MARKER)
    expect(body.mcp.tools.environment).toEqual({ GITHUB_TOKEN: Redaction.MARKER, DEBUG: "1" })
    expect(body.mcp.remote.headers.Authorization).toBe(Redaction.MARKER)
  })

  test("writing the redacted config back keeps every stored secret", async () => {
    await using tmp = await tmpdir({ config })
    const body = JSON.parse(await text("/config", tmp.path))
    const disposed = Effect.runPromise(
      waitGlobalBusEvent({
        message: "timed out waiting for instance disposal",
        predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === tmp.path,
      }),
    )
    const response = await request("/config", tmp.path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, username: "round-trip" }),
    })
    expect(response.status).toBe(200)
    const echoed = await response.text()
    for (const secret of secrets) expect(echoed).not.toContain(secret)
    await disposed

    const saved = await Bun.file(path.join(tmp.path, "vector.json")).json()
    expect(saved.username).toBe("round-trip")
    expect(saved.provider.custom.options).toMatchObject({
      apiKey: "sk-config-secret",
      headers: { Authorization: "Bearer header-secret", "User-Agent": "vector-test" },
    })
    expect(saved.provider.custom.models.small.headers["x-api-key"]).toBe("model-header-secret")
    expect(saved.mcp.tools.environment).toEqual({ GITHUB_TOKEN: "env-secret", DEBUG: "1" })
    expect(saved.mcp.remote.headers.Authorization).toBe("Bearer mcp-header-secret")
    expect(JSON.stringify(saved)).not.toContain(Redaction.MARKER)
  })

  test("re-adding an MCP server from the redacted config keeps its stored secret", async () => {
    await using tmp = await tmpdir({ config })
    const body = JSON.parse(await text("/config", tmp.path))
    expect(body.mcp.tools.environment.GITHUB_TOKEN).toBe(Redaction.MARKER)
    const response = await request("/mcp", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tools", config: body.mcp.tools }),
    })
    expect(response.status).toBe(200)

    const saved = await Bun.file(path.join(tmp.path, ".vector", "vector.local.json")).json()
    expect(saved.mcp.tools.environment).toEqual({ GITHUB_TOKEN: "env-secret", DEBUG: "1" })
  })
})
