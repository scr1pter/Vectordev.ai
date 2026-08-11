import { afterEach, describe, expect, test } from "bun:test"
import type { ApiRequest, ApiResponse } from "../api/_lib/http"
import activate from "../api/billing/activate"
import checkout from "../api/billing/checkout"
import config from "../api/billing/config"
import status from "../api/billing/status"

const billingEnvironment = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "VECTOR_LICENSE_SECRET",
  "RESEND_API_KEY",
  "VECTOR_PURCHASE_EMAIL_FROM",
] as const

const original = Object.fromEntries(billingEnvironment.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of billingEnvironment) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function invoke(
  handler: (request: ApiRequest, response: ApiResponse) => Promise<void>,
  request: Partial<ApiRequest>,
) {
  return new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
    const headers: Record<string, string> = {}
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value)
        return this
      },
      end(value?: string) {
        let body: unknown
        try {
          body = value ? JSON.parse(value) : undefined
        } catch {
          body = value
        }
        resolve({ status: this.statusCode, headers, body })
        return this
      },
    } as unknown as ApiResponse
    void handler(request as ApiRequest, response).catch(reject)
  })
}

function disableBilling() {
  for (const key of billingEnvironment) delete process.env[key]
}

describe("Vector billing API", () => {
  test("reports that paid billing is unavailable until every production credential exists", async () => {
    disableBilling()
    const result = await invoke(config, { method: "GET" })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      available: false,
      priceUsd: 99,
      interval: "year",
      activeDevices: 1,
      plans: [
        { id: "annual", priceUsd: 99, interval: "year", graceDays: 0 },
        { id: "monthly", priceUsd: 10, interval: "month", graceDays: 3 },
      ],
    })
  })

  test("requires explicit agreement before opening Stripe Checkout", async () => {
    disableBilling()
    const result = await invoke(checkout, { method: "POST", body: { email: "buyer@example.com" } })

    expect(result.status).toBe(400)
    expect(result.body).toEqual({
      error: { code: "TERMS_REQUIRED", message: "Accept the license and subscription terms to continue." },
    })
  })

  test("fails clearly rather than creating a partial checkout when billing is not configured", async () => {
    disableBilling()
    const result = await invoke(checkout, {
      method: "POST",
      body: { email: "buyer@example.com", termsAccepted: true },
    })

    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ error: { code: "BILLING_NOT_CONFIGURED" } })
  })

  test("rejects unknown plans without disturbing the annual default", async () => {
    disableBilling()
    const result = await invoke(checkout, {
      method: "POST",
      body: { email: "buyer@example.com", termsAccepted: true, plan: "weekly" },
    })

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ error: { code: "PLAN_INVALID" } })
  })

  test("rejects malformed activation and status requests before contacting Stripe", async () => {
    disableBilling()
    const activation = await invoke(activate, { method: "POST", body: {} })
    const validation = await invoke(status, { method: "POST", body: {} })

    expect(activation.status).toBe(400)
    expect(activation.body).toMatchObject({ error: { code: "LICENSE_INVALID" } })
    expect(validation.status).toBe(400)
    expect(validation.body).toMatchObject({ error: { code: "ACTIVATION_INVALID" } })
  })
})
