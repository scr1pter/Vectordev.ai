import { describe, expect, test } from "bun:test"
import { FREE_MODEL_POLICY_NOTICE, firstFreeModelPolicyNotice } from "./free-model-policy-notice"

describe("free model policy notice", () => {
  test("shows once per device", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    expect(firstFreeModelPolicyNotice(() => storage)).toBe(true)
    expect(firstFreeModelPolicyNotice(() => storage)).toBe(false)
  })

  test("still shows when storage refuses access", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => undefined,
    }
    expect(firstFreeModelPolicyNotice(() => storage)).toBe(true)
    expect(firstFreeModelPolicyNotice(() => undefined)).toBe(true)
  })

  test("says the providers are not zero data retention", () => {
    expect(FREE_MODEL_POLICY_NOTICE.description).toContain("Not zero data retention")
    expect(FREE_MODEL_POLICY_NOTICE.description).toContain("no-training allowlist")
  })
})
