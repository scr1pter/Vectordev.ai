import { describe, expect, test } from "bun:test"
import { legacyPrefix } from "../src/flag/legacy"
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
      const foreign = `${legacyPrefix}${suffix}`
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

  test("ignores other tools' variables that share a security suffix", () => {
    for (const env of [
      { SQL_SERVER_PASSWORD: "secret" },
      { SQL_SERVER_USERNAME: "sa" },
      { S3_PERMISSION: "public-read" },
      { [`${legacyPrefix}SERVER_PASSWORD`.toLowerCase()]: "secret" },
      { [`${legacyPrefix}SERVER_PASSWORD_BACKUP`]: "secret", SERVER_PASSWORD: "secret" },
      { VECTOR_SERVER_PASSWORD: "secret", VECTOR_OTHER_SERVER_PASSWORD: "secret" },
    ])
      expect(() => assertSecurityEnvironment(env)).not.toThrow()
  })
})
