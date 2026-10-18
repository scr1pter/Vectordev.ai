import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Flag } from "@vectordevai/core/flag/flag"
import { FreeModels } from "@vectordevai/core/free-models"
import { FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { Global } from "@vectordevai/core/global"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { testProviderConfig } from "../lib/test-provider"

const laguna = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  contextLength: 262144,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
}

test("an invited guest is neither offered nor sent to a free model that may train, though the owner accepted", async () => {
  await using tmp = await tmpdir({ trusted: true, config: testProviderConfig("http://127.0.0.1:9/v1") })
  // Model fetches are off in tests, so the engine serves the last catalog vectordev.ai sent: this one. Nothing here
  // reaches the network, since every request to the may-train model is refused before it is built.
  const cache = path.join(Global.Path.cache, "free-models-v2.json")
  await mkdir(path.dirname(cache), { recursive: true })
  await writeFile(
    cache,
    JSON.stringify({ enabled: true, updatedAt: Date.now(), models: [FREE_MODEL_FALLBACKS[0], laguna] }),
  )
  const consent = FreeModels.createClient({ consentFile: FreeModels.trainingConsentFile() })
  await consent.setTrainingConsent(true)
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
    "VECTOR_CLI_TOKEN",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
    // The owner is signed in to Vector, so the engine lists the shared allowance's models.
    VECTOR_CLI_TOKEN: "vct_synthetic-owner.token",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: ServerAuth.header({ username: "vector", password: "owner-secret" }) ?? "" }
  const guest = { authorization: ServerAuth.header({ username: "guest", password: "guest-secret" }) ?? "" }
  const at = (route: string) => new URL(`${route}?directory=${encodeURIComponent(tmp.path)}`, listener.url)
  const get = (route: string, headers: Record<string, string>) => fetch(at(route), { headers, keepalive: false })
  const send = (route: string, headers: Record<string, string>, body: unknown) =>
    fetch(at(route), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: false,
    })
  const listed = async (headers: Record<string, string>) => {
    const body = (await (await get("/provider", headers)).json()) as {
      all: { id: string; models: Record<string, unknown> }[]
    }
    return Object.keys(body.all.find((provider) => provider.id === "vector")?.models ?? {})
  }
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    // The owner is offered the model and has accepted; the guest is offered no-training models only and has no
    // acceptance of its own.
    expect(await listed(owner)).toContain(laguna.id)
    expect(await listed(guest)).toEqual([FREE_MODEL_FALLBACKS[0].id])
    expect(await (await get("/provider/free-models/consent", owner)).json()).toEqual({ training: true })
    expect(await (await get("/provider/free-models/consent", guest)).json()).toEqual({ training: false })
    expect((await send("/provider/free-models/consent", guest, { training: true })).status).toBe(403)

    // A guest's prompt naming the model is refused before anything is saved.
    const session = ((await (await send("/session", guest, {})).json()) as { id: string }).id
    const refused = await send(`/session/${session}/message`, guest, {
      model: { providerID: "vector", modelID: laguna.id },
      parts: [{ type: "text", text: "hello" }],
    })
    expect(refused.ok).toBe(false)
    expect(await (await get(`/session/${session}/message`, owner)).json()).toEqual([])

    // On the v2 route the prompt runs on the session's model, which the owner set to the may-train one.
    expect(
      (await send(`/api/session/${session}/model`, owner, { model: { providerID: "vector", id: laguna.id } })).status,
    ).toBe(204)
    const v2 = await send(`/api/session/${session}/prompt`, guest, { prompt: { text: "hello" }, resume: false })
    expect(v2.status).toBe(403)
    expect(((await v2.json()) as { message: string }).message).toBe(FREE_MODEL_TRAINING_OWNER_ONLY)
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await consent.setTrainingConsent(false)
    await rm(cache, { force: true })
  }
}, 60_000)
