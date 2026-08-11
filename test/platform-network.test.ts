import { afterEach, describe, expect, test } from "bun:test"
import { isPublicIp, resolvePublicUrl } from "../api/_lib/network"
import { evaluateAssertions } from "../api/platform/execute"
import {
  decryptPlatformValue,
  encryptPlatformValue,
  platformConfiguration,
  platformUsageLimits,
} from "../api/_lib/platform"

describe("Vector API network boundary", () => {
  test("blocks local, metadata, private, and documentation-only addresses", async () => {
    for (const address of ["127.0.0.1", "10.10.0.2", "169.254.169.254", "192.168.1.2", "::1", "2001:db8::1"]) {
      expect(isPublicIp(address)).toBe(false)
    }
    await expect(resolvePublicUrl("http://127.0.0.1/private")).rejects.toMatchObject({
      code: "PRIVATE_URL_BLOCKED",
    })
    await expect(resolvePublicUrl("https://metadata.google.internal/latest")).rejects.toMatchObject({
      code: "PRIVATE_URL_BLOCKED",
    })
  })

  test("accepts globally routable IP literals", async () => {
    expect(isPublicIp("1.1.1.1")).toBe(true)
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true)
  })

  test("evaluates only the supported assertion language", () => {
    const assertions = evaluateAssertions(
      "status == 200\nheader:content-type contains json\njson:data.id exists\nrun shell",
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { id: "run_1" } }),
        encoding: "text",
        durationMs: 42,
      },
    )
    expect(assertions.map((item) => [item.pass, item.valid])).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [false, false],
    ])
  })
})

describe("Vector platform limits", () => {
  const original = process.env.VECTOR_API_DAILY_EXECUTION_LIMIT

  afterEach(() => {
    if (original === undefined) delete process.env.VECTOR_API_DAILY_EXECUTION_LIMIT
    else process.env.VECTOR_API_DAILY_EXECUTION_LIMIT = original
  })

  test("uses a bounded server-owned API execution limit", () => {
    process.env.VECTOR_API_DAILY_EXECUTION_LIMIT = "99999999"
    expect(platformUsageLimits().apiExecutionsDaily).toBe(100_000)
    process.env.VECTOR_API_DAILY_EXECUTION_LIMIT = "not-a-number"
    expect(platformUsageLimits().apiExecutionsDaily).toBe(500)
  })
})

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
