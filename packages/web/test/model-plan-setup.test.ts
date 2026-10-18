import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { modelPlanPortalConfiguration, modelPlanWebhook } from "../scripts/model-plan-setup"

// A local stand-in for Stripe that keeps idempotency keys for a day, as Stripe does, so a repeated key replays the
// first answer even after the object it created is gone.
const stripe = {
  endpoints: [] as Record<string, unknown>[],
  configurations: [] as Record<string, unknown>[],
  idempotency: new Map<string, Record<string, unknown>>(),
  created: 0,
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    expect(request.headers.get("authorization")).toBe("Bearer sk_test_fixture")
    const body = request.method === "POST" ? new URLSearchParams(await request.text()) : new URLSearchParams()
    const list = (values: Record<string, unknown>[]) => {
      const after = url.searchParams.get("starting_after")
      const start = after ? values.findIndex((value) => value.id === after) + 1 : 0
      const limit = Number(url.searchParams.get("limit") ?? 10)
      return Response.json({ data: values.slice(start, start + limit), has_more: start + limit < values.length })
    }
    const replay = request.headers.get("idempotency-key")
    if (replay && stripe.idempotency.has(replay)) return Response.json(stripe.idempotency.get(replay))
    const remember = (value: Record<string, unknown>) => {
      if (replay) stripe.idempotency.set(replay, value)
      return Response.json(value)
    }
    if (url.pathname === "/v1/webhook_endpoints" && request.method === "GET") return list(stripe.endpoints)
    if (url.pathname === "/v1/webhook_endpoints") {
      stripe.created += 1
      const endpoint = {
        id: `we_${stripe.created}`,
        url: body.get("url"),
        enabled_events: [...body.entries()]
          .filter(([key]) => key.startsWith("enabled_events"))
          .map(([, value]) => value),
      }
      stripe.endpoints.push(endpoint)
      return remember({ ...endpoint, secret: `whsec_${stripe.created}` })
    }
    if (url.pathname.startsWith("/v1/webhook_endpoints/")) {
      const endpoint = stripe.endpoints.find((value) => value.id === url.pathname.split("/").at(-1))
      if (!endpoint) return new Response(null, { status: 404 })
      Object.assign(endpoint, Object.fromEntries(body))
      return Response.json(endpoint)
    }
    if (url.pathname === "/v1/billing_portal/configurations" && request.method === "GET")
      return list(stripe.configurations.filter((value) => value.active))
    if (url.pathname === "/v1/billing_portal/configurations") {
      stripe.created += 1
      const configuration = {
        id: `bpc_${stripe.created}`,
        active: true,
        metadata: { vector_codium: body.get("metadata[vector_codium]") },
        features: { subscription_update: { enabled: body.get("features[subscription_update][enabled]") === "true" } },
      }
      stripe.configurations.push(configuration)
      return remember(configuration)
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  },
})
const fetcher: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected network destination ${url.origin}`)
    return fetch(new URL(url.pathname + url.search, server.url), init)
  },
  { preconnect: fetch.preconnect },
)
const previous = process.env.STRIPE_SECRET_KEY
const webhook = "https://codium-test.example.test/api/model-plans/webhook"

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture"
  stripe.endpoints = []
  stripe.configurations = []
  stripe.idempotency.clear()
  stripe.created = 0
})
afterAll(() => {
  server.stop(true)
  delete process.env.STRIPE_SECRET_KEY
  if (previous !== undefined) process.env.STRIPE_SECRET_KEY = previous
})

describe("the Codium Stripe setup", () => {
  test("a webhook deleted and set up again the same day gets a new endpoint and a working secret", async () => {
    expect(await modelPlanWebhook(webhook, fetcher)).toMatchObject({ id: "we_1", created: true, secret: "whsec_1" })
    // The owner deletes the endpoint in the dashboard and runs the script again within Stripe's idempotency window.
    stripe.endpoints = []
    expect(await modelPlanWebhook(webhook, fetcher)).toMatchObject({ id: "we_2", created: true, secret: "whsec_2" })
    expect(stripe.endpoints.map((value) => value.id)).toEqual(["we_2"])
  })

  test("an existing webhook past the first page is found, not registered twice", async () => {
    stripe.endpoints = Array.from({ length: 150 }, (_, index) => ({
      id: `we_other${index}`,
      url: `https://other.example.test/hooks/${index}`,
      enabled_events: ["*"],
    }))
    stripe.endpoints.push({ id: "we_codium", url: webhook, enabled_events: ["checkout.session.completed"] })
    const found = await modelPlanWebhook(webhook, fetcher)
    expect(found).toMatchObject({ id: "we_codium", created: false })
    expect(found.created === false && found.missing).toContain("invoice.paid")
    expect(stripe.endpoints).toHaveLength(151)
  })

  test("a new preview bypass secret updates the webhook's address and keeps its signing secret", async () => {
    await modelPlanWebhook(`${webhook}?x-vercel-protection-bypass=old`, fetcher)
    expect(await modelPlanWebhook(`${webhook}?x-vercel-protection-bypass=new`, fetcher)).toMatchObject({
      id: "we_1",
      created: false,
    })
    expect(stripe.endpoints).toEqual([expect.objectContaining({ url: `${webhook}?x-vercel-protection-bypass=new` })])
  })

  test("the portal configuration is reused on every later run, not only within a day", async () => {
    expect(await modelPlanPortalConfiguration(fetcher)).toEqual({ id: "bpc_1", created: true })
    // A day later the idempotency key has lapsed; the metadata mark still finds the first configuration.
    stripe.idempotency.clear()
    expect(await modelPlanPortalConfiguration(fetcher)).toEqual({ id: "bpc_1", created: false })
    expect(stripe.configurations).toHaveLength(1)
    // A configuration someone switched plan changes on for is refused, not used.
    stripe.configurations[0]!.features = { subscription_update: { enabled: true } }
    await expect(modelPlanPortalConfiguration(fetcher)).rejects.toThrow("Turn plan switching off")
  })
})
