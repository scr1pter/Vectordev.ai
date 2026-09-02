import { afterEach, describe, expect, test } from "bun:test"
import { Readable } from "node:stream"
import type Stripe from "stripe"
import { ApiError, type ApiRequest, type ApiResponse } from "../api/_lib/http"
import { handleWebhook } from "../api/billing/webhook"

const originalSecret = process.env.STRIPE_WEBHOOK_SECRET

afterEach(() => {
  if (originalSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = originalSecret
})

const event = {
  id: "evt_vector",
  type: "checkout.session.completed",
} as Stripe.Event

function request() {
  return Object.assign(Readable.from(["{}"]), {
    method: "POST",
    headers: { "stripe-signature": "verified-signature" },
  }) as unknown as ApiRequest
}

function invoke(handleEvent: (event: Stripe.Event) => Promise<void>) {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_vector"
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {
        return this
      },
      end(value?: string) {
        resolve({ status: this.statusCode, body: value ? JSON.parse(value) : undefined })
        return this
      },
    } as unknown as ApiResponse
    void handleWebhook(request(), response, {
      constructEvent: () => event,
      handleEvent,
    }).catch(reject)
  })
}

describe("Stripe billing webhook", () => {
  test("acknowledges Stripe objects that do not belong to Vector", async () => {
    const result = await invoke(() =>
      Promise.reject(new ApiError(400, "STRIPE_OBJECT_IGNORED", "This subscription does not belong to Vector.")),
    )

    expect(result).toEqual({ status: 200, body: { received: true, ignored: true } })
  })

  test("returns a retryable failure when purchase email cannot be provisioned", async () => {
    const result = await invoke(() =>
      Promise.reject(new ApiError(409, "EMAIL_MISSING", "Stripe did not provide an email for this purchase.")),
    )

    expect(result).toEqual({
      status: 500,
      body: {
        error: {
          code: "WEBHOOK_PROCESSING_FAILED",
          message: "Vector could not process this Stripe event.",
        },
      },
    })
  })

  test("returns a retryable failure for an unexpected provisioning error", async () => {
    const result = await invoke(() => Promise.reject(new Error("Stripe customer update failed")))

    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ error: { code: "WEBHOOK_PROCESSING_FAILED" } })
  })

  test("acknowledges a successfully processed event", async () => {
    const result = await invoke(() => Promise.resolve())

    expect(result).toEqual({ status: 200, body: { received: true } })
  })
})
