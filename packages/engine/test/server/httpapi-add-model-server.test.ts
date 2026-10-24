import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "fs"
import path from "path"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { Global } from "@vectordevai/core/global"
import { Egress } from "@vectordevai/core/local-mode/egress"
import type { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { saveCustomProvider } from "../../../app/src/components/dialog-custom-provider-save"
import { validateCustomProvider } from "../../../app/src/components/dialog-custom-provider-form"
import { listServer } from "../../../app/src/features/local/local-model"
import { Config } from "../../src/config/config"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The app's Add server, end to end: the dialog's own save code against the engine's routes. It writes the provider to
// the user's global config and puts the server on the list through the Local API, as the dialog does, which asks the
// owner first when that loosens Vector Local.

const guard = NetworkGuard.use()

const SERVER = "http://127.0.0.1:11434"
const GPU_BOX = "http://10.0.0.5:8000"
const globalFiles = ["vector.jsonc", "vector.json", "config.json"].map((name) => path.join(Global.Path.config, name))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  globalFiles.forEach((file) => rmSync(file, { force: true }))
  rmSync(Config.localConfirmedFile(), { force: true })
  // Removing a test's config can loosen Vector Local, which waits for the owner; the owner here says yes.
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

// What Add server saves for a vLLM server Detect found on the user's network.
function gpuBox() {
  const server: LocalProbe.Server = {
    kind: "vllm",
    name: "vLLM",
    origin: GPU_BOX,
    baseURL: `${GPU_BOX}/v1`,
    class: "your-network",
    encrypted: false,
    models: [],
    pin: { kind: "vllm", version: "0.9.2" },
  }
  return validateCustomProvider({
    form: {
      providerID: "gpu-box",
      name: "GPU box",
      baseURL: `${GPU_BOX}/v1`,
      apiKey: "",
      models: [{ row: "m0", id: "kimi", name: "Kimi", err: {} }],
      headers: [],
      server,
      err: {},
    },
    t: (key) => key,
  }).result!
}

// The user's global config as the route wrote it: vector.jsonc when the user had no config file yet.
function savedLocal() {
  const file = globalFiles.find((item) => existsSync(item))!
  return JSON.parse(readFileSync(file, "utf8")).local
}

// The dialog's listing: PATCH /local, and once more with confirm when the engine asks and the owner agrees.
async function addServer(directory: string, agree = true) {
  const sdk = client(directory)
  return saveCustomProvider({
    client: sdk,
    result: gpuBox(),
    directory,
    conflictMessage: "Choose a different ID",
    updateConfig: (config) => sdk.global.config.update({ config }, { throwOnError: true }),
    list: async (server) => {
      const send = (confirm: boolean) =>
        sdk.local.update({ localUpdate: { ...listServer(server), by: "app", ...(confirm ? { confirm: true } : {}) } })
      const first = await send(false)
      if (first.data) return true
      if (!agree) return false
      // The owner answers in a dialog, after the app has read the provider list that saving the provider reloaded.
      await reloaded(sdk, directory, "gpu-box")
      return (await send(true)).data !== undefined
    },
  })
}

// PATCH /global/config reloads the engine's instances just after it answers; the provider list names `provider`, as
// listed or as off in Vector Local, once that reload is done.
async function reloaded(sdk: ReturnType<typeof client>, directory: string, provider: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const list = (await sdk.provider.list({ directory }, { throwOnError: true })).data
    if ([...list.all, ...(list.unavailable ?? [])].some((item) => item.id === provider)) return
    await Bun.sleep(50)
  }
}

describe("Add server", () => {
  test("keeps the servers the user listed before and pins the new one", async () => {
    await using tmp = await tmpdir({ git: true })
    // An earlier Add server listed the server on this computer.
    await client(tmp.path).global.config.update(
      { config: { local: { endpoints: [SERVER], pins: { [SERVER]: { kind: "ollama" } } } } },
      { throwOnError: true },
    )

    await addServer(tmp.path)

    expect(savedLocal()).toEqual({
      endpoints: [SERVER, GPU_BOX],
      pins: { [SERVER]: { kind: "ollama" }, [GPU_BOX]: { kind: "vllm", version: "0.9.2" } },
    })
    expect(Config.local().endpoints).toEqual([
      { origin: SERVER, from: "user" },
      { origin: GPU_BOX, from: "user" },
    ])
    // Only Config.local() says what Vector Local is: the merged config carries no local block.
    const merged = await client(tmp.path).config.get({ directory: tmp.path }, { throwOnError: true })
    expect(merged.data.local).toBeUndefined()
  })

  test("with Vector Local on, the new server is listed only once the owner agrees, and the one listed stays", async () => {
    await using tmp = await tmpdir({ git: true })
    await client(tmp.path).global.config.update(
      { config: { local: { enabled: true, endpoints: [SERVER] } } },
      { throwOnError: true },
    )
    expect(Config.local()).toMatchObject({ enabled: true, endpoints: [{ origin: SERVER }] })
    const inference = (origin: string) =>
      Egress.decide({ source: "local-inference", url: `${origin}/v1/chat/completions` }).decision

    // The owner says no: the provider is saved, its server stays off the list and its model calls stay blocked.
    expect(await addServer(tmp.path, false)).toEqual({ listed: false })
    expect(savedLocal().endpoints).toEqual([SERVER])
    expect(Config.local().endpoints).toEqual([{ origin: SERVER, from: "user" }])
    expect(inference(SERVER)).toBe("allow")
    expect(inference(GPU_BOX)).toBe("block")
  })

  test("with Vector Local on, the owner agreeing lists the server with its pin", async () => {
    await using tmp = await tmpdir({ git: true })
    await client(tmp.path).global.config.update(
      { config: { local: { enabled: true, endpoints: [SERVER] } } },
      { throwOnError: true },
    )

    expect(await addServer(tmp.path)).toEqual({ listed: true })
    expect(Config.local().endpoints).toEqual([
      { origin: SERVER, from: "user" },
      { origin: GPU_BOX, from: "user" },
    ])
    expect(savedLocal().pins).toEqual({ [GPU_BOX]: { kind: "vllm", version: "0.9.2" } })
    expect(Egress.decide({ source: "local-inference", url: `${GPU_BOX}/v1/chat/completions` }).decision).toBe("allow")
  })
})
