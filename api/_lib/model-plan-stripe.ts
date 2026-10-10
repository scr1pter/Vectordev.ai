import { createHmac, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { ApiError } from "./http.js"

export const stripeRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

export async function modelPlanStripe(
  path: string,
  input: { method?: "GET" | "POST" | "DELETE"; body?: URLSearchParams; idempotency?: string } = {},
  fetcher: typeof fetch = fetch,
) {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) throw new ApiError(503, "BILLING_UNAVAILABLE", "Billing is temporarily unavailable.")
  const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      "Stripe-Version": "2025-02-24.acacia",
      ...(input.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(input.idempotency ? { "Idempotency-Key": input.idempotency } : {}),
    },
    body: input.body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok || !stripeRecord(body))
    throw new ApiError(502, "BILLING_UPSTREAM", "Billing could not complete this request. Please retry.")
  return body
}

export function verifyModelPlanWebhook(raw: Buffer, signature: string, now = Date.now()) {
  const secret = process.env.STRIPE_MODEL_PLAN_WEBHOOK_SECRET?.trim()
  if (!secret) throw new ApiError(503, "WEBHOOK_UNAVAILABLE", "Billing notifications are not configured.")
  const parts = signature.split(",").map((part) => part.trim().split("="))
  const timestamp = parts.find(([name]) => name === "t")?.[1] ?? ""
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(raw).digest()
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !parts.some(
      ([name, value]) =>
        name === "v1" &&
        typeof value === "string" &&
        /^[a-fA-F0-9]{64}$/.test(value) &&
        timingSafeEqual(Buffer.from(value, "hex"), expected),
    )
  )
    throw new ApiError(400, "WEBHOOK_SIGNATURE", "Invalid billing notification signature.")
  const event = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw.toString("utf8"))
  if (Option.isNone(event) || !stripeRecord(event.value) || typeof event.value.type !== "string")
    throw new ApiError(400, "WEBHOOK_INVALID", "Invalid billing notification.")
  return event.value
}
