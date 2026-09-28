import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FreeModels } from "../src/free-models"
import { VectorAccount } from "../src/vector-account"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { freeModelRequest } from "../src/free-model-request"

const enabled = { enabled: true, updatedAt: 123, models: [...FREE_MODEL_FALLBACKS.slice(0, 2)] }
const off = { enabled: false, updatedAt: 0, models: [] }

test("first-run failure stays OFF, enabled cache allows reviewed fallback, explicit OFF clears it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-free-models-"))
  try {
    const file = path.join(root, "catalog.json")
    const offline = () => Promise.reject(new Error("offline"))
    expect(await FreeModels.createClient({ file, request: offline }).catalog()).toEqual(off)
    expect(await FreeModels.createClient({ file, request: async () => Response.json(enabled) }).catalog()).toEqual(
      enabled,
    )
    expect((await FreeModels.createClient({ file, request: offline }).catalog()).models).toEqual(FREE_MODEL_FALLBACKS)
    expect(await FreeModels.createClient({ file, request: async () => Response.json(off) }).catalog()).toEqual(off)
    expect(await FreeModels.createClient({ file, request: offline }).catalog()).toEqual(off)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(off)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a known OFF catalog answers at once and refreshes in the background", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-free-models-off-"))
  try {
    const file = path.join(root, "catalog.json")
    await writeFile(file, JSON.stringify(off))
    const requests: string[] = []
    const reply = Promise.withResolvers<void>()
    const client = FreeModels.createClient({
      file,
      wait: 60_000,
      request: (url) => {
        requests.push(url)
        return reply.promise.then(() => Response.json(enabled))
      },
    })
    expect(await client.catalog()).toEqual(off)
    expect(await client.forKey("synthetic-secret")).toEqual([])
    expect(requests).toEqual([FreeModels.CATALOG_URL])

    reply.resolve()
    // A forced read joins the refresh still in flight, which settles only after the cache file is written.
    expect(await client.catalog(true)).toEqual(enabled)
    expect(await client.catalog()).toEqual(enabled)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(enabled)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an unknown catalog waits briefly for a silent network, then answers without it", async () => {
  const reply = Promise.withResolvers<void>()
  const client = FreeModels.createClient({ wait: 20, request: () => reply.promise.then(() => Response.json(enabled)) })
  expect(await client.catalog()).toEqual(off)
  reply.resolve()
  expect(await client.catalog(true)).toEqual(enabled)
  expect(await client.catalog()).toEqual(enabled)
})

test("an expired catalog last seen ON is served stale while a slow refresh continues", async () => {
  const real = { enabled: true, updatedAt: 456, models: [{ ...FREE_MODEL_FALLBACKS[0], id: "acme/real:free" }] }
  const clock = { now: 0 }
  const slow = Promise.withResolvers<void>()
  const replies = [Promise.resolve(), slow.promise]
  const client = FreeModels.createClient({
    wait: 20,
    now: () => clock.now,
    request: () => (replies.shift() ?? slow.promise).then(() => Response.json(real)),
  })
  expect(await client.catalog()).toEqual(real)

  clock.now = 10 * 60_000
  expect(await client.catalog()).toEqual(real)
  const route = await FreeModels.resolveRoute({
    provider: "vector",
    modelID: "acme/real:free",
    catalog: () => client.catalog(),
    forKey: async () => [],
    credential: async (provider) => (provider === "vector" ? "vct_placeholder" : undefined),
  })
  expect(route.source).toBe("shared")
  expect(route.models.map((model) => model.id)).toEqual(["acme/real:free"])
  slow.resolve()
})

test("a forced catalog read still waits for the answer", async () => {
  const reply = Promise.withResolvers<Response>()
  const client = FreeModels.createClient({ wait: 20, request: () => reply.promise })
  const forced = client.catalog(true)
  await Bun.sleep(40)
  reply.resolve(Response.json(enabled))
  expect(await forced).toEqual(enabled)
})

test("optional cache creation failures preserve validated results and explicit OFF in memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-free-cache-failure-"))
  try {
    await writeFile(path.join(root, "blocked"), "synthetic non-directory")
    const responses = [enabled, off]
    const client = FreeModels.createClient({
      file: path.join(root, "blocked", "catalog.json"),
      request: async () => Response.json(responses.shift()),
    })
    expect(await client.catalog()).toEqual(enabled)
    expect(await client.catalog(true)).toEqual(off)
    expect(await client.catalog()).toEqual(off)
    expect(responses).toEqual([])
    expect(await readFile(path.join(root, "blocked"), "utf8")).toBe("synthetic non-directory")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed optional cache rename removes the temporary file and keeps the validated response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-free-cache-rename-"))
  try {
    const file = path.join(root, "catalog.json")
    await mkdir(file)
    const client = FreeModels.createClient({ file, request: async () => Response.json(off) })
    expect(await client.catalog()).toEqual(off)
    expect(await readdir(root)).toEqual(["catalog.json"])
    expect(await readdir(file)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("own-key model discovery intersects the curated catalog and excludes paid models", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const client = FreeModels.createClient({
    request: async (url, init) => {
      requests.push({ url, init })
      if (url === FreeModels.CATALOG_URL) return Response.json(enabled)
      return Response.json({
        data: [
          {
            id: enabled.models[0].id,
            pricing: { prompt: "0", completion: "0" },
            supported_parameters: ["tools", "tool_choice"],
          },
          {
            id: enabled.models[1].id,
            pricing: { prompt: "0", completion: "0.01" },
            supported_parameters: ["tools", "tool_choice"],
          },
          {
            id: "unreviewed/model:free",
            pricing: { prompt: "0", completion: "0" },
            supported_parameters: ["tools", "tool_choice"],
          },
        ],
      })
    },
  })
  expect(await client.forKey("synthetic-secret")).toEqual([enabled.models[0]])
  expect(requests[1].url).toBe(`${FreeModels.OPENROUTER_ROOT}/models/user`)
  expect(new Headers(requests[1].init.headers).get("authorization")).toBe("Bearer synthetic-secret")
  expect(requests[1].init.redirect).toBe("error")
})

test("saved shared selection prefers own key and never silently consumes shared allowance after privacy rejection", async () => {
  const route = {
    provider: "vector" as const,
    modelID: enabled.models[0].id,
    catalog: async () => enabled,
    forKey: async () => enabled.models,
    credential: async (provider: string) => (provider === "openrouter" ? "own-key" : "vct_shared"),
  }
  expect(await FreeModels.resolveRoute(route)).toMatchObject({ url: FreeModels.OPENROUTER_CHAT_URL, key: "own-key" })
  await expect(FreeModels.resolveRoute({ ...route, forKey: async () => [] })).rejects.toThrow("privacy settings")
  expect(
    await FreeModels.resolveRoute({
      ...route,
      credential: async (provider) => (provider === "vector" ? "vct_shared" : undefined),
    }),
  ).toMatchObject({ url: FreeModels.SHARED_CHAT_URL, key: "vct_shared" })
  await expect(FreeModels.resolveRoute({ ...route, catalog: async () => off })).rejects.toThrow("unavailable")
})

test("free request guard removes overrides, clamps tokens and forbids paid plugins, media and hosted tools", () => {
  const request = freeModelRequest(
    {
      model: enabled.models[0].id,
      messages: [{ role: "user", content: "hello", cache_control: "ignored" }],
      max_tokens: 999999,
      models: ["paid/model"],
      provider: { max_price: { prompt: 10 } },
      user: "injected",
      web_search_options: {},
      tools: [{ type: "function", function: { name: "read" } }],
    },
    enabled.models,
  )
  expect(request.models).toEqual(enabled.models.map((item) => item.id))
  expect(request.max_tokens).toBe(Math.min(...enabled.models.map((item) => item.maxOutputTokens)))
  expect(request.provider.max_price).toEqual({ prompt: 0, completion: 0, request: 0, image: 0 })
  expect(request.provider.data_collection).toBe("deny")
  expect(request).not.toHaveProperty("user")
  expect(request).not.toHaveProperty("web_search_options")
  expect(request.messages).toEqual([{ role: "user", content: "hello" }])
  for (const key of ["plugins", "preset", "modalities"])
    expect(() => freeModelRequest({ ...request, [key]: [] }, enabled.models)).toThrow()
  expect(() => freeModelRequest({ ...request, model: "paid/model" }, enabled.models)).toThrow()
  expect(() =>
    freeModelRequest(
      {
        ...request,
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image" } }] },
        ],
      },
      enabled.models,
    ),
  ).toThrow()
  expect(() => freeModelRequest({ ...request, tools: [{ type: "web_search" }] }, enabled.models)).toThrow()
})

test("token precedence honors environment, stored Vector credentials, then CLI file; vault failures propagate", async () => {
  const failing = async () => {
    throw new Error("vault unavailable")
  }
  expect(await VectorAccount.resolveVectorToken({ environment: "vct_env", stored: failing, fallback: failing })).toBe(
    "vct_env",
  )
  expect(await VectorAccount.resolveVectorToken({ stored: async () => "vct_stored", fallback: failing })).toBe(
    "vct_stored",
  )
  expect(
    await VectorAccount.resolveVectorToken({ stored: async () => undefined, fallback: async () => "vct_cli" }),
  ).toBe("vct_cli")
  await expect(VectorAccount.resolveVectorToken({ stored: failing, fallback: async () => "vct_cli" })).rejects.toThrow(
    "vault unavailable",
  )
})
