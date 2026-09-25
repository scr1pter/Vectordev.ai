import { expect, test } from "bun:test"
import { providerNoticeTracker, unavailableModel } from "@vectordevai/schema/provider-unavailable"

const missing = { providerID: "missing", modelID: "saved" }
const live = { providerID: "anthropic", modelID: "claude-sonnet-4" }
const valid = (model: { providerID: string }) => model.providerID === "anthropic"

test("saved, configured and recent missing preferences report the skipped model", () => {
  expect(unavailableModel([missing, live], valid)).toEqual(missing)
  expect(unavailableModel([undefined, missing, live], valid)).toEqual(missing)
  expect(unavailableModel([undefined, undefined, missing, live], valid)).toEqual(missing)
  expect(unavailableModel([missing], valid)).toEqual(missing)
  expect(unavailableModel([], valid)).toBeUndefined()
})

test("a valid higher-priority selection does not warn about an unused stale preference", () => {
  expect(unavailableModel([live, missing], valid)).toBeUndefined()
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
