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
      hooks: [hookWithAuth("acme-gateway")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "acme-gateway", name: "acme-gateway" }])
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
      hooks: [hookWithAuth("acme-gateway"), hookWithAuth("acme-gateway")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "acme-gateway", name: "acme-gateway" }])
  })

  test("respects disabled_providers", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("acme-gateway")],
      existingProviders: {},
      disabled: new Set(["acme-gateway"]),
      providerNames: {},
    })
    expect(result).toEqual([])
  })

  test("respects enabled_providers when provider is absent", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("acme-gateway")],
      existingProviders: {},
      disabled: new Set(),
      enabled: new Set(["anthropic"]),
      providerNames: {},
    })
    expect(result).toEqual([])
  })

  test("includes provider when in enabled set", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("acme-gateway")],
      existingProviders: {},
      disabled: new Set(),
      enabled: new Set(["acme-gateway"]),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "acme-gateway", name: "acme-gateway" }])
  })

  test("resolves name from providerNames", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("acme-gateway")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: { "acme-gateway": "Local Models" },
    })
    expect(result).toEqual([{ id: "acme-gateway", name: "Local Models" }])
  })

  test("falls back to id when no name configured", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("acme-gateway")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "acme-gateway", name: "acme-gateway" }])
  })

  test("skips hooks without auth", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithoutAuth(), hookWithAuth("acme-gateway"), hookWithoutAuth()],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "acme-gateway", name: "acme-gateway" }])
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

test("explicit plugin providers are listed when enabled", () => {
  expect(
    resolvePluginProviders({
      hooks: [hookWithAuth("unsupported-fixture")],
      existingProviders: {},
      disabled: new Set(),
      enabled: new Set(["unsupported-fixture"]),
      providerNames: { "unsupported-fixture": "Unknown" },
    }),
  ).toEqual([{ id: "unsupported-fixture", name: "Unknown" }])
})
