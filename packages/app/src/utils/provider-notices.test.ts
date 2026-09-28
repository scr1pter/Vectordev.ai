import { expect, test } from "bun:test"
import { providerNoticeTracker, unavailableModel } from "@vectordevai/schema/provider-unavailable"

// A supported provider that is loaded but not connected, so its saved model cannot be used.
const missing = { providerID: "openai", modelID: "saved" }
const live = { providerID: "anthropic", modelID: "claude-sonnet-4" }
// A provider an earlier version shipped that this one neither supports nor loads.
const retired = { providerID: "retired-gateway", modelID: "included-model" }
const valid = (model: { providerID: string }) => model.providerID === "anthropic"
const declared = (providerID: string) => providerID === "anthropic" || providerID === "openai"

test("saved, configured and recent missing preferences report the skipped model", () => {
  expect(unavailableModel([missing, live], valid, declared)).toEqual(missing)
  expect(unavailableModel([undefined, missing, live], valid, declared)).toEqual(missing)
  expect(unavailableModel([undefined, undefined, missing, live], valid, declared)).toEqual(missing)
  expect(unavailableModel([missing], valid, declared)).toEqual(missing)
  expect(unavailableModel([], valid, declared)).toBeUndefined()
})

test("a valid higher-priority selection does not warn about an unused stale preference", () => {
  expect(unavailableModel([live, missing], valid, declared)).toBeUndefined()
})

test("a saved model from a retired provider falls back without a notice", () => {
  expect(unavailableModel([retired, live], valid, declared)).toBeUndefined()
  expect(unavailableModel([retired], valid, declared)).toBeUndefined()
  expect(unavailableModel([retired, missing, live], valid, declared)).toEqual(missing)
  // A provider declared in the user's configuration is not retired, even outside the supported set and
  // even when it failed to load, so the user hears that their model was not used.
  expect(unavailableModel([retired, live], valid, (providerID) => providerID === retired.providerID)).toEqual(retired)
})

test("a saved model under a renamed provider is judged by the provider it was renamed to", () => {
  const renamed = { providerID: "kimi-for-coding", modelID: "k3" }
  const kimi = (model: { providerID: string; modelID: string }) =>
    model.providerID === "kimi-code-plan-cn" && model.modelID === "k3"
  expect(unavailableModel([renamed, live], kimi, declared)).toBeUndefined()
  expect(unavailableModel([renamed, live], valid, declared)).toEqual(renamed)
})

test("notice delivery is once per client scope and cause, including repeated catalog refreshes", () => {
  const take = providerNoticeTracker()
  expect(take("server-a", "credential:openai:sign-in-paused")).toBe(true)
  expect(take("server-a", "credential:openai:sign-in-paused")).toBe(false)
  expect(take("server-b", "credential:openai:sign-in-paused")).toBe(true)
  expect(take("server-a", "credential:openai:disabled")).toBe(true)
  expect(take("server-a", "model:missing/saved:anthropic/claude-sonnet-4")).toBe(true)
  expect(take("server-a", "model:missing/saved:anthropic/claude-sonnet-4")).toBe(false)
  expect(take("server-a", "model:missing/saved:anthropic/claude-opus-4")).toBe(true)
})
