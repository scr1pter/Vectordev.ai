import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash } from "node:crypto"
import { createServer, request } from "node:http"
import { renderSocialCard } from "../../../api/_lib/social-card"
import handler from "../../../api/og"
import { MAX_TITLE_LENGTH, socialCardImage, STATIC_SOCIAL_IMAGE, validSocialTitle } from "../src/lib/social-card"

test("social metadata is opt-in, uses a fixed Vector origin and falls back for unsupported titles", () => {
  expect(socialCardImage("Install Vector", false)).toBe(STATIC_SOCIAL_IMAGE)
  expect(socialCardImage("Install Vector", true)).toBe("https://vectordev.ai/api/og?title=Install%20Vector")
  expect(socialCardImage("Plans — Vector’s docs", true)).toBe(
    "https://vectordev.ai/api/og?title=Plans%20-%20Vector's%20docs",
  )
  for (const title of ["", "中文", "Emoji 🚀", "x".repeat(MAX_TITLE_LENGTH + 1), "hello\nworld"])
    expect(socialCardImage(title, true)).toBe(STATIC_SOCIAL_IMAGE)
  expect(socialCardImage("<img src='https://example.test'>", true)).not.toContain("?url=")
  for (const title of ["", " x", "x ", "\0", "\n", "\t", "é", "🚀", "x".repeat(121)])
    expect(validSocialTitle(title)).toBe(false)
})

test("actual renderer creates distinct bounded 1200x630 PNGs, including the longest plain-text title", async () => {
  const images = await Promise.all([
    renderSocialCard("Install Vector"),
    renderSocialCard("Review your changes"),
    renderSocialCard("W".repeat(MAX_TITLE_LENGTH)),
    renderSocialCard(Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33)).join("")),
    renderSocialCard("<img src='https://example.test/never-fetch'> & ${text}"),
  ])
  for (const image of images) {
    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(image.readUInt32BE(16)).toBe(1200)
    expect(image.readUInt32BE(20)).toBe(630)
    expect(image.byteLength).toBeLessThan(2_000_000)
    expect(image.byteLength).toBeGreaterThan(5_000)
  }
  expect(new Set(images.map((image) => createHash("sha256").update(image).digest("hex"))).size).toBe(5)
  await expect(renderSocialCard("🚀")).rejects.toThrow("Invalid social card title")
}, 20_000)

integrationTests()

function integrationTests() {
  const url = process.env.VECTOR_TEST_REDIS_URL
  if (!url) {
    test.skip("social-card HTTP/rate tests require explicit disposable VECTOR_TEST_REDIS_URL", () => {})
    return
  }
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("Use disposable loopback Redis")
  const redis = new RedisClient(url, { enableOfflineQueue: false })
  const keys = new Set<string>()
  const state = { origin: "", unavailable: false }
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (state.unavailable) return new Response(null, { status: 503 })
      expect(request.headers.get("authorization")).toBe("Bearer social-card-fixture")
      const command = (await request.json()) as string[]
      expect(command[0]).toBe("EVAL")
      keys.add(command[3]!)
      return Response.json({ result: await redis.send(command[0]!, command.slice(1)) })
    },
  })
  const server = createServer((request, response) => void handler(request, response))
  const names = ["VECTOR_OG_ENABLED", "VECTOR_ABUSE_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN"]
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]))
  beforeAll(async () => {
    await redis.connect()
    Object.assign(process.env, { KV_REST_API_URL: upstream.url.origin, KV_REST_API_TOKEN: "social-card-fixture" })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Bind failed")
    state.origin = `http://127.0.0.1:${address.port}`
  })
  beforeEach(() => {
    process.env.VECTOR_OG_ENABLED = "true"
    process.env.VECTOR_ABUSE_SECRET = `social-card-fixture-${crypto.randomUUID()}`
    state.unavailable = false
  })
  afterAll(async () => {
    server.closeAllConnections()
    server.close()
    upstream.stop(true)
    if (keys.size) await redis.send("DEL", [...keys])
    redis.close()
    names.forEach((key) => (previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key])))
  })
  const send = (path = "/api/og?title=Install%20Vector", method = "GET") => fetch(state.origin + path, { method })

  test("actual HTTP route is optional and produces a public bounded PNG with caching and no-referrer", async () => {
    process.env.VECTOR_OG_ENABLED = "false"
    const disabled = await send()
    expect(disabled.status).toBe(404)
    expect(disabled.headers.get("cache-control")).toBe("no-store")
    await disabled.body?.cancel()
    process.env.VECTOR_OG_ENABLED = "true"
    const response = await send()
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=86400, no-transform")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("x-ratelimit-limit")).toBe("30")
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength)
    expect(bytes.readUInt32BE(16)).toBe(1200)
    expect(bytes.readUInt32BE(20)).toBe(630)
  })

  test("query/body/method bounds reject render overrides and rate protection fails closed", async () => {
    for (const path of [
      "/api/og",
      "/api/og?title=",
      "/api/og?title=x&title=y",
      "/api/og?title=x&url=https://example.test",
      "/api/og?title=x&width=999999",
      "/api/og?title=" + "x".repeat(121),
      "/api/og?title=%0A",
      "/api/og?title=%F0%9F%9A%80",
      "/api/og?title=" + "x".repeat(1_025),
    ]) {
      const response = await send(path)
      expect(response.status).toBe(400)
      expect(response.headers.get("cache-control")).toBe("no-store")
      await response.body?.cancel()
    }
    const bodyStatus = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        state.origin + "/api/og?title=Vector",
        { method: "GET", headers: { "content-length": "1" } },
        (response) => {
          response.resume()
          response.on("end", () => resolve(response.statusCode!))
        },
      )
      outgoing.on("error", reject)
      outgoing.end("x")
    })
    expect(bodyStatus).toBe(400)
    const post = await send(undefined, "POST")
    expect(post.status).toBe(405)
    await post.body?.cancel()
    state.unavailable = true
    const unavailable = await send()
    expect(unavailable.status).toBe(503)
    expect(await unavailable.text()).not.toContain("social-card-fixture")
  })

  test("an existing distributed limit denies rendering until the persistent counter expires", async () => {
    const response = await send()
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    const counter = [...keys].at(-1)!
    await redis.send("SET", [counter, "30", "EX", "60"])
    const limited = await send()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(limited.headers.get("cache-control")).toBe("no-store")
    await limited.body?.cancel()
  })
}
