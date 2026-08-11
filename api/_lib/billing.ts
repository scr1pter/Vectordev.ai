import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Resend } from "resend"
import Stripe from "stripe"
import { ApiError } from "./http.js"
import {
  claimInstallerDownload,
  claimStripeEvent,
  claimPlatformDevice,
  completeStripeEvent,
  failStripeEvent,
  platformConfiguration,
  releasePlatformDevice,
  subscriptionForUser,
  syncPlatformLicense,
  syncPlatformSubscription,
} from "./platform.js"

export type BillingPlan = "annual" | "monthly"

type BillingPlanDefinition = {
  id: BillingPlan
  name: string
  priceUsdCents: number
  interval: "year" | "month"
  description: string
  renewalText: string
  graceDays: number
  priceEnvironment: "STRIPE_PRICE_ANNUAL" | "STRIPE_PRICE_MONTHLY"
}

const BILLING_PLANS: Record<BillingPlan, BillingPlanDefinition> = {
  annual: {
    id: "annual",
    name: "Vector annual license",
    priceUsdCents: 9_900,
    interval: "year",
    description: "Vector desktop, updates, and one active computer for one year.",
    renewalText: "Renews yearly at $99 until cancelled.",
    graceDays: 0,
    priceEnvironment: "STRIPE_PRICE_ANNUAL",
  },
  monthly: {
    id: "monthly",
    name: "Vector monthly license",
    priceUsdCents: 1_000,
    interval: "month",
    description: "Vector desktop, updates, and one active computer for one month.",
    renewalText: "Renews monthly at $10 until cancelled.",
    graceDays: 3,
    priceEnvironment: "STRIPE_PRICE_MONTHLY",
  },
}

const DEFAULT_PLAN: BillingPlan = "annual"
const OFFLINE_GRACE_DAYS = 7
const DOWNLOAD_TOKEN_SECONDS = 60 * 30
const DAY_SECONDS = 24 * 60 * 60

type StripeCustomer = Stripe.Customer
type StripeSubscription = Stripe.Subscription

export type PublicLicenseStatus = {
  access: boolean
  state: "active" | "canceling" | "grace" | "expired" | "past_due"
  message?: string
  email: string
  expiresAt: string
  graceEndsAt?: string
  cancelAtPeriodEnd: boolean
  plan: BillingPlan
  interval: "year" | "month"
  priceUsd: number
  deviceName?: string
  devicePlatform?: string
  lastFour: string
  offlineGraceDays: number
}

export function publicOrigin() {
  return (process.env.VECTOR_PUBLIC_URL || "https://vectordev.ai").replace(/\/$/, "")
}

export function billingConfiguration() {
  const stripe = Boolean(process.env.STRIPE_SECRET_KEY)
  const webhook = Boolean(process.env.STRIPE_WEBHOOK_SECRET)
  const licenseSecret = (process.env.VECTOR_LICENSE_SECRET ?? "").length >= 32
  const email = Boolean(process.env.RESEND_API_KEY && process.env.VECTOR_PURCHASE_EMAIL_FROM)
  const prices = Object.values(BILLING_PLANS).every((plan) => Boolean(process.env[plan.priceEnvironment]?.trim()))
  const platform = platformConfiguration().adminAvailable
  const downloads = Boolean(
    process.env.VECTOR_INSTALLER_BLOB_TOKEN && process.env.VECTOR_INSTALLER_BLOB_PRIVATE === "true",
  )
  return {
    available: stripe && webhook && licenseSecret && email && prices && platform && downloads,
    stripe,
    webhook,
    licenseSecret,
    email,
    prices,
    platform,
    downloads,
    priceUsd: BILLING_PLANS.annual.priceUsdCents / 100,
    interval: BILLING_PLANS.annual.interval,
    plans: Object.values(BILLING_PLANS).map((plan) => ({
      id: plan.id,
      priceUsd: plan.priceUsdCents / 100,
      interval: plan.interval,
      graceDays: plan.graceDays,
    })),
    activeDevices: 1,
  }
}

function isBillingPlan(value: unknown): value is BillingPlan {
  return value === "annual" || value === "monthly"
}

function requiredBillingPlan(value: unknown) {
  if (value === undefined || value === null || value === "") return BILLING_PLANS[DEFAULT_PLAN]
  if (!isBillingPlan(value)) {
    throw new ApiError(400, "PLAN_INVALID", "Choose the monthly or annual Vector plan.")
  }
  return BILLING_PLANS[value]
}

function requiredPrice(plan: BillingPlanDefinition) {
  const value = process.env[plan.priceEnvironment]?.trim()
  if (!value?.startsWith("price_")) {
    throw new ApiError(503, "BILLING_NOT_CONFIGURED", `Vector's ${plan.id} Stripe price is not configured.`)
  }
  return value
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Vector purchases are not available yet.")
  return value
}

function requiredText(value: unknown, code: string, message: string, maximum = 2_000) {
  if (typeof value !== "string") throw new ApiError(400, code, message)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new ApiError(400, code, message)
  return normalized
}

export function stripeClient() {
  return new Stripe(required("STRIPE_SECRET_KEY"), {
    appInfo: { name: "Vector Licensing", version: "1.0.0", url: publicOrigin() },
  })
}

function licenseSecret() {
  const value = required("VECTOR_LICENSE_SECRET")
  if (value.length < 32) {
    throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Vector licensing is not configured securely.")
  }
  return value
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function signature(value: string) {
  return createHmac("sha256", licenseSecret()).update(value).digest()
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url")
const fromBase64url = (value: string) => Buffer.from(value, "base64url").toString("utf8")

const base32 = (input: Buffer) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let bits = 0
  let value = 0
  let output = ""
  for (const byte of input) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function customerID(value: string | Stripe.Customer | Stripe.DeletedCustomer | null) {
  if (!value) throw new ApiError(409, "CUSTOMER_MISSING", "Stripe did not attach a customer to this purchase.")
  return typeof value === "string" ? value : value.id
}

function subscriptionID(value: string | Stripe.Subscription | null) {
  if (!value) throw new ApiError(409, "SUBSCRIPTION_MISSING", "Stripe did not attach a subscription to this purchase.")
  return typeof value === "string" ? value : value.id
}

function licenseKeyFor(customer: string, checkoutSession: string) {
  const code = base32(signature(`license:${customer}:${checkoutSession}`).subarray(0, 20))
  return `VEC1.${base64url(customer)}.${code}`
}

function parseLicenseKey(key: string) {
  const [prefix, encodedCustomer, rawCode] = key.trim().split(".")
  const code = rawCode?.toUpperCase()
  if (prefix?.toUpperCase() !== "VEC1" || !encodedCustomer || !code) {
    throw new ApiError(401, "LICENSE_INVALID", "That Vector license key is not valid.")
  }
  let customer = ""
  try {
    customer = fromBase64url(encodedCustomer)
  } catch {}
  if (!customer.startsWith("cus_")) throw new ApiError(401, "LICENSE_INVALID", "That Vector license key is not valid.")
  return { customer, code }
}

function activationToken(customer: string) {
  return `VAT1.${base64url(customer)}.${randomBytes(32).toString("base64url")}`
}

function customerFromActivationToken(token: string) {
  const [prefix, encodedCustomer, secret] = token.trim().split(".")
  if (prefix !== "VAT1" || !encodedCustomer || !secret) {
    throw new ApiError(401, "ACTIVATION_INVALID", "This Vector activation is not valid.")
  }
  let customer = ""
  try {
    customer = fromBase64url(encodedCustomer)
  } catch {}
  if (!customer.startsWith("cus_"))
    throw new ApiError(401, "ACTIVATION_INVALID", "This Vector activation is not valid.")
  return customer
}

function downloadToken(customer: string) {
  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_SECONDS
  const payload = `${customer}:${expires}`
  return `VDL1.${base64url(customer)}.${expires}.${signature(`download:${payload}`).toString("base64url")}`
}

function verifyDownloadToken(token: string) {
  const [prefix, encodedCustomer, rawExpires, provided] = token.split(".")
  const expires = Number(rawExpires)
  if (prefix !== "VDL1" || !encodedCustomer || !provided || !Number.isFinite(expires)) {
    throw new ApiError(401, "DOWNLOAD_INVALID", "This download link is not valid.")
  }
  if (expires < Math.floor(Date.now() / 1000)) {
    throw new ApiError(410, "DOWNLOAD_EXPIRED", "This download link has expired.")
  }
  const customer = fromBase64url(encodedCustomer)
  const expected = signature(`download:${customer}:${expires}`).toString("base64url")
  if (!safeEqual(expected, provided)) throw new ApiError(401, "DOWNLOAD_INVALID", "This download link is not valid.")
  return customer
}

async function customerRecord(stripe: Stripe, id: string) {
  const customer = await stripe.customers.retrieve(id)
  return activeCustomer(customer)
}

function activeCustomer(customer: Stripe.Customer | Stripe.DeletedCustomer): Stripe.Customer {
  if ("deleted" in customer && customer.deleted) {
    throw new ApiError(401, "LICENSE_INVALID", "This Vector customer no longer exists.")
  }
  return customer as Stripe.Customer
}

async function updateCustomer(stripe: Stripe, id: string, params: Stripe.CustomerUpdateParams) {
  return activeCustomer(await stripe.customers.update(id, params))
}

function periodEnd(subscription: StripeSubscription) {
  const periods = subscription.items.data.map((item) => item.current_period_end).filter((value) => value > 0)
  return periods.length ? Math.min(...periods) : (subscription.ended_at ?? 0)
}

function planForSubscription(subscription: StripeSubscription, customer?: StripeCustomer) {
  const stored = subscription.metadata.vector_plan || customer?.metadata.vector_plan
  if (isBillingPlan(stored)) return BILLING_PLANS[stored]
  const interval = subscription.items.data[0]?.price.recurring?.interval
  return interval === "month" ? BILLING_PLANS.monthly : BILLING_PLANS.annual
}

function assertVectorSubscription(subscription: StripeSubscription) {
  if (subscription.metadata.vector_product !== "desktop") {
    throw new ApiError(400, "STRIPE_OBJECT_IGNORED", "This Stripe subscription does not belong to Vector.")
  }
  const plan = planForSubscription(subscription)
  const expectedPrice = requiredPrice(plan)
  const matchesConfiguredPrice = subscription.items.data.some((item) => item.price.id === expectedPrice)
  const matchesLegacyPrice = subscription.items.data.some(
    (item) =>
      item.price.unit_amount === plan.priceUsdCents &&
      item.price.currency === "usd" &&
      item.price.recurring?.interval === plan.interval,
  )
  if (!matchesConfiguredPrice && !matchesLegacyPrice) {
    throw new ApiError(400, "STRIPE_OBJECT_IGNORED", "This Stripe subscription does not use a Vector plan.")
  }
}

function metadataTimestamp(value: string | undefined) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined
}

export function publicStatus(customer: StripeCustomer, subscription: StripeSubscription): PublicLicenseStatus {
  const plan = planForSubscription(subscription, customer)
  const end = periodEnd(subscription)
  const now = Math.floor(Date.now() / 1000)
  const paid = subscription.status === "active" || subscription.status === "trialing"
  const failedAt = metadataTimestamp(customer.metadata.vector_payment_failed_at)
  const graceEnd = metadataTimestamp(customer.metadata.vector_payment_grace_ends_at)
  const paymentGrace = plan.id === "monthly" && failedAt && graceEnd ? graceEnd : undefined
  // Stripe can deliver the failed-invoice event before the subscription
  // snapshot changes to past_due. The recorded renewal failure is the source
  // of truth for Vector's promised three-day grace period.
  const inPaymentGrace = Boolean(paymentGrace && paymentGrace > now)
  const access = inPaymentGrace || (paid && end > now && !failedAt)
  const state: PublicLicenseStatus["state"] = inPaymentGrace
    ? "grace"
    : failedAt && plan.id === "monthly" && paymentGrace && paymentGrace <= now
      ? "expired"
      : access
        ? subscription.cancel_at_period_end
          ? "canceling"
          : "active"
        : subscription.status === "past_due" || subscription.status === "unpaid"
          ? "past_due"
          : "expired"
  const message = inPaymentGrace
    ? `Your monthly renewal payment failed. Update your payment method by ${new Date(paymentGrace! * 1000).toLocaleDateString("en-US", { dateStyle: "long" })} to keep Vector active.`
    : failedAt && plan.id === "monthly" && paymentGrace && paymentGrace <= now
      ? "Your three-day payment grace period ended. Choose a Vector plan to reactivate this computer."
      : undefined
  return {
    access,
    state,
    message,
    email: customer.email ?? customer.metadata.vector_email ?? "",
    expiresAt: end ? new Date(end * 1000).toISOString() : new Date(0).toISOString(),
    graceEndsAt: paymentGrace ? new Date(paymentGrace * 1000).toISOString() : undefined,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    plan: plan.id,
    interval: plan.interval,
    priceUsd: plan.priceUsdCents / 100,
    deviceName: customer.metadata.vector_device_name || undefined,
    devicePlatform: customer.metadata.vector_device_platform || undefined,
    lastFour: customer.metadata.vector_license_last4 || "",
    offlineGraceDays: OFFLINE_GRACE_DAYS,
  }
}

async function subscriptionForCustomer(stripe: Stripe, customer: StripeCustomer) {
  const id = customer.metadata.vector_subscription_id
  if (!id) throw new ApiError(401, "LICENSE_INVALID", "This customer does not have a Vector subscription.")
  return stripe.subscriptions.retrieve(id)
}

async function sendPurchaseEmail(input: {
  email: string
  licenseKey: string
  expiresAt: string
  checkoutSession: string
  plan: BillingPlan
}) {
  if (!process.env.RESEND_API_KEY || !process.env.VECTOR_PURCHASE_EMAIL_FROM) {
    throw new ApiError(503, "EMAIL_NOT_CONFIGURED", "Vector purchase email is not configured.")
  }
  const resend = new Resend(process.env.RESEND_API_KEY)
  const plan = BILLING_PLANS[input.plan]
  const renewal = plan.interval === "month" ? "monthly" : "yearly"
  const result = await resend.emails.send(
    {
      from: process.env.VECTOR_PURCHASE_EMAIL_FROM,
      to: input.email,
      subject: "Your Vector license",
      text: [
        "Thanks for purchasing Vector.",
        "",
        `License key: ${input.licenseKey}`,
        `Current access ends: ${new Date(input.expiresAt).toLocaleDateString("en-US", { dateStyle: "long" })}`,
        "",
        `Open your Vector account: ${publicOrigin()}/account?session_id=${encodeURIComponent(input.checkoutSession)}`,
        "",
        `Your subscription renews ${renewal} unless you cancel. One active computer is allowed at a time. Keep this key private.`,
      ].join("\n"),
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:auto;padding:32px;color:#17151b">
          <img src="${publicOrigin()}/vector-logo.png" width="42" height="42" alt="Vector" style="border-radius:10px" />
          <h1 style="font-size:26px;margin:24px 0 8px">Your Vector license is ready</h1>
          <p style="color:#605a68;line-height:1.6">Thanks for purchasing Vector. Save this license key somewhere private.</p>
          <div style="margin:24px 0;padding:18px;border:1px solid #ded8e8;border-radius:12px;background:#f7f4fb;font-family:ui-monospace,monospace;font-size:16px;word-break:break-all">${input.licenseKey}</div>
          <p style="color:#605a68">Current access ends ${new Date(input.expiresAt).toLocaleDateString("en-US", { dateStyle: "long" })}. Your subscription renews ${renewal} unless cancelled.</p>
          <a href="${publicOrigin()}/account?session_id=${encodeURIComponent(input.checkoutSession)}" style="display:inline-block;margin-top:16px;padding:12px 18px;border-radius:10px;background:#8b5cf6;color:white;text-decoration:none;font-weight:600">Open your Vector account</a>
          <p style="margin-top:28px;color:#77717d;font-size:13px;line-height:1.5">One active computer is allowed at a time. Do not share or redistribute your license key.</p>
        </div>`,
    },
    { idempotencyKey: `vector-purchase/${input.checkoutSession}` },
  )
  if (result.error) throw new Error(result.error.message)
}

export async function createCheckout(email?: string, selectedPlan?: BillingPlan, account?: { userId: string }) {
  const plan = requiredBillingPlan(selectedPlan)
  if (!account?.userId) throw new ApiError(401, "AUTH_REQUIRED", "Sign in to your Vector account to subscribe.")
  const config = billingConfiguration()
  if (!config.available) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Vector purchases are not available yet.")
  const stripe = stripeClient()
  const existing = await subscriptionForUser(account.userId)
  if (existing && ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"].includes(existing.status)) {
    throw new ApiError(
      409,
      "SUBSCRIPTION_EXISTS",
      "This Vector account already has a subscription. Open billing settings to manage it.",
    )
  }
  const bucket = Math.floor(Date.now() / (5 * 60 * 1_000))
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      client_reference_id: account?.userId,
      ...(existing?.stripe_customer_id
        ? { customer: existing.stripe_customer_id }
        : { customer_email: email?.trim() || undefined }),
      billing_address_collection: "auto",
      allow_promotion_codes: false,
      line_items: [
        {
          quantity: 1,
          price: requiredPrice(plan),
        },
      ],
      subscription_data: {
        description: plan.name,
        metadata: {
          vector_product: "desktop",
          vector_license_version: "1",
          vector_plan: plan.id,
          ...(account?.userId ? { vector_user_id: account.userId } : {}),
        },
      },
      metadata: {
        vector_product: "desktop",
        vector_license_version: "1",
        vector_plan: plan.id,
        ...(account?.userId ? { vector_user_id: account.userId } : {}),
      },
      success_url: `${publicOrigin()}/account?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicOrigin()}/download?checkout=cancelled`,
      custom_text: {
        submit: {
          message: `${plan.renewalText} One active computer per license.`,
        },
      },
    },
    { idempotencyKey: `vector-checkout/${account.userId}/${plan.id}/${bucket}` },
  )
  if (!session.url) throw new ApiError(502, "CHECKOUT_UNAVAILABLE", "Stripe did not return a checkout URL.")
  return session.url
}

export async function provisionCheckout(
  session: Stripe.Checkout.Session,
  options?: { sendEmail?: boolean; userId?: string },
) {
  if (
    session.mode !== "subscription" ||
    (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")
  ) {
    throw new ApiError(402, "PAYMENT_REQUIRED", "This Vector purchase has not been paid.")
  }
  const stripe = stripeClient()
  const customer = await customerRecord(stripe, customerID(session.customer))
  const subscription = await stripe.subscriptions.retrieve(subscriptionID(session.subscription))
  assertVectorSubscription(subscription)
  const plan = planForSubscription(subscription)
  const userId =
    options?.userId ||
    session.client_reference_id ||
    session.metadata?.vector_user_id ||
    subscription.metadata.vector_user_id
  const licenseKey = licenseKeyFor(customer.id, session.id)
  const status = publicStatus(customer, subscription)
  const email = session.customer_details?.email ?? customer.email
  if (!email) throw new ApiError(409, "EMAIL_MISSING", "Stripe did not provide an email for this purchase.")

  const metadata = {
    ...customer.metadata,
    vector_product: "desktop",
    vector_license_version: "1",
    vector_plan: plan.id,
    vector_checkout_session_id: session.id,
    vector_license_hash: digest(licenseKey),
    vector_license_last4: licenseKey.slice(-4),
    vector_subscription_id: subscription.id,
    vector_email: email,
    ...(userId ? { vector_user_id: userId } : {}),
    vector_period_end: `${Math.floor(new Date(status.expiresAt).getTime() / 1000)}`,
  }
  const updated = await updateCustomer(stripe, customer.id, { metadata })
  await stripe.subscriptions.update(subscription.id, {
    metadata: {
      ...subscription.metadata,
      vector_product: "desktop",
      vector_license_version: "1",
      vector_customer_id: customer.id,
      vector_plan: plan.id,
      ...(userId ? { vector_user_id: userId } : {}),
    },
  })

  await syncPlatformSubscription({
    userId: userId || undefined,
    customerId: customer.id,
    subscription,
    plan: plan.id,
  })
  await syncPlatformLicense({
    userId: userId || undefined,
    customerId: customer.id,
    keyLastFour: licenseKey.slice(-4),
  })

  if (options?.sendEmail !== false && updated.metadata.vector_purchase_email_sent !== session.id) {
    await sendPurchaseEmail({
      email,
      licenseKey,
      expiresAt: status.expiresAt,
      checkoutSession: session.id,
      plan: plan.id,
    })
    await updateCustomer(stripe, customer.id, {
      metadata: { ...updated.metadata, vector_purchase_email_sent: session.id },
    })
  }

  return {
    licenseKey,
    downloadToken: downloadToken(customer.id),
    status: { ...status, email },
  }
}

export async function claimCheckout(sessionID: string, expectedUserID: string, expectedEmail?: string) {
  if (!sessionID.startsWith("cs_")) throw new ApiError(400, "SESSION_INVALID", "The checkout session is not valid.")
  const session = await stripeClient().checkout.sessions.retrieve(sessionID, {
    expand: ["customer", "subscription"],
  })
  const checkoutUserID = session.client_reference_id || session.metadata?.vector_user_id
  const checkoutEmail = session.customer_details?.email?.trim().toLowerCase()
  const accountEmail = expectedEmail?.trim().toLowerCase()
  const legacyOwnership = !checkoutUserID && Boolean(checkoutEmail && accountEmail && checkoutEmail === accountEmail)
  if ((!legacyOwnership && !checkoutUserID) || (checkoutUserID && checkoutUserID !== expectedUserID)) {
    throw new ApiError(403, "CHECKOUT_ACCOUNT_MISMATCH", "That purchase belongs to a different Vector account.")
  }
  // License retrieval must remain available even if the email provider is
  // temporarily unavailable. Stripe's checkout webhook owns email delivery
  // and will retry it independently.
  return provisionCheckout(session, { sendEmail: false, userId: expectedUserID })
}

async function licensedCustomer(key: string) {
  const parsed = parseLicenseKey(key)
  const stripe = stripeClient()
  const customer = await customerRecord(stripe, parsed.customer)
  const checkout = customer.metadata.vector_checkout_session_id
  if (!checkout) throw new ApiError(401, "LICENSE_INVALID", "That Vector license key is not valid.")
  const expected = licenseKeyFor(customer.id, checkout)
  const canonical = `VEC1.${key.trim().split(".")[1]}.${parsed.code}`
  if (!safeEqual(expected, canonical)) {
    throw new ApiError(401, "LICENSE_INVALID", "That Vector license key is not valid.")
  }
  return { stripe, customer, subscription: await subscriptionForCustomer(stripe, customer) }
}

async function activatedCustomer(token: string) {
  const id = customerFromActivationToken(token)
  const stripe = stripeClient()
  const customer = await customerRecord(stripe, id)
  if (
    !customer.metadata.vector_activation_hash ||
    !safeEqual(customer.metadata.vector_activation_hash, digest(token))
  ) {
    throw new ApiError(401, "ACTIVATION_INVALID", "This Vector activation is no longer valid.")
  }
  return { stripe, customer, subscription: await subscriptionForCustomer(stripe, customer) }
}

export async function activateLicense(input: {
  licenseKey: string
  deviceId: string
  deviceName: string
  platform: string
}) {
  const licenseKey = requiredText(input?.licenseKey, "LICENSE_INVALID", "That Vector license key is not valid.", 256)
  const deviceId = requiredText(input?.deviceId, "DEVICE_INVALID", "Vector could not identify this computer.", 64)
  const deviceName = requiredText(input?.deviceName, "DEVICE_INVALID", "Vector could not identify this computer.", 80)
  const platform = requiredText(input?.platform, "DEVICE_INVALID", "Vector could not identify this computer.", 40)
  if (!/^[a-f0-9]{64}$/i.test(deviceId))
    throw new ApiError(400, "DEVICE_INVALID", "Vector could not identify this computer.")
  const record = await licensedCustomer(licenseKey)
  const status = publicStatus(record.customer, record.subscription)
  if (!status.access) throw new ApiError(402, "LICENSE_EXPIRED", "This Vector subscription is not currently active.")
  const bound = record.customer.metadata.vector_device_hash
  if (bound && bound !== deviceId) {
    throw new ApiError(
      409,
      "DEVICE_LIMIT",
      "This license is already active on another computer. Deactivate that computer first.",
    )
  }
  const userId = record.customer.metadata.vector_user_id
  if (userId && !(await claimPlatformDevice(userId, deviceId, deviceName))) {
    throw new ApiError(
      409,
      "DEVICE_LIMIT",
      "This license is already active on another computer. Deactivate that computer first.",
    )
  }
  const token = activationToken(record.customer.id)
  let customer: StripeCustomer
  try {
    customer = await updateCustomer(record.stripe, record.customer.id, {
      metadata: {
        ...record.customer.metadata,
        vector_device_hash: deviceId,
        vector_device_name: deviceName,
        vector_device_platform: platform,
        vector_activation_hash: digest(token),
        vector_activated_at: new Date().toISOString(),
        vector_last_seen_at: new Date().toISOString(),
      },
    })
  } catch (error) {
    if (userId) await releasePlatformDevice(userId, deviceId).catch(() => undefined)
    throw error
  }
  await syncPlatformLicense({
    userId: customer.metadata.vector_user_id || undefined,
    customerId: customer.id,
    keyLastFour: licenseKey.slice(-4),
    deviceHash: deviceId,
    deviceName,
    activatedAt: new Date().toISOString(),
  })
  return { activationToken: token, status: publicStatus(customer, record.subscription) }
}

export async function activationStatus(input: { activationToken: string; deviceId: string }) {
  const activation = requiredText(
    input?.activationToken,
    "ACTIVATION_INVALID",
    "This Vector activation is not valid.",
    512,
  )
  const deviceId = requiredText(input?.deviceId, "DEVICE_INVALID", "Vector could not identify this computer.", 64)
  const record = await activatedCustomer(activation)
  if (record.customer.metadata.vector_device_hash !== deviceId) {
    throw new ApiError(401, "DEVICE_MISMATCH", "This activation belongs to another computer.")
  }
  const customer = await updateCustomer(record.stripe, record.customer.id, {
    metadata: { ...record.customer.metadata, vector_last_seen_at: new Date().toISOString() },
  })
  return publicStatus(customer, record.subscription)
}

export async function deactivateLicense(input: { activationToken: string; deviceId: string }) {
  const activation = requiredText(
    input?.activationToken,
    "ACTIVATION_INVALID",
    "This Vector activation is not valid.",
    512,
  )
  const deviceId = requiredText(input?.deviceId, "DEVICE_INVALID", "Vector could not identify this computer.", 64)
  const record = await activatedCustomer(activation)
  if (record.customer.metadata.vector_device_hash !== deviceId) {
    throw new ApiError(401, "DEVICE_MISMATCH", "This activation belongs to another computer.")
  }
  await updateCustomer(record.stripe, record.customer.id, {
    metadata: {
      ...record.customer.metadata,
      vector_device_hash: "",
      vector_device_name: "",
      vector_device_platform: "",
      vector_activation_hash: "",
      vector_deactivated_at: new Date().toISOString(),
    },
  })
  const userId = record.customer.metadata.vector_user_id
  if (userId) await releasePlatformDevice(userId, deviceId)
  await syncPlatformLicense({
    userId: userId || undefined,
    customerId: record.customer.id,
    keyLastFour: record.customer.metadata.vector_license_last4 || "",
    deviceHash: null,
    deviceName: null,
    deactivatedAt: new Date().toISOString(),
  })
  return { deactivated: true }
}

export async function setCancellation(input: { activationToken: string; deviceId: string; cancel: boolean }) {
  const activation = requiredText(
    input?.activationToken,
    "ACTIVATION_INVALID",
    "This Vector activation is not valid.",
    512,
  )
  const deviceId = requiredText(input?.deviceId, "DEVICE_INVALID", "Vector could not identify this computer.", 64)
  if (typeof input?.cancel !== "boolean")
    throw new ApiError(400, "CANCELLATION_INVALID", "Choose whether renewal should be cancelled.")
  const record = await activatedCustomer(activation)
  if (record.customer.metadata.vector_device_hash !== deviceId) {
    throw new ApiError(401, "DEVICE_MISMATCH", "This activation belongs to another computer.")
  }
  const subscription = await record.stripe.subscriptions.update(record.subscription.id, {
    cancel_at_period_end: input.cancel,
  })
  return publicStatus(record.customer, subscription)
}

export async function billingPortal(input: { activationToken: string; deviceId: string }) {
  const activation = requiredText(
    input?.activationToken,
    "ACTIVATION_INVALID",
    "This Vector activation is not valid.",
    512,
  )
  const deviceId = requiredText(input?.deviceId, "DEVICE_INVALID", "Vector could not identify this computer.", 64)
  const record = await activatedCustomer(activation)
  if (record.customer.metadata.vector_device_hash !== deviceId) {
    throw new ApiError(401, "DEVICE_MISMATCH", "This activation belongs to another computer.")
  }
  const session = await record.stripe.billingPortal.sessions.create({
    customer: record.customer.id,
    return_url: `${publicOrigin()}/download`,
  })
  return session.url
}

const downloadTargets: Record<string, string> = {
  "mac-arm64": "vector-desktop-mac-arm64.dmg",
  "mac-x64": "vector-desktop-mac-x64.dmg",
  "windows-x64": "vector-desktop-win-x64.exe",
  "windows-arm64": "vector-desktop-win-arm64.exe",
  "linux-x64": "vector-desktop-linux-x86_64.AppImage",
  "linux-arm64": "vector-desktop-linux-arm64.AppImage",
}

function installerDownloadUrl(customerId: string, target: string) {
  const params = new URLSearchParams({
    token: downloadToken(customerId),
    target,
  })
  return `${publicOrigin()}/api/billing/download?${params.toString()}`
}

function installerBlobPath(file: string) {
  const prefix = (process.env.VECTOR_INSTALLER_BLOB_PREFIX || "releases/vector-downloads").replace(/^\/+|\/+$/g, "")
  return `${prefix}/${file}`
}

export async function accountDownload(customerId: string, target: string) {
  const file = downloadTargets[target]
  if (!file) throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer does not exist.")
  const stripe = stripeClient()
  const customer = await customerRecord(stripe, customerId)
  const subscription = await subscriptionForCustomer(stripe, customer)
  if (!publicStatus(customer, subscription).access) {
    throw new ApiError(402, "LICENSE_EXPIRED", "This Vector subscription is not currently active.")
  }
  return installerDownloadUrl(customer.id, target)
}

export async function accountBillingPortal(customerId: string) {
  const customer = await customerRecord(stripeClient(), customerId)
  const session = await stripeClient().billingPortal.sessions.create({
    customer: customer.id,
    return_url: `${publicOrigin()}/account`,
  })
  return session.url
}

export async function consumeDownload(token: string, target: string) {
  const file = downloadTargets[target]
  if (!file) throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer does not exist.")
  const id = verifyDownloadToken(token)
  const stripe = stripeClient()
  const customer = await customerRecord(stripe, id)
  const subscription = await subscriptionForCustomer(stripe, customer)
  if (!publicStatus(customer, subscription).access) {
    throw new ApiError(402, "LICENSE_EXPIRED", "This Vector subscription is not currently active.")
  }
  return {
    file,
    pathname: installerBlobPath(file),
    customerId: customer.id,
    userId: customer.metadata.vector_user_id,
    alreadyDownloaded: Boolean(customer.metadata.vector_downloaded_at),
  }
}

export async function completeDownload(input: {
  customerId: string
  userId?: string
  target: string
  alreadyDownloaded: boolean
}) {
  if (input.alreadyDownloaded) {
    throw new ApiError(409, "DOWNLOAD_USED", "The initial installer download for this license has already been used.")
  }
  if (!input.userId) {
    throw new ApiError(409, "ACCOUNT_LINK_REQUIRED", "Link this legacy purchase to your Vector account first.")
  }
  const claimed = await claimInstallerDownload(input.userId, input.target)
  if (!claimed) {
    throw new ApiError(409, "DOWNLOAD_USED", "The initial installer download for this license has already been used.")
  }
  const stripe = stripeClient()
  const customer = await customerRecord(stripe, input.customerId)
  await updateCustomer(stripe, customer.id, {
    metadata: {
      ...customer.metadata,
      vector_downloaded_at: new Date().toISOString(),
      vector_download_target: input.target,
    },
  })
}

export async function syncSubscription(snapshot: StripeSubscription) {
  const stripe = stripeClient()
  const subscription = await stripe.subscriptions.retrieve(snapshot.id)
  assertVectorSubscription(subscription)
  const customer = await customerRecord(stripe, customerID(subscription.customer))
  const plan = planForSubscription(subscription, customer)
  const status = publicStatus(customer, subscription)
  await updateCustomer(stripe, customer.id, {
    metadata: {
      ...customer.metadata,
      vector_subscription_id: subscription.id,
      vector_plan: plan.id,
      vector_subscription_status: subscription.status,
      vector_period_end: `${Math.floor(new Date(status.expiresAt).getTime() / 1000)}`,
      vector_cancel_at_period_end: subscription.cancel_at_period_end ? "true" : "false",
    },
  })
  await syncPlatformSubscription({
    userId: customer.metadata.vector_user_id || subscription.metadata.vector_user_id || undefined,
    customerId: customer.id,
    subscription,
    plan: plan.id,
    paymentFailedAt: metadataTimestamp(customer.metadata.vector_payment_failed_at),
    graceEndsAt: metadataTimestamp(customer.metadata.vector_payment_grace_ends_at),
  })
}

function invoiceSubscriptionID(invoice: Stripe.Invoice) {
  const legacy = (invoice as Stripe.Invoice & { subscription?: string | StripeSubscription | null }).subscription
  const subscription = invoice.parent?.subscription_details?.subscription ?? legacy
  return typeof subscription === "string" ? subscription : subscription?.id
}

async function sendPaymentFailureEmail(input: {
  customer: StripeCustomer
  invoice: Stripe.Invoice
  plan: BillingPlanDefinition
  graceEndsAt?: number
}) {
  if (!process.env.RESEND_API_KEY || !process.env.VECTOR_PURCHASE_EMAIL_FROM) {
    throw new ApiError(503, "EMAIL_NOT_CONFIGURED", "Vector payment email is not configured.")
  }
  const email = input.invoice.customer_email || input.customer.email || input.customer.metadata.vector_email
  if (!email) throw new ApiError(409, "EMAIL_MISSING", "Vector could not find the customer email for this payment.")
  const actionUrl = input.invoice.hosted_invoice_url || `${publicOrigin()}/download?billing=past-due`
  const graceCopy = input.graceEndsAt
    ? `Vector remains active until ${new Date(input.graceEndsAt * 1000).toLocaleDateString("en-US", { dateStyle: "long" })}. After that three-day grace period, the license expires until payment is restored.`
    : "Update your payment method to restore uninterrupted Vector access."
  const resend = new Resend(process.env.RESEND_API_KEY)
  const result = await resend.emails.send(
    {
      from: process.env.VECTOR_PURCHASE_EMAIL_FROM,
      to: email,
      subject: "Action required: your Vector payment failed",
      text: [
        `We could not process the latest payment for your ${input.plan.name}.`,
        "",
        graceCopy,
        "",
        `Fix payment: ${actionUrl}`,
        "",
        "Vector will restore normal access automatically after Stripe confirms payment.",
      ].join("\n"),
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:auto;padding:32px;color:#17151b">
          <img src="${publicOrigin()}/vector-logo.png" width="42" height="42" alt="Vector" style="border-radius:10px" />
          <h1 style="font-size:26px;margin:24px 0 8px">Your Vector payment needs attention</h1>
          <p style="color:#605a68;line-height:1.6">We could not process the latest payment for your ${input.plan.name}. ${graceCopy}</p>
          <a href="${actionUrl}" style="display:inline-block;margin-top:16px;padding:12px 18px;border-radius:10px;background:#8b5cf6;color:white;text-decoration:none;font-weight:600">Update payment</a>
          <p style="margin-top:28px;color:#77717d;font-size:13px;line-height:1.5">Vector restores normal access automatically after Stripe confirms payment.</p>
        </div>`,
    },
    { idempotencyKey: `vector-payment-failed/${input.invoice.id}/${input.invoice.attempt_count}` },
  )
  if (result.error) throw new Error(result.error.message)
}

async function recordPaymentFailure(invoice: Stripe.Invoice, eventCreated: number) {
  const id = invoiceSubscriptionID(invoice)
  if (!id) return
  const stripe = stripeClient()
  const subscription = await stripe.subscriptions.retrieve(id)
  assertVectorSubscription(subscription)
  const customer = await customerRecord(stripe, customerID(subscription.customer))
  const plan = planForSubscription(subscription, customer)
  const priorEvent = metadataTimestamp(customer.metadata.vector_payment_failed_event_created)
  if (priorEvent && priorEvent > eventCreated) return
  const sameInvoice = customer.metadata.vector_payment_failed_invoice === invoice.id
  const existingFailure = sameInvoice ? metadataTimestamp(customer.metadata.vector_payment_failed_at) : undefined
  const failedAt = existingFailure ?? eventCreated
  const renewalFailure = invoice.billing_reason === "subscription_cycle"
  const graceEndsAt = renewalFailure && plan.graceDays ? failedAt + plan.graceDays * DAY_SECONDS : undefined
  await updateCustomer(stripe, customer.id, {
    metadata: {
      ...customer.metadata,
      vector_plan: plan.id,
      vector_payment_failed_at: `${failedAt}`,
      vector_payment_failed_invoice: invoice.id,
      vector_payment_failed_event_created: `${eventCreated}`,
      vector_payment_failure_kind: renewalFailure ? "renewal" : "initial",
      vector_payment_grace_ends_at: graceEndsAt ? `${graceEndsAt}` : "",
    },
  })
  await syncPlatformSubscription({
    userId: customer.metadata.vector_user_id || subscription.metadata.vector_user_id || undefined,
    customerId: customer.id,
    subscription,
    plan: plan.id,
    paymentFailedAt: failedAt,
    graceEndsAt,
  })
  await sendPaymentFailureEmail({ customer, invoice, plan, graceEndsAt })
}

async function clearPaymentFailure(invoice: Stripe.Invoice, eventCreated: number) {
  const id = invoiceSubscriptionID(invoice)
  if (!id) return
  const stripe = stripeClient()
  const subscription = await stripe.subscriptions.retrieve(id)
  assertVectorSubscription(subscription)
  const customer = await customerRecord(stripe, customerID(subscription.customer))
  const failedInvoice = customer.metadata.vector_payment_failed_invoice
  const failedEvent = metadataTimestamp(customer.metadata.vector_payment_failed_event_created)
  if (failedInvoice && failedInvoice !== invoice.id && failedEvent && eventCreated < failedEvent) return
  await updateCustomer(stripe, customer.id, {
    metadata: {
      ...customer.metadata,
      vector_payment_failed_at: "",
      vector_payment_failed_invoice: "",
      vector_payment_failed_event_created: "",
      vector_payment_failure_kind: "",
      vector_payment_grace_ends_at: "",
    },
  })
  await syncPlatformSubscription({
    userId: customer.metadata.vector_user_id || subscription.metadata.vector_user_id || undefined,
    customerId: customer.id,
    subscription,
    plan: planForSubscription(subscription, customer).id,
  })
}

export async function handleStripeEvent(event: Stripe.Event) {
  if (!(await claimStripeEvent(event.id, event.type, event.created))) return
  try {
    if (event.type === "checkout.session.completed") {
      await provisionCheckout(event.data.object)
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await syncSubscription(event.data.object)
    } else if (event.type === "invoice.payment_failed" || event.type === "invoice.payment_action_required") {
      await recordPaymentFailure(event.data.object, event.created)
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
      await clearPaymentFailure(event.data.object, event.created)
    }
    await completeStripeEvent(event.id)
  } catch (error) {
    if (error instanceof ApiError && error.code === "STRIPE_OBJECT_IGNORED") {
      await completeStripeEvent(event.id)
      return
    }
    await failStripeEvent(event.id, error instanceof Error ? error.message : "Stripe event processing failed.")
    throw error
  }
}
