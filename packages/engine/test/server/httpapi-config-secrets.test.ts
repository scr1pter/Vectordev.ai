import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@vectordevai/core/global"
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

function patch(route: string, directory: string, body: unknown) {
  return request(route, directory, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function waitDisposed(directory: string) {
  return Effect.runPromise(
    waitGlobalBusEvent({
      message: "timed out waiting for instance disposal",
      predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
    }),
  )
}

// Global config is cached until a write changes it, so each test seeds the file
// and then makes a real change through PATCH /global/config to load it.
async function withGlobalConfig(directory: string, content: object, fn: (file: string) => Promise<void>) {
  // The file PATCH /global/config writes: the first of these that exists.
  const candidates = ["vector.jsonc", "vector.json", "config.json"].map((name) => path.join(Global.Path.config, name))
  const present = await Promise.all(candidates.map((candidate) => Bun.file(candidate).exists()))
  const file = candidates[present.indexOf(true)] ?? candidates[1]
  const original = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "{}"
  await Bun.write(file, JSON.stringify(content, null, 2))
  expect((await patch("/global/config", directory, { username: "seeded" })).status).toBe(200)
  try {
    await fn(file)
  } finally {
    await Bun.write(file, original)
    await patch("/global/config", directory, { username: "restored" })
    await Bun.write(file, original)
  }
}

// The V2 catalog loads providers from config in the background after the
// location opens, so wait until the custom provider shows up.
async function waitForProvider(directory: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await text("/api/provider", directory)).includes('"id":"custom"')) return
    await Bun.sleep(200)
  }
  throw new Error("the custom provider never reached the V2 catalog")
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

  test("V2 provider and model responses never carry a stored secret", async () => {
    await using tmp = await tmpdir({ git: true, config })
    await waitForProvider(tmp.path)
    for (const route of ["/api/provider", "/api/provider/custom", "/api/model"]) {
      const body = await text(route, tmp.path)
      // The custom provider must be listed, or the check below proves nothing.
      expect({ route, listed: body.includes("api.example.com") }).toEqual({ route, listed: true })
      expect({ route, marked: body.includes(Redaction.MARKER) }).toEqual({ route, marked: true })
      for (const secret of secrets) expect({ route, leaked: body.includes(secret) }).toEqual({ route, leaked: false })
    }
  }, 30_000)

  test("re-adding an MCP server keeps the {env:...} reference its config file holds", async () => {
    process.env.VECTOR_TEST_MCP_SECRET = "env-reference-secret"
    try {
      await using tmp = await tmpdir({
        config: {
          formatter: false,
          lsp: false,
          mcp: {
            tools: {
              type: "local",
              command: ["tools-server"],
              enabled: false,
              environment: { GITHUB_TOKEN: "{env:VECTOR_TEST_MCP_SECRET}" },
            },
            remote: {
              type: "remote",
              url: "https://mcp.example.com",
              enabled: false,
              headers: { Authorization: "Bearer {env:VECTOR_TEST_MCP_SECRET}" },
            },
          },
        },
      })
      const body = JSON.parse(await text("/config", tmp.path))
      expect(body.mcp.tools.environment.GITHUB_TOKEN).toBe(Redaction.MARKER)
      expect(body.mcp.remote.headers.Authorization).toBe(Redaction.MARKER)
      for (const name of ["tools", "remote"]) {
        const response = await request("/mcp", tmp.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, config: body.mcp[name] }),
        })
        expect(response.status).toBe(200)
      }

      const saved = await Bun.file(path.join(tmp.path, ".vector", "vector.local.json")).text()
      expect(saved).not.toContain("env-reference-secret")
      expect(saved).not.toContain(Redaction.MARKER)
      expect(JSON.parse(saved).mcp.tools.environment.GITHUB_TOKEN).toBe("{env:VECTOR_TEST_MCP_SECRET}")
      expect(JSON.parse(saved).mcp.remote.headers.Authorization).toBe("Bearer {env:VECTOR_TEST_MCP_SECRET}")
    } finally {
      delete process.env.VECTOR_TEST_MCP_SECRET
    }
  })
})

describe("global config responses", () => {
  test("never carry a stored secret, and writing them back keeps every secret", async () => {
    await using tmp = await tmpdir()
    await withGlobalConfig(tmp.path, { $schema: "https://vectordev.ai/config.json", ...config }, async (file) => {
      const body = await text("/global/config", tmp.path)
      for (const secret of secrets) expect(body).not.toContain(secret)
      const info = JSON.parse(body)
      expect(info.provider.custom.options.apiKey).toBe(Redaction.MARKER)
      expect(info.provider.custom.options.headers.Authorization).toBe(Redaction.MARKER)
      expect(info.mcp.tools.environment.GITHUB_TOKEN).toBe(Redaction.MARKER)

      const response = await patch("/global/config", tmp.path, { ...info, username: "global-round-trip" })
      expect(response.status).toBe(200)
      const echoed = await response.text()
      for (const secret of secrets) expect(echoed).not.toContain(secret)

      const saved = await Bun.file(file).text()
      expect(saved).not.toContain(Redaction.MARKER)
      const stored = JSON.parse(saved)
      expect(stored.username).toBe("global-round-trip")
      expect(stored.provider.custom.options).toMatchObject({
        apiKey: "sk-config-secret",
        headers: { Authorization: "Bearer header-secret", "User-Agent": "vector-test" },
      })
      expect(stored.provider.custom.models.small.headers["x-api-key"]).toBe("model-header-secret")
      expect(stored.mcp.tools.environment).toEqual({ GITHUB_TOKEN: "env-secret", DEBUG: "1" })
      expect(stored.mcp.remote.headers.Authorization).toBe("Bearer mcp-header-secret")
    })
  })
})

describe("permission rules whose patterns look like secret names", () => {
  const rules = { read: { "*.key": "deny", "cat *token": "ask" }, "*password": "deny" } as const

  test("reach the client unchanged from GET and PATCH /config", async () => {
    await using tmp = await tmpdir({ config: { ...config, permission: rules, agent: { build: { permission: rules } } } })
    const response = await request("/config", tmp.path)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.permission).toMatchObject(rules)
    expect(body.agent.build.permission).toMatchObject(rules)
    expect(body.provider.custom.options.apiKey).toBe(Redaction.MARKER)

    const disposed = waitDisposed(tmp.path)
    const updated = await patch("/config", tmp.path, { ...body, username: "rules" })
    expect(updated.status).toBe(200)
    const echoed = await updated.json()
    expect(echoed.permission).toMatchObject(rules)
    expect(echoed.agent.build.permission).toMatchObject(rules)
    await disposed
  })

  test("reach the client unchanged from GET and PATCH /global/config", async () => {
    await using tmp = await tmpdir()
    const content = { $schema: "https://vectordev.ai/config.json", permission: rules, agent: { build: { permission: rules } } }
    await withGlobalConfig(tmp.path, content, async () => {
      const response = await request("/global/config", tmp.path)
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.permission).toMatchObject(rules)
      expect(body.agent.build.permission).toMatchObject(rules)

      const updated = await patch("/global/config", tmp.path, { ...body, shell: "/bin/zsh" })
      expect(updated.status).toBe(200)
      const echoed = await updated.json()
      expect(echoed.permission).toMatchObject(rules)
      expect(echoed.agent.build.permission).toMatchObject(rules)
    })
  })
})
