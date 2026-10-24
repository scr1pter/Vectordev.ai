import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "fs"
import path from "path"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { Global } from "@vectordevai/core/global"
import { hostedServer, roleModels } from "../../../app/src/features/local/local-model"
import { capLabel, modesFor } from "../../../app/src/features/research/research-model"
import { Config } from "../../src/config/config"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { LocalServers } from "../../../core/test/fixture/local-servers/serve"

// The app's view of a model server added in Vector, end to end: Add server through the Local API against a fake Ollama
// server, then GET /provider as the app reads it, fed to the app's own code for the composer's Mode menu, its research
// cap and Settings > Vector Local's Roles. A provider Add server writes has a base URL and no model address, so only
// the engine can say where its requests go.

const guard = NetworkGuard.use()

const globalFiles = ["vector.jsonc", "vector.json", "config.json"].map((name) => path.join(Global.Path.config, name))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  globalFiles.forEach((file) => rmSync(file, { force: true }))
  rmSync(Config.localConfirmedFile(), { force: true })
  Config.refreshLocal()
  Config.confirmLocal()
  expect(guard.outside()).toEqual([])
})

function client(directory: string) {
  return createVectorClient({
    baseUrl: "http://vector.test",
    directory,
    fetch: Object.assign(
      async (source: RequestInfo | URL, init?: RequestInit) =>
        Server.Default().app.fetch(source instanceof Request ? source : new Request(source, init)),
      { preconnect() {} },
    ),
  })
}

// GET /provider once it lists `provider`: Add server reloads the engine's instances just after it answers, as
// PATCH /global/config does, and the app reads its provider list again when it hears global.disposed.
async function listing(sdk: ReturnType<typeof client>, directory: string, provider: string) {
  const deadline = Date.now() + 10_000
  while (true) {
    const list = (await sdk.provider.list({ directory }, { throwOnError: true })).data
    if (list.connected.includes(provider) || Date.now() > deadline) return list
    await Bun.sleep(50)
  }
}

describe("a model server added in Vector, as the app reads it", () => {
  test("hides Fast, fills Roles and caps research in steps, though the model's own address is empty", async () => {
    await using tmp = await tmpdir({ git: true })
    const ollama = await LocalServers.serve("ollama")
    try {
      const sdk = client(tmp.path)
      const added = await sdk.local.servers.add({ url: `${ollama.origin}/v1` }, { throwOnError: true })
      const list = await listing(sdk, tmp.path, added.data.provider)
      const provider = list.all.find((item) => item.id === added.data.provider)!
      // What the app is sent: the provider's base URL, and models with no address of their own.
      expect(provider.options.baseURL).toBe(`${ollama.origin}/v1`)
      expect(Object.values(provider.models).map((model) => model.api.url)).toEqual(added.data.models.map(() => ""))
      expect(list.hosted).toEqual(
        added.data.models.map((modelID) => ({
          providerID: added.data.provider,
          modelID,
          origin: ollama.origin,
          local: true,
        })),
      )

      const model = { providerID: added.data.provider, modelID: added.data.models[0]! }
      expect(modesFor(hostedServer(list.hosted, model) !== undefined).map((mode) => mode.id)).toEqual([
        "normal",
        "quick",
        "research",
      ])
      expect(capLabel({ depth: "focused", local: hostedServer(list.hosted, model)?.local === true })).toBe(
        "Local · 80 steps",
      )
      expect(
        roleModels({ providers: list.all, connected: list.connected, hosted: list.hosted }).map((item) => item.key),
      ).toEqual(added.data.models.map((id) => `${added.data.provider}/${id}`))
    } finally {
      await ollama.close()
    }
  })

  test("a listed company endpoint on the internet, or a priced model on this computer, keeps its dollar cap", async () => {
    await using tmp = await tmpdir({ git: true })
    const sdk = client(tmp.path)
    await sdk.global.config.update(
      {
        config: {
          local: { endpoints: ["https://llm.example.com"] },
          provider: {
            company: {
              npm: "@ai-sdk/openai-compatible",
              name: "Company models",
              options: { baseURL: "https://llm.example.com/v1" },
              models: { kimi: { name: "Kimi", tool_call: true } },
            },
            priced: {
              npm: "@ai-sdk/openai-compatible",
              name: "Priced server",
              options: { baseURL: "http://127.0.0.1:8000/v1" },
              models: { large: { name: "Large", tool_call: true, cost: { input: 1, output: 2 } } },
            },
            elsewhere: {
              npm: "@ai-sdk/openai-compatible",
              name: "Unlisted endpoint",
              options: { baseURL: "https://other.example.com/v1" },
              models: { small: { name: "Small", tool_call: true } },
            },
          },
        },
      },
      { throwOnError: true },
    )
    const list = (await sdk.provider.list({ directory: tmp.path }, { throwOnError: true })).data
    const company = hostedServer(list.hosted, { providerID: "company", modelID: "kimi" })
    const priced = hostedServer(list.hosted, { providerID: "priced", modelID: "large" })
    expect(company).toEqual({ providerID: "company", modelID: "kimi", origin: "https://llm.example.com", local: false })
    expect(priced).toEqual({ providerID: "priced", modelID: "large", origin: "http://127.0.0.1:8000", local: false })
    // Both are servers someone hosts, so Fast is hidden, but the run guard prices their steps, so the cap is in dollars.
    expect(modesFor(company !== undefined).some((mode) => mode.id === "fast")).toBe(false)
    expect(capLabel({ depth: "focused", local: company?.local === true })).toBe("Cap $1.00")
    expect(capLabel({ depth: "focused", local: priced?.local === true })).toBe("Cap $1.00")
    // An endpoint on the internet that is not on the list is a cloud API: Fast stays, and Roles does not offer it.
    expect(hostedServer(list.hosted, { providerID: "elsewhere", modelID: "small" })).toBeUndefined()
    expect(
      roleModels({ providers: list.all, connected: list.connected, hosted: list.hosted }).map((item) => item.key),
    ).toEqual(["company/kimi", "priced/large"])
  })
})
