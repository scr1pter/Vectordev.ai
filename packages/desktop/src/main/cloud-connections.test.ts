import { describe, expect, test } from "bun:test"

import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"

describe("cloud connection vault", () => {
  test("round-trips provider credentials with authenticated encryption", () => {
    const key = Buffer.alloc(32, 7)
    const encrypted = encryptCloudCredential("provider-token", key)
    expect(encrypted).not.toContain("provider-token")
    expect(decryptCloudCredential(encrypted, key)).toBe("provider-token")
  })

  test("rejects tampered credentials", () => {
    const key = Buffer.alloc(32, 9)
    const encrypted = encryptCloudCredential("provider-token", key)
    const parts = encrypted.split(".")
    const ciphertext = Buffer.from(parts[3], "base64url")
    ciphertext[0] ^= 1
    const tampered = [parts[0], parts[1], parts[2], ciphertext.toString("base64url")].join(".")
    expect(() => decryptCloudCredential(tampered, key)).toThrow()
  })
})
