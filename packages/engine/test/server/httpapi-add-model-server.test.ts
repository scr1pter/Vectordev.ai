import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "fs"
import path from "path"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { Global } from "@vectordevai/core/global"
import { Egress } from "@vectordevai/core/local-mode/egress"
import type { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { saveCustomProvider } from "../../../app/src/components/dialog-custom-provider-save"
import { validateCustomProvider } from "../../../app/src/components/dialog-custom-provider-form"
import { Config } from "../../src/config/config"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The app's Add server, end to end: the dialog's own save code against the engine's routes. It reads the user's server
// list from GET /global/config and writes it back with the new server, since an update replaces a list.

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

async function addServer(directory: string) {
  const sdk = client(directory)
  await saveCustomProvider({
    client: sdk,
    result: gpuBox(),
    directory,
    conflictMessage: "Choose a different ID",
    updateConfig: (config) => sdk.global.config.update({ config }, { throwOnError: true }),
  })
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

  test("with Vector Local on, the new server waits for the owner and the one already listed stays on the list", async () => {
    await using tmp = await tmpdir({ git: true })
    await client(tmp.path).global.config.update(
      { config: { local: { enabled: true, endpoints: [SERVER] } } },
      { throwOnError: true },
    )
    expect(Config.local()).toMatchObject({ enabled: true, endpoints: [{ origin: SERVER }] })

    await addServer(tmp.path)

    expect(savedLocal().endpoints).toEqual([SERVER, GPU_BOX])
    expect(Config.local().endpoints).toEqual([{ origin: SERVER, from: "user" }])
    expect(Config.localPending()?.changes).toEqual([`adds the model server ${GPU_BOX}`])
    const inference = (origin: string) =>
      Egress.decide({ source: "local-inference", url: `${origin}/v1/chat/completions` }).decision
    expect(inference(SERVER)).toBe("allow")
    expect(inference(GPU_BOX)).toBe("block")
  })
})
