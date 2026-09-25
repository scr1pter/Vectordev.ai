import { describe, expect, test } from "bun:test"
import { assertSecurityEnvironment, SecurityConfigurationError } from "../src/flag/security"

describe("security environment migration", () => {
  for (const suffix of [
    "SERVER_PASSWORD",
    "SERVER_USERNAME",
    "SERVER_GUEST_PASSWORD",
    "SERVER_GUEST_USERNAME",
    "PERMISSION",
    "PURE",
    "DISABLE_PROJECT_CONFIG",
    "SHELL_SANDBOX",
  ]) {
    test(`refuses an ignored ${suffix} without exposing its value`, () => {
      const foreign = `PRIOR_${suffix}`
      const current = `VECTOR_${suffix}`
      expect(() => assertSecurityEnvironment({ [foreign]: "private-fixture-value" })).toThrow(
        SecurityConfigurationError,
      )
      expect(() => assertSecurityEnvironment({ [foreign]: "private-fixture-value" })).toThrow(current)
      expect(() => assertSecurityEnvironment({ [foreign]: "private-fixture-value" })).not.toThrow(
        "private-fixture-value",
      )
      expect(() => assertSecurityEnvironment({ [foreign]: "private-fixture-value", [current]: "" })).toThrow(current)
      expect(() => assertSecurityEnvironment({ [foreign]: "private-fixture-value", [current]: "false" })).not.toThrow()
    })
  }

  test("matches foreign suffixes case insensitively and requires a separator", () => {
    expect(() => assertSecurityEnvironment({ prior_server_password: "secret" })).toThrow("VECTOR_SERVER_PASSWORD")
    expect(() =>
      assertSecurityEnvironment({ PRIOR_SERVER_PASSWORD_BACKUP: "secret", SERVER_PASSWORD: "secret" }),
    ).not.toThrow()
    expect(() =>
      assertSecurityEnvironment({ VECTOR_SERVER_PASSWORD: "secret", VECTOR_OTHER_SERVER_PASSWORD: "secret" }),
    ).not.toThrow()
  })
})
