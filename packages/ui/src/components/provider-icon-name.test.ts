import { expect, test } from "bun:test"
import { GENERIC_PROVIDER_ICON, providerIconName } from "./provider-icon-name"

test("registered provider artwork wins and unknown providers use a neutral icon", () => {
  const names = ["openai", "synthetic", GENERIC_PROVIDER_ICON]
  expect(providerIconName("openai", names)).toBe("openai")
  expect(providerIconName("synthetic", names)).toBe("synthetic")
  expect(providerIconName("missing-provider", names)).toBe(GENERIC_PROVIDER_ICON)
  expect(providerIconName("custom-provider", names)).toBe(GENERIC_PROVIDER_ICON)
})
