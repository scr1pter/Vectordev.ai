import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FreeModels } from "../src/free-models"
import { VectorAccount } from "../src/vector-account"
import { FREE_MODEL_FALLBACKS, FREE_MODELS_DISCLOSURE } from "@vectordevai/schema/free-model"
import {
  FREE_MODEL_TRAINING_BLOCKED,
  FREE_MODEL_UNLISTED,
  FREE_MODEL_UNREVIEWED_BLOCKED,
  FREE_MODELS_SIGN_IN,
} from "../src/free-model-choice"
import { freeModelRequest } from "../src/free-model-request"

const enabled = { enabled: true, updatedAt: 123, models: [...FREE_MODEL_FALLBACKS.slice(0, 2)] }
const off = { enabled: false, updatedAt: 0, models: [] }

test("first-run failure stays OFF, a network failure keeps the last catalog served, explicit OFF clears it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-free-models-"))
  try {
    const file = path.join(root, "catalog.json")
    const offline = () => Promise.reject(new Error("offline"))
    expect(await FreeModels.createClient({ file, request: offline }).catalog()).toEqual(off)
    expect(await FreeModels.createClient({ file, request: async () => Response.json(enabled) }).catalog()).toEqual(
      enabled,
    )
    expect(await FreeModels.createClient({ file, request: offline }).catalog()).toEqual(enabled)
    expect(await FreeModels.createClient({ file, request: async () => Response.json(off) }).catalog()).toEqual(off)
    expect(await FreeModels.createClient({ file, request: offline }).catalog()).toEqual(off)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(off)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a refusing answer, or a last catalog without models, never lists models whose prompts would fail", async () => {
  // Root cause 6 (17 Oct 2026): a client that last saw ON fell back to a built-in list on vectordev.ai's 503, so the
  // picker listed models while the shared chat refused every prompt. An empty ON answer (15 Oct) did the same.
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-free-models-refused-"))
  try {
    const file = path.join(root, "catalog.json")
    const refused = async () => Response.json({ error: { code: "FREE_MODELS_CATALOG_MISSING" } }, { status: 503 })
    await FreeModels.createClient({ file, request: async () => Response.json(enabled) }).catalog()
    expect(await FreeModels.createClient({ file, request: refused }).catalog()).toEqual(off)
    // The refusal is not saved: once vectordev.ai answers again the catalog returns.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(enabled)
    await writeFile(file, JSON.stringify({ enabled: true, updatedAt: 1, models: [] }))
    expect(
      await FreeModels.createClient({ file, request: () => Promise.reject(new Error("offline")) }).catalog(),
    ).toEqual(off)
    expect(
      FREE_MODEL_FALLBACKS.every((model) => model.providers.every((item) => item.dataPolicy === "no-training")),
    ).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the catalog request declares that this client labels may-train models and asks first", () => {
  expect(new URL(FreeModels.CATALOG_URL).searchParams.get("disclosure")).toBe(FREE_MODELS_DISCLOSURE)
})

test("a catalog that turns on after a cached OFF notifies its subscribers, and an unchanged one does not", async () => {
  // Root cause 5 (17 Oct 2026): provider state built from a cached OFF answer was never rebuilt when the catalog
  // turned on, so free models stayed hidden for the whole app session.
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-free-models-changes-"))
  try {
    const file = path.join(root, "catalog.json")
    await writeFile(file, JSON.stringify(off))
    const replies = [enabled, enabled, off]
    const client = FreeModels.createClient({ file, wait: 60_000, request: async () => Response.json(replies.shift()) })
    const seen: boolean[] = []
    const unsubscribe = client.subscribe((catalog) => seen.push(catalog.enabled))
    expect(await client.catalog()).toEqual(off)
    expect(await client.catalog(true)).toEqual(enabled)
    await client.catalog(true)
    expect(seen).toEqual([true])
    await client.catalog(true)
    expect(seen).toEqual([true, false])
    unsubscribe()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the one-time training acceptance is remembered in a file every reader shares, and can be withdrawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-free-models-consent-"))
  try {
    const consentFile = path.join(root, "state", "consent.json")
    const engine = FreeModels.createClient({ consentFile })
    const cli = FreeModels.createClient({ consentFile })
    expect(await engine.trainingConsent()).toBe(false)
    expect(await cli.setTrainingConsent(true)).toBe(true)
    // A running engine sees an acceptance recorded elsewhere on its next request.
    expect(await engine.trainingConsent()).toBe(true)
    expect(JSON.parse(await readFile(consentFile, "utf8"))).toMatchObject({ version: 1, training: true })
    expect(await cli.setTrainingConsent(false)).toBe(false)
    expect(await engine.trainingConsent()).toBe(false)
    // Anything else in the file is not an acceptance.
    await mkdir(path.dirname(consentFile), { recursive: true })
    for (const text of ["{}", "true", '{"version":1,"training":false,"acceptedAt":1}', "not json"]) {
      await writeFile(consentFile, text)
      expect(await engine.trainingConsent()).toBe(false)
    }
    expect(await FreeModels.createClient().trainingConsent()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "the desktop engine and the terminal read one acceptance, so withdrawing in the terminal stops the desktop app",
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "vector-free-models-home-"))
    try {
      // The desktop engine's environment, as prepareSidecarEnv in packages/desktop/src/main/sidecar.ts sets it: every
      // XDG directory inside the app's own data folder. The terminal runs with none of them set.
      const userData = path.join(home, "Library", "Application Support", "ai.vector.app")
      const desktop = {
        XDG_DATA_HOME: path.join(userData, "xdg-data"),
        XDG_CONFIG_HOME: path.join(userData, "xdg-config"),
        XDG_CACHE_HOME: path.join(userData, "xdg-cache"),
        XDG_STATE_HOME: path.join(userData, "xdg-state"),
        VECTOR_AGENT_CONFIG_DIR: path.join(userData, "config", "vector"),
        VECTOR_APP_NAMESPACE: "vector",
      }
      const module = path.join(import.meta.dir, "..", "src", "free-models.ts")
      const run = async (env: Record<string, string>, action: "accept" | "decline" | "read") => {
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            `const { FreeModels } = await import(${JSON.stringify(module)})
const client = FreeModels.createClient({ consentFile: FreeModels.trainingConsentFile() })
if (process.argv[1] !== "read") await client.setTrainingConsent(process.argv[1] === "accept")
console.log(JSON.stringify({ file: FreeModels.trainingConsentFile(), consent: await client.trainingConsent() }))`,
            action,
          ],
          { env: { PATH: process.env.PATH ?? "", HOME: home, ...env }, stdout: "pipe", stderr: "pipe" },
        )
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
        return JSON.parse(stdout) as { file: string; consent: boolean }
      }
      const accepted = await run({}, "accept")
      expect(await run(desktop, "read")).toEqual(accepted)
      expect(accepted.consent).toBe(true)
      // "vector models --decline-training" in the terminal reaches the desktop app's next request.
      expect((await run({}, "decline")).consent).toBe(false)
      expect(await run(desktop, "read")).toEqual({ file: accepted.file, consent: false })
      // And an acceptance in the desktop app is the terminal's too.
      await run(desktop, "accept")
      expect((await run({}, "read")).consent).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  },
)

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

for (const response of ["silent", "immediate"]) {
  test(`catalog deadline settles and releases its timer in a fresh process with ${response} responses`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { FreeModels } from ${JSON.stringify(new URL("../src/free-models.ts", import.meta.url).href)};
const client = FreeModels.createClient({
  wait: ${response === "silent" ? 20 : 60_000},
  request: ${response === "silent" ? "() => new Promise(() => {})" : `async () => Response.json(${JSON.stringify(off)})`},
});
console.log(JSON.stringify(await client.catalog()));`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      expect(stdout.trim()).toBe(JSON.stringify(off))
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
    }
  }, 15_000)
}

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
    trainingConsent: async () => false,
    guest: async () => false,
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

test("a Vector selection stays on the shared allowance with an OpenRouter key stored; an OpenRouter one uses that key", async () => {
  // The owner's words of 17 October 2026: Vector's account serves the free models "no matter who uses" them.
  const route = {
    provider: "vector" as const,
    modelID: enabled.models[0].id,
    catalog: async () => enabled,
    forKey: async () => enabled.models,
    credential: async (provider: string) => (provider === "openrouter" ? "own-key" : "vct_shared"),
    trainingConsent: async () => false,
    guest: async () => false,
  }
  expect(await FreeModels.resolveRoute(route)).toMatchObject({
    url: FreeModels.SHARED_CHAT_URL,
    key: "vct_shared",
    source: "shared",
  })
  // The user's own account is never read for a shared choice, so its privacy settings cannot refuse one.
  expect(
    await FreeModels.resolveRoute({
      ...route,
      forKey: async () => {
        throw new Error("the own account was read")
      },
    }),
  ).toMatchObject({ url: FreeModels.SHARED_CHAT_URL, key: "vct_shared" })
  // Nor does a shared choice quietly move to the user's own key when the shared catalog is off.
  await expect(FreeModels.resolveRoute({ ...route, catalog: async () => off })).rejects.toThrow("unavailable")

  const own = { ...route, provider: "openrouter" as const }
  expect(await FreeModels.resolveRoute(own)).toMatchObject({
    url: FreeModels.OPENROUTER_CHAT_URL,
    key: "own-key",
    source: "openrouter",
  })
  await expect(FreeModels.resolveRoute({ ...own, forKey: async () => [] })).rejects.toThrow("privacy settings")
  expect(await FreeModels.resolveRoute({ ...own, catalog: async () => off })).toMatchObject({
    url: FreeModels.OPENROUTER_CHAT_URL,
    key: "own-key",
  })
  await expect(
    FreeModels.resolveRoute({
      ...own,
      catalog: async () => off,
      credential: async (provider) => (provider === "vector" ? "vct_shared" : undefined),
    }),
  ).rejects.toThrow("unavailable")
})

test("without an OpenRouter key of the user's own, every free model runs on the shared allowance, or asks to sign in to Vector", async () => {
  // The owner's decision of 17 October 2026: the shared allowance is the free path for every signed-in account.
  const route = {
    provider: "openrouter" as const,
    modelID: enabled.models[0].id,
    catalog: async () => enabled,
    forKey: async () => [],
    credential: async (provider: string) => (provider === "vector" ? "vct_shared" : undefined),
    trainingConsent: async () => false,
    guest: async () => false,
  }
  // A model chosen while an OpenRouter account was connected now runs on the shared allowance.
  expect(await FreeModels.resolveRoute(route)).toMatchObject({ url: FreeModels.SHARED_CHAT_URL, key: "vct_shared" })
  // Signed out, Vector asks for a Vector sign-in, never an OpenRouter account.
  for (const provider of ["vector", "openrouter"] as const)
    await expect(FreeModels.resolveRoute({ ...route, provider, credential: async () => undefined })).rejects.toThrow(
      new Error(FREE_MODELS_SIGN_IN),
    )
  // A name that is not a free model ID, such as one configured under another name, is never sent.
  await expect(FreeModels.resolveRoute({ ...route, modelID: "alias-laguna" })).rejects.toThrow(
    new Error(FREE_MODEL_UNLISTED),
  )
})

test("shared requests carry the disclosure always and the acceptance only once given; personal ones carry neither", async () => {
  const route = {
    provider: "vector" as const,
    modelID: enabled.models[0].id,
    catalog: async () => enabled,
    forKey: async () => enabled.models,
    credential: async (provider: string) => (provider === "vector" ? "vct_shared" : undefined),
    guest: async () => false,
  }
  expect((await FreeModels.resolveRoute({ ...route, trainingConsent: async () => false })).headers).toEqual({
    "x-vector-free-model-disclosure": FREE_MODELS_DISCLOSURE,
  })
  expect(await FreeModels.resolveRoute({ ...route, trainingConsent: async () => true })).toMatchObject({
    trainingConsent: true,
    headers: {
      "x-vector-free-model-disclosure": FREE_MODELS_DISCLOSURE,
      "x-vector-free-model-training-consent": "accepted",
    },
  })
  const personal = await FreeModels.resolveRoute({
    ...route,
    provider: "openrouter",
    credential: async () => "own-key",
    trainingConsent: async () => true,
  })
  expect(personal).toMatchObject({ source: "openrouter", trainingConsent: true, headers: {} })
})

test("a session an invited guest has worked in never carries the owner's acceptance, on either route", async () => {
  const route = {
    provider: "vector" as const,
    modelID: enabled.models[0].id,
    catalog: async () => enabled,
    forKey: async () => enabled.models,
    trainingConsent: async () => true,
    guest: async () => true,
  }
  const shared = await FreeModels.resolveRoute({
    ...route,
    credential: async (provider) => (provider === "vector" ? "vct_shared" : undefined),
  })
  expect(shared).toMatchObject({ source: "shared", trainingConsent: false, guest: true })
  expect(shared.headers).toEqual({ "x-vector-free-model-disclosure": FREE_MODELS_DISCLOSURE })
  expect(
    await FreeModels.resolveRoute({ ...route, provider: "openrouter", credential: async () => "own-key" }),
  ).toMatchObject({
    source: "openrouter",
    trainingConsent: false,
    guest: true,
  })
})

test("a may-train model hidden by the user's OpenRouter privacy settings says which setting to change", async () => {
  const laguna = {
    id: "poolside/laguna-s-2.1:free",
    name: "Poolside: Laguna S 2.1",
    contextLength: 262144,
    maxOutputTokens: 32768,
    providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
  }
  const route = {
    provider: "openrouter" as const,
    modelID: laguna.id,
    catalog: async () => ({ enabled: true, updatedAt: 1, models: [laguna] }),
    forKey: async () => enabled.models,
    credential: async () => "own-key",
    trainingConsent: async () => true,
    guest: async () => false,
  }
  await expect(FreeModels.resolveRoute(route)).rejects.toThrow(FREE_MODEL_TRAINING_BLOCKED)
  expect(FREE_MODEL_TRAINING_BLOCKED).toContain("openrouter.ai/settings/privacy")
  // OpenRouter's own "no endpoints match your data policy" answer becomes the same instruction for a may-train model.
  const policyRefusal = () =>
    Response.json({ error: { message: "No endpoints found matching your data policy", code: 404 } }, { status: 404 })
  const refused = await FreeModels.explainPolicyRefusal(policyRefusal(), "may-train")
  expect(refused.status).toBe(404)
  expect((await refused.json()).error.message).toBe(FREE_MODEL_TRAINING_BLOCKED)
  const other = Response.json({ error: { message: "Model not found" } }, { status: 404 })
  expect(await FreeModels.explainPolicyRefusal(other, "may-train")).toBe(other)
})

test("a refusal of an unreviewed free model is not blamed on the user's OpenRouter privacy settings", async () => {
  // Vector itself sends data_collection "deny" for an unreviewed model, so changing the account's setting cannot help.
  const policyRefusal = () =>
    Response.json({ error: { message: "No endpoints found matching your data policy", code: 404 } }, { status: 404 })
  const unreviewed = await FreeModels.explainPolicyRefusal(policyRefusal(), "unreviewed")
  expect(unreviewed.status).toBe(404)
  const message = (await unreviewed.json()).error.message
  expect(message).toBe(FREE_MODEL_UNREVIEWED_BLOCKED)
  expect(message).not.toContain("privacy settings")
  expect(message).toContain("has not reviewed")
  // A no-training model was never asked to allow training, so OpenRouter's own answer stands.
  const noTraining = policyRefusal()
  expect(await FreeModels.explainPolicyRefusal(noTraining, "no-training")).toBe(noTraining)
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
  for (const key of ["preset", "modalities"])
    expect(() => freeModelRequest({ ...request, [key]: [] }, enabled.models)).toThrow()
  expect(() => freeModelRequest({ ...request, plugins: [{ id: "web" }] }, enabled.models)).toThrow()
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

test("a first run that answered OFF before a slow catalog arrived notifies once the catalog is on", async () => {
  // The first read gives up after the short wait and answers OFF; provider state is built from that answer.
  const reply = Promise.withResolvers<void>()
  const client = FreeModels.createClient({ wait: 20, request: () => reply.promise.then(() => Response.json(enabled)) })
  const seen: boolean[] = []
  client.subscribe((catalog) => seen.push(catalog.enabled))
  expect(await client.catalog()).toEqual(off)
  reply.resolve()
  expect(await client.catalog(true)).toEqual(enabled)
  expect(seen).toEqual([true])
  // A first answer that its caller waited for is not a change.
  const fresh = FreeModels.createClient({ request: async () => Response.json(enabled) })
  const quiet: boolean[] = []
  fresh.subscribe((catalog) => quiet.push(catalog.enabled))
  expect(await fresh.catalog()).toEqual(enabled)
  expect(quiet).toEqual([])
})
