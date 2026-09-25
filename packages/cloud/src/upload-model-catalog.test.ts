import { expect, test } from "bun:test"
import { SUPPORTED_PROVIDER_IDS } from "@vectordevai/schema/provider-policy"
import { ModelCatalog } from "@vectordevai/schema/model-catalog"
import { releaseCatalogBody, releaseCatalogText } from "./upload-model-catalog"

test("publishes the exact prepared provider catalog without changing models or ordering", () => {
  const prepared = ModelCatalog.decodeCatalog(
    Object.fromEntries(
      SUPPORTED_PROVIDER_IDS.map((id) => [id, { models: {}, id, name: id, env: [], doc: "https://docs.example.test" }]),
    ),
  )
  const body = JSON.stringify(prepared)
  expect(releaseCatalogBody(prepared)).toBe(body)
  expect(releaseCatalogText(body)).toBe(body)
  expect(JSON.stringify(prepared)).toBe(body)
})

test("rejects unknown catalog providers even when their credentials are present", () => {
  expect(() =>
    releaseCatalogBody({
      openai: { id: "openai", models: {} },
      "unsupported-fixture": { id: "unsupported-fixture", options: { apiKey: "placeholder" }, models: {} },
    }),
  ).toThrow("unsupported or inconsistent provider")
})

test("rejects mismatched or missing catalog identities and malformed provider entries", () => {
  for (const provider of [{ id: "anthropic" }, { models: {} }, null, [], "openai"]) {
    expect(() => releaseCatalogBody({ openai: provider })).toThrow("unsupported or inconsistent provider")
  }
  expect(() => releaseCatalogBody({ OPENAI: { id: "OPENAI" } })).toThrow("unsupported or inconsistent provider")
})

test("rejects snapshots that have not applied the reviewed provider documentation", () => {
  for (const id of ["infer", "pendra", "agentrouter"]) {
    const source = { [id]: { id, name: id, env: [], doc: "https://docs.example.test/client-guide", models: {} } }
    const prepared = ModelCatalog.decodeCatalog(source)
    const wrongDocs = { ...prepared, [id]: { ...prepared[id], doc: source[id].doc } }
    expect(() => releaseCatalogBody(wrongDocs)).toThrow("prepared with Vector's catalog generator")
    expect(releaseCatalogBody(prepared)).toBe(JSON.stringify(prepared))
    expect(source[id].doc).toBe("https://docs.example.test/client-guide")
  }
})

test("rejects an empty or malformed release catalog", () => {
  for (const data of [null, undefined, {}, [], "catalog", 1]) {
    expect(() => releaseCatalogBody(data)).toThrow("nonempty provider object")
  }
})

test("the uploader refuses snapshots that still need schema defaults", () => {
  const source = {
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      models: {
        fixture: {
          id: "fixture",
          name: "Fixture",
          release_date: "2026-01-01",
          attachment: false,
          reasoning: false,
          tool_call: true,
          limit: { context: 1000, output: 100 },
        },
      },
    },
  }
  expect(() => releaseCatalogBody(source)).toThrow("prepared with Vector's catalog generator")
  const prepared = ModelCatalog.decodeCatalog(source)
  expect(prepared.openai.models.fixture.temperature).toBe(false)
  expect(releaseCatalogText(JSON.stringify(prepared))).toBe(JSON.stringify(prepared))
})

test("the uploader preserves reviewed bytes and refuses whitespace rewrites before publication", () => {
  const prepared = ModelCatalog.decodeCatalog({ openai: { id: "openai", name: "OpenAI", env: [], models: {} } })
  const text = JSON.stringify(prepared)
  expect(releaseCatalogText(text)).toBe(text)
  for (const changed of [JSON.stringify(prepared, null, 2), `${text}\n`, ` ${text}`])
    expect(() => releaseCatalogText(changed)).toThrow("exact prepared bytes")
})
