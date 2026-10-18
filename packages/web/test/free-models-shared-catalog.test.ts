import { afterAll, beforeEach, expect, test } from "bun:test"
import {
  currentFreeModelCatalog,
  FREE_MODELS_CATALOG_KEY,
  refreshFreeModelCatalog,
} from "../../../api/_lib/free-models-catalog"
import { freeModelInfo } from "../../core/src/free-model-catalog"

// Runs without Redis or Valkey, unlike free-models-api.test.ts: an in-memory stand-in for the Upstash REST store
// answers GET and SET, and OpenRouter answers from its public data captured on 17 October 2026.
const fixture: {
  capturedAt: number
  models: { id: string }[]
  endpoints: Record<string, Record<string, unknown>[]>
} = await Bun.file(new URL("../../core/test/fixture/free-model-public-2026-10-17.json", import.meta.url)).json()
const store = new Map<string, string>()
const fetcher = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin === "https://kv.fixture.invalid") {
      const command: (string | number)[] = JSON.parse(String(init?.body))
      if (command[0] === "SET") store.set(String(command[1]), String(command[2]))
      return Response.json({ result: command[0] === "GET" ? (store.get(String(command[1])) ?? null) : "OK" })
    }
    if (url.origin !== "https://openrouter.ai") throw new Error(`Unexpected network destination ${url.origin}`)
    if (url.pathname === "/api/v1/models") return Response.json({ data: fixture.models })
    // The shared account allows every model, so only Vector's own rules can leave one out.
    if (url.pathname === "/api/v1/models/user")
      return Response.json({ data: fixture.models.map((item) => ({ id: item.id })) })
    const listed = /^\/api\/v1\/models\/(.+)\/endpoints$/.exec(url.pathname)?.[1]
    const endpoints = listed ? fixture.endpoints[listed] : undefined
    if (!endpoints) return Response.json({ error: { message: "Not Found" } }, { status: 404 })
    return Response.json({ data: { id: listed, endpoints } })
  },
  { preconnect: fetch.preconnect },
)
const environment = {
  FREE_MODELS_ENABLED: "true",
  KV_REST_API_URL: "https://kv.fixture.invalid",
  KV_REST_API_TOKEN: "fixture-kv-token",
  OPENROUTER_FREE_API_KEY: "fixture-openrouter-key",
}
const gemma = ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"]

beforeEach(() => {
  store.clear()
  Object.assign(process.env, environment)
})
afterAll(() => {
  for (const key of Object.keys(environment)) delete process.env[key]
})

test("Gemma stays off the shared allowance, so no client of it, old or new, is served Gemma", async () => {
  // Google's Gemini API terms (28 April 2026) let EEA, Swiss and UK users use it only through Paid Services, and the
  // shared allowance does not check where its users are. Until the owner decides, Gemma is personal-route only.
  const refreshed = await refreshFreeModelCatalog(fetcher, fixture.capturedAt)
  expect(refreshed.models.map((model) => model.id)).toEqual([
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
    "xingchen-agi/xing4.0-29b-a4b:free",
    "liquid/lfm-2.5-2.6b:free",
    "poolside/laguna-s-2.1:free",
    "poolside/laguna-xs-2.1:free",
    "thinkingmachines/inkling-small:free",
    "thinkingmachines/inkling:free",
  ])
  const later = fixture.capturedAt + 1000
  // 1.99.108 and CLI 1.99.99 read without the disclosure; 1.99.109 reads with it.
  for (const disclosure of [false, true]) {
    const served = await currentFreeModelCatalog(fetcher, later, { disclosure })
    expect(served.models.filter((model) => gemma.includes(model.id))).toEqual([])
  }
})

test("a stored catalog that lists Gemma is served without it", async () => {
  // A catalog stored before the rule, with Gemma's correct reviewed policy, must not keep serving it.
  const models = gemma.flatMap((id) => {
    const model = fixture.models.find((item) => item.id === id)
    const info = model && freeModelInfo(model as never, fixture.endpoints[id] ?? [], { reviewedOnly: true })
    return info ? [info] : []
  })
  expect(models.map((model) => model.id)).toEqual(gemma)
  store.set(FREE_MODELS_CATALOG_KEY, JSON.stringify({ enabled: true, updatedAt: fixture.capturedAt, models }))
  expect(await currentFreeModelCatalog(fetcher, fixture.capturedAt + 1000, { disclosure: true })).toEqual({
    enabled: false,
    updatedAt: fixture.capturedAt,
    models: [],
  })
})
