import { expect, test } from "bun:test"
import { filterProviderCatalog, SUPPORTED_PROVIDER_IDS } from "@vectordevai/schema/provider-policy"
import { releaseCatalogBody } from "./upload-model-catalog"

test("publishes the exact prepared provider catalog without changing models or ordering", () => {
  const prepared = filterProviderCatalog(
    Object.fromEntries(
      SUPPORTED_PROVIDER_IDS.map((id) => [
        id,
        { models: { example: { id: "example", cost: { input: 1 } } }, id, doc: "https://docs.example.test" },
      ]),
    ),
  )
  const body = JSON.stringify(prepared)
  expect(releaseCatalogBody(prepared)).toBe(body)
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
    const source = { [id]: { id, doc: "https://docs.example.test/client-guide", models: {} } }
    expect(() => releaseCatalogBody(source)).toThrow("prepared with Vector's catalog generator")
    expect(releaseCatalogBody(filterProviderCatalog(source))).toBe(JSON.stringify(filterProviderCatalog(source)))
    expect(source[id].doc).toBe("https://docs.example.test/client-guide")
  }
})

test("rejects an empty or malformed release catalog", () => {
  for (const data of [null, undefined, {}, [], "catalog", 1]) {
    expect(() => releaseCatalogBody(data)).toThrow("nonempty provider object")
  }
})
