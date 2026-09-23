import { test, expect, describe } from "bun:test"
import { resolvePluginProviders } from "../../src/cli/cmd/providers"
import type { Hooks } from "@vectordevai/plugin"

function hookWithAuth(provider: string): Hooks {
  return {
    auth: {
      provider,
      methods: [],
    },
  }
}

function hookWithoutAuth(): Hooks {
  return {}
}

describe("resolvePluginProviders", () => {
  test("returns plugin providers not in the model catalog", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("lmstudio")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "lmstudio", name: "lmstudio" }])
  })

  test("skips providers already in the model catalog", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("anthropic")],
      existingProviders: { anthropic: {} },
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([])
  })

  test("deduplicates across plugins", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("lmstudio"), hookWithAuth("lmstudio")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "lmstudio", name: "lmstudio" }])
  })

  test("respects disabled_providers", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("lmstudio")],
      existingProviders: {},
      disabled: new Set(["lmstudio"]),
      providerNames: {},
    })
    expect(result).toEqual([])
  })

  test("respects enabled_providers when provider is absent", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("lmstudio")],
      existingProviders: {},
      disabled: new Set(),
      enabled: new Set(["anthropic"]),
      providerNames: {},
    })
    expect(result).toEqual([])
  })

  test("includes provider when in enabled set", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("lmstudio")],
      existingProviders: {},
      disabled: new Set(),
      enabled: new Set(["lmstudio"]),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "lmstudio", name: "lmstudio" }])
  })

  test("resolves name from providerNames", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("lmstudio")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: { lmstudio: "Local Models" },
    })
    expect(result).toEqual([{ id: "lmstudio", name: "Local Models" }])
  })

  test("falls back to id when no name configured", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("lmstudio")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "lmstudio", name: "lmstudio" }])
  })

  test("skips hooks without auth", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithoutAuth(), hookWithAuth("lmstudio"), hookWithoutAuth()],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "lmstudio", name: "lmstudio" }])
  })

  test("returns empty for no hooks", () => {
    const result = resolvePluginProviders({
      hooks: [],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([])
  })
})

test("unknown plugin providers stay unavailable even when explicitly enabled", () => {
  expect(
    resolvePluginProviders({
      hooks: [hookWithAuth("unsupported-fixture")],
      existingProviders: {},
      disabled: new Set(),
      enabled: new Set(["unsupported-fixture"]),
      providerNames: { "unsupported-fixture": "Unknown" },
    }),
  ).toEqual([])
})
