import { afterAll, beforeEach, expect, test } from "bun:test"
import {
  currentFreeModelCatalog,
  FREE_MODELS_CATALOG_KEY,
  refreshFreeModelCatalog,
} from "../../../api/_lib/free-models-catalog"
import { freeModelDataPolicy, freeModelInfo } from "../../core/src/free-model-catalog"

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
// Personal-route only: Gemma, for the EEA, Swiss and UK limit in Google's terms.
const gemma = ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"]

beforeEach(() => {
  store.clear()
  Object.assign(process.env, environment)
})
afterAll(() => {
  for (const key of Object.keys(environment)) delete process.env[key]
})

test("the shared allowance serves every free model whose terms allow it, the free router last, and old clients none that may train", async () => {
  // The owner's decision of 17 October 2026: every free OpenRouter model, except those whose terms bar this use.
  const refreshed = await refreshFreeModelCatalog(fetcher, fixture.capturedAt)
  expect(refreshed.models.map((model) => [model.id, freeModelDataPolicy(model)])).toEqual([
    ["cohere/north-mini-code:free", "no-training"],
    ["dots-studio/dots-3-note-preview:free", "no-training"],
    ["xingchen-agi/xing4.0-29b-a4b:free", "no-training"],
    ["liquid/lfm-2.5-2.6b:free", "may-train"],
    ["poolside/laguna-s-2.1:free", "may-train"],
    ["poolside/laguna-xs-2.1:free", "may-train"],
    ["thinkingmachines/inkling-small:free", "may-train"],
    ["thinkingmachines/inkling:free", "may-train"],
    ["openrouter/free", "may-train"],
  ])
  const later = fixture.capturedAt + 1000
  // 1.99.109 reads with the disclosure and receives all of them.
  expect((await currentFreeModelCatalog(fetcher, later, { disclosure: true })).models).toEqual(refreshed.models)
  // 1.99.108 and CLI 1.99.99 read without it: no-training models only, so never the router, which their own catalog
  // check would refuse.
  expect(
    (await currentFreeModelCatalog(fetcher, later, { disclosure: false })).models.map((model) => model.id),
  ).toEqual([
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
    "xingchen-agi/xing4.0-29b-a4b:free",
  ])
})

test("Gemma stays off the shared allowance, so no client of it, old or new, is served it", async () => {
  // Google's Gemini API terms (28 April 2026) let EEA, Swiss and UK users use it only through Paid Services, and the
  // shared allowance does not check where its users are.
  const refreshed = await refreshFreeModelCatalog(fetcher, fixture.capturedAt)
  expect(refreshed.models.filter((model) => gemma.includes(model.id))).toEqual([])
  const later = fixture.capturedAt + 1000
  for (const disclosure of [false, true]) {
    const served = await currentFreeModelCatalog(fetcher, later, { disclosure })
    expect(served.models.filter((model) => gemma.includes(model.id))).toEqual([])
  }
})

test("a stored catalog that lists Gemma is served without it", async () => {
  // A catalog stored before the rule, with its correct reviewed policy, must not keep serving it.
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

test("the owner's refresh instructions expect the counts the refresh gives", async () => {
  // docs/vector/owner-actions/openrouter.md, step 8: an owner reads a correct answer as a failure otherwise.
  const steps = await Bun.file(new URL("../../../docs/vector/owner-actions/openrouter.md", import.meta.url)).text()
  const refreshed = await refreshFreeModelCatalog(fetcher, fixture.capturedAt)
  const noTraining = refreshed.models.filter((model) => freeModelDataPolicy(model) === "no-training")
  expect(steps).toContain(`{"enabled":true,"count":${refreshed.models.length}}`)
  // With may-train endpoints blocked on the account, its own model list leaves only the no-training ones.
  expect(steps).toContain(`With step 1 off, expect \`count: ${noTraining.length}\``)
})
