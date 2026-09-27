import { expect, test } from "bun:test"
import { providerNoticeTracker, unavailableModel } from "@vectordevai/schema/provider-unavailable"

// A supported provider that is loaded but not connected, so its saved model cannot be used.
const missing = { providerID: "openai", modelID: "saved" }
const live = { providerID: "anthropic", modelID: "claude-sonnet-4" }
// A provider an earlier version shipped that this one neither supports nor loads.
const retired = { providerID: "retired-gateway", modelID: "included-model" }
const valid = (model: { providerID: string }) => model.providerID === "anthropic"
const loaded = (providerID: string) => providerID === "anthropic" || providerID === "openai"

test("saved, configured and recent missing preferences report the skipped model", () => {
  expect(unavailableModel([missing, live], valid, loaded)).toEqual(missing)
  expect(unavailableModel([undefined, missing, live], valid, loaded)).toEqual(missing)
  expect(unavailableModel([undefined, undefined, missing, live], valid, loaded)).toEqual(missing)
  expect(unavailableModel([missing], valid, loaded)).toEqual(missing)
  expect(unavailableModel([], valid, loaded)).toBeUndefined()
})

test("a valid higher-priority selection does not warn about an unused stale preference", () => {
  expect(unavailableModel([live, missing], valid, loaded)).toBeUndefined()
})

test("a saved model from a retired provider falls back without a notice", () => {
  expect(unavailableModel([retired, live], valid, loaded)).toBeUndefined()
  expect(unavailableModel([retired], valid, loaded)).toBeUndefined()
  expect(unavailableModel([retired, missing, live], valid, loaded)).toEqual(missing)
  // A provider loaded from the user's configuration is not retired, even outside the supported set.
  expect(unavailableModel([retired, live], valid, (providerID) => providerID === retired.providerID)).toEqual(retired)
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
