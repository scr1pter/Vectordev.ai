import { afterEach, describe, expect, test } from "bun:test"
import { decryptPlatformValue, encryptPlatformValue, platformConfiguration } from "../api/_lib/platform"

describe("Vector platform vault", () => {
  const originalCurrent = process.env.VECTOR_PLATFORM_SECRET
  const originalPrevious = process.env.VECTOR_PLATFORM_SECRET_PREVIOUS
  const originalProviders = process.env.VECTOR_AUTH_PROVIDERS

  afterEach(() => {
    if (originalCurrent === undefined) delete process.env.VECTOR_PLATFORM_SECRET
    else process.env.VECTOR_PLATFORM_SECRET = originalCurrent
    if (originalPrevious === undefined) delete process.env.VECTOR_PLATFORM_SECRET_PREVIOUS
    else process.env.VECTOR_PLATFORM_SECRET_PREVIOUS = originalPrevious
    if (originalProviders === undefined) delete process.env.VECTOR_AUTH_PROVIDERS
    else process.env.VECTOR_AUTH_PROVIDERS = originalProviders
  })

  test("can read encrypted connections during a controlled key rotation", () => {
    const oldSecret = "old-vector-platform-secret-with-at-least-32-characters"
    const newSecret = "new-vector-platform-secret-with-at-least-32-characters"
    process.env.VECTOR_PLATFORM_SECRET = oldSecret
    const encrypted = encryptPlatformValue({ token: "never-log-this", region: "us-west-2" })

    process.env.VECTOR_PLATFORM_SECRET = newSecret
    process.env.VECTOR_PLATFORM_SECRET_PREVIOUS = oldSecret
    expect(decryptPlatformValue(encrypted)).toEqual({ token: "never-log-this", region: "us-west-2" })
  })

  test("only advertises explicitly enabled OAuth providers", () => {
    process.env.VECTOR_AUTH_PROVIDERS = "GitHub, unknown, google, github"
    expect(platformConfiguration().authProviders).toEqual(["github", "google"])
  })
})
