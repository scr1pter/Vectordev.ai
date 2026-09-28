import { expect, test } from "bun:test"
import { providerEnabled, providerRuntimeEnabled, providerUsable, renamedModel } from "../src/provider-policy"

test("runtime plugin presentation does not enable the built-in Copilot gate", () => {
  expect(providerEnabled("github-copilot")).toBe(false)
  expect(providerRuntimeEnabled("github-copilot")).toBe(false)
  expect(providerUsable("github-copilot", { source: "config", options: { baseURL: "https://example.test" } })).toBe(
    false,
  )
  expect(providerRuntimeEnabled("github-copilot", { options: { vectorOAuthPlugin: "a".repeat(64) } })).toBe(true)
  expect(providerUsable("github-copilot", { options: { vectorOAuthPlugin: "a".repeat(64) } })).toBe(true)
  expect(providerEnabled("github-copilot")).toBe(false)
})

test("missing or malformed runtime approval markers cannot expose paused providers", () => {
  for (const value of [undefined, null, true, 1, "", "approved", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    expect(providerRuntimeEnabled("github-copilot", { options: { vectorOAuthPlugin: value } })).toBe(false)
    expect(providerUsable("github-copilot", { options: { vectorOAuthPlugin: value } })).toBe(false)
  }
  expect(providerUsable("openai")).toBe(true)
  expect(providerUsable("unlisted-provider")).toBe(false)
  expect(providerUsable("my-company-gateway", { source: "config" })).toBe(true)
})

test("a saved Kimi For Coding model follows the provider it was renamed to", () => {
  expect(renamedModel({ providerID: "kimi-for-coding", modelID: "k3", variant: "high" })).toEqual({
    providerID: "kimi-code-plan-cn",
    modelID: "k3",
    variant: "high",
  })
  const current = { providerID: "anthropic", modelID: "claude-sonnet-4" }
  expect(renamedModel(current)).toBe(current)
})
