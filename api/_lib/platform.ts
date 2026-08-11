import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import type Stripe from "stripe"
import { ApiError, type ApiRequest } from "./http.js"

export type PlatformUser = {
  id: string
  email?: string
  user_metadata?: Record<string, unknown>
}

export type PlatformAuthProvider = "github" | "google"

export type PlatformSubscription = {
  user_id: string
  stripe_customer_id: string
  stripe_subscription_id: string
  plan: "monthly" | "annual"
  status: string
  current_period_end: string | null
  cancel_at_period_end: boolean
  payment_failed_at: string | null
  grace_ends_at: string | null
}

export type PlatformEntitlement = {
  access: boolean
  state: "active" | "canceling" | "grace" | "past_due" | "expired" | "none"
  plan?: "monthly" | "annual"
  expiresAt?: string
  graceEndsAt?: string
  cancelAtPeriodEnd: boolean
  message?: string
}

const trim = (value: string | undefined) => value?.trim() || undefined

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

export function platformUsageLimits() {
  return {
    activeCloudAgents: 16,
    cloudAgentLaunches30Days: boundedEnvironmentInteger("VECTOR_CLOUD_AGENT_30_DAY_LAUNCH_LIMIT", 24, 1, 1_000),
    cloudAgentTurns30Days: boundedEnvironmentInteger("VECTOR_CLOUD_AGENT_30_DAY_TURN_LIMIT", 240, 1, 10_000),
    apiExecutionsDaily: boundedEnvironmentInteger("VECTOR_API_DAILY_EXECUTION_LIMIT", 500, 1, 100_000),
  }
}

export function platformConfiguration() {
  const url = trim(process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL)
  const publishableKey = trim(
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY,
  )
  const serviceRoleKey = trim(process.env.SUPABASE_SERVICE_ROLE_KEY)
  const encryptionKey = trim(process.env.VECTOR_PLATFORM_SECRET)
  const model = trim(process.env.VECTOR_CLOUD_AGENT_MODEL)
  const cloudRuntime = trim(process.env.VECTOR_CLOUD_SANDBOX_IMAGE)
  const cronSecret = trim(process.env.CRON_SECRET)
  const adminAvailable = Boolean(url && serviceRoleKey)
  const cloudModels = (process.env.VECTOR_CLOUD_AGENT_MODELS || model || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const gatewayModelsOnly = cloudModels.length > 0 && cloudModels.every((value) => value.startsWith("vercel/"))
  const authProviders = (process.env.VECTOR_AUTH_PROVIDERS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is PlatformAuthProvider => value === "github" || value === "google")
  return {
    authAvailable: Boolean(url && publishableKey),
    adminAvailable,
    cloudAgentsAvailable: Boolean(
      adminAvailable &&
        encryptionKey &&
        gatewayModelsOnly &&
        process.env.AI_GATEWAY_API_KEY &&
        cloudRuntime &&
        cronSecret &&
        cronSecret.length >= 24,
    ),
    apiPlatformAvailable: Boolean(adminAvailable && encryptionKey),
    url,
    publishableKey,
    authProviders: [...new Set(authProviders)],
    model,
  }
}

function requiredAdminConfig() {
  const config = platformConfiguration()
  if (!config.url || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ApiError(503, "PLATFORM_NOT_CONFIGURED", "Vector's platform database is not configured yet.")
  }
  return {
    url: config.url,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  }
}

function requiredAuthConfig() {
  const config = platformConfiguration()
  if (!config.url || !config.publishableKey) {
    throw new ApiError(503, "PLATFORM_NOT_CONFIGURED", "Vector accounts are not configured yet.")
  }
  return { url: config.url, publishableKey: config.publishableKey }
}

export function platformAdmin() {
  const config = requiredAdminConfig()
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

function bearer(request: ApiRequest) {
  const authorization = request.headers?.authorization
  if (!authorization?.startsWith("Bearer ")) return undefined
  return authorization.slice(7).trim() || undefined
}

export async function optionalUser(request: ApiRequest): Promise<PlatformUser | undefined> {
  const token = bearer(request)
  if (!token) return undefined
  const config = requiredAuthConfig()
  const response = await fetch(`${config.url}/auth/v1/user`, {
    headers: {
      apikey: config.publishableKey,
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok) throw new ApiError(401, "AUTH_INVALID", "Your Vector session has expired. Sign in again.")
  const user = (await response.json().catch(() => undefined)) as PlatformUser | undefined
  if (!user?.id) throw new ApiError(401, "AUTH_INVALID", "Your Vector session has expired. Sign in again.")
  return user
}

export async function requireUser(request: ApiRequest) {
  const user = await optionalUser(request)
  if (!user) throw new ApiError(401, "AUTH_REQUIRED", "Sign in to your Vector account to continue.")
  return user
}

export function entitlementFor(subscription?: PlatformSubscription | null): PlatformEntitlement {
  if (!subscription) return { access: false, state: "none", cancelAtPeriodEnd: false }
  const now = Date.now()
  const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end).getTime() : 0
  const graceEnd = subscription.grace_ends_at ? new Date(subscription.grace_ends_at).getTime() : 0
  const inGrace = subscription.plan === "monthly" && graceEnd > now && Boolean(subscription.payment_failed_at)
  const paid = subscription.status === "active" || subscription.status === "trialing"
  const active = paid && periodEnd > now && !subscription.payment_failed_at
  const access = active || inGrace
  const state: PlatformEntitlement["state"] = inGrace
    ? "grace"
    : active
      ? subscription.cancel_at_period_end
        ? "canceling"
        : "active"
      : subscription.status === "past_due" || subscription.status === "unpaid"
        ? "past_due"
        : "expired"
  return {
    access,
    state,
    plan: subscription.plan,
    expiresAt: subscription.current_period_end ?? undefined,
    graceEndsAt: subscription.grace_ends_at ?? undefined,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    message: inGrace
      ? "Your renewal payment failed. Update it before the three-day grace period ends to keep Vector active."
      : !access
        ? "Your Vector subscription is not active. Choose a plan to restore access."
        : undefined,
  }
}

export async function subscriptionForUser(userId: string) {
  const { data, error } = await platformAdmin()
    .from("vector_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle<PlatformSubscription>()
  if (error) throw new ApiError(500, "SUBSCRIPTION_LOOKUP_FAILED", "Vector could not check your subscription.")
  return data
}

export async function requireEntitlement(request: ApiRequest) {
  const user = await requireUser(request)
  const subscription = await subscriptionForUser(user.id)
  const entitlement = entitlementFor(subscription)
  if (!entitlement.access) {
    throw new ApiError(402, "SUBSCRIPTION_REQUIRED", entitlement.message || "Subscribe to Vector to continue.")
  }
  return { user, subscription: subscription!, entitlement }
}

function periodEnd(subscription: Stripe.Subscription) {
  const values = subscription.items.data.map((item) => item.current_period_end).filter((value) => value > 0)
  return values.length ? Math.min(...values) : subscription.ended_at || 0
}

export async function syncPlatformSubscription(input: {
  userId?: string
  customerId: string
  subscription: Stripe.Subscription
  plan: "monthly" | "annual"
  paymentFailedAt?: number
  graceEndsAt?: number
}) {
  if (!platformConfiguration().adminAvailable) return false
  const userId = input.userId || input.subscription.metadata.vector_user_id
  if (!userId) return false
  const end = periodEnd(input.subscription)
  const { error } = await platformAdmin()
    .from("vector_subscriptions")
    .upsert(
      {
        user_id: userId,
        stripe_customer_id: input.customerId,
        stripe_subscription_id: input.subscription.id,
        plan: input.plan,
        status: input.subscription.status,
        current_period_end: end ? new Date(end * 1000).toISOString() : null,
        cancel_at_period_end: input.subscription.cancel_at_period_end,
        payment_failed_at: input.paymentFailedAt ? new Date(input.paymentFailedAt * 1000).toISOString() : null,
        grace_ends_at: input.graceEndsAt ? new Date(input.graceEndsAt * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
  if (error) throw new Error(`Could not sync Vector subscription: ${error.message}`)
  return true
}

export async function syncPlatformLicense(input: {
  userId?: string
  customerId: string
  keyLastFour: string
  deviceHash?: string | null
  deviceName?: string | null
  activatedAt?: string | null
  deactivatedAt?: string | null
}) {
  if (!platformConfiguration().adminAvailable || !input.userId) return false
  const record: Record<string, string | null> = {
    user_id: input.userId,
    stripe_customer_id: input.customerId,
    key_last_four: input.keyLastFour,
  }
  if (input.deviceHash !== undefined) record.device_hash = input.deviceHash
  if (input.deviceName !== undefined) record.device_name = input.deviceName
  if (input.activatedAt !== undefined) record.activated_at = input.activatedAt
  if (input.deactivatedAt !== undefined) record.deactivated_at = input.deactivatedAt
  const { error } = await platformAdmin().from("vector_licenses").upsert(record, { onConflict: "user_id" })
  if (error) throw new Error(`Could not sync Vector license: ${error.message}`)
  return true
}

export async function claimStripeEvent(id: string, type: string, created: number) {
  const { data, error } = await platformAdmin().rpc("vector_claim_stripe_event", {
    p_event_id: id,
    p_event_type: type,
    p_event_created: new Date(created * 1000).toISOString(),
  })
  if (error) throw new Error(`Could not claim Stripe event: ${error.message}`)
  return Boolean(data)
}

export async function completeStripeEvent(id: string) {
  const { error } = await platformAdmin()
    .from("vector_stripe_events")
    .update({ status: "complete", processed_at: new Date().toISOString(), last_error: null })
    .eq("id", id)
  if (error) throw new Error(`Could not complete Stripe event: ${error.message}`)
}

export async function failStripeEvent(id: string, message: string) {
  const { error } = await platformAdmin()
    .from("vector_stripe_events")
    .update({ status: "failed", last_error: message.slice(0, 2_000) })
    .eq("id", id)
  if (error) throw new Error(`Could not record Stripe event failure: ${error.message}`)
}

export async function claimPlatformDevice(userId: string, deviceHash: string, deviceName: string) {
  const { data, error } = await platformAdmin().rpc("vector_claim_device", {
    p_user_id: userId,
    p_device_hash: deviceHash,
    p_device_name: deviceName,
  })
  if (error) throw new Error(`Could not reserve this Vector license: ${error.message}`)
  return Boolean(data)
}

export async function releasePlatformDevice(userId: string, deviceHash: string) {
  const { data, error } = await platformAdmin().rpc("vector_release_device", {
    p_user_id: userId,
    p_device_hash: deviceHash,
  })
  if (error) throw new Error(`Could not release this Vector license: ${error.message}`)
  return Boolean(data)
}

export async function claimInstallerDownload(userId: string, target: string) {
  const { data, error } = await platformAdmin().rpc("vector_claim_installer_download", {
    p_user_id: userId,
    p_target: target,
  })
  if (error) throw new Error(`Could not reserve this Vector installer download: ${error.message}`)
  return Boolean(data)
}

function platformSecrets() {
  const current = process.env.VECTOR_PLATFORM_SECRET?.trim()
  if (!current || current.length < 32) {
    throw new ApiError(503, "PLATFORM_SECRET_MISSING", "Vector's secure cloud vault is not configured.")
  }
  const previous = (process.env.VECTOR_PLATFORM_SECRET_PREVIOUS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length >= 32 && value !== current)
    .slice(0, 3)
  return [current, ...previous].map((value) => createHash("sha256").update(value).digest())
}

export function encryptPlatformValue(value: unknown) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", platformSecrets()[0]!, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`
}

export function decryptPlatformValue<T>(value: string): T {
  const [version, rawIv, rawTag, rawCiphertext] = value.split(".")
  if (version !== "v1" || !rawIv || !rawTag || !rawCiphertext) {
    throw new ApiError(500, "VAULT_VALUE_INVALID", "A saved Vector connection could not be read.")
  }
  for (const secret of platformSecrets()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(rawIv, "base64url"))
      decipher.setAuthTag(Buffer.from(rawTag, "base64url"))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(rawCiphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8")
      return JSON.parse(plaintext) as T
    } catch {}
  }
  throw new ApiError(500, "VAULT_VALUE_INVALID", "A saved Vector connection could not be decrypted.")
}

export function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export async function userFromApiKey(request: ApiRequest) {
  const raw = request.headers["x-vector-api-key"]
  const key = Array.isArray(raw) ? raw[0] : raw
  if (!key?.startsWith("vec_live_")) return undefined
  const admin = platformAdmin()
  const { data, error } = await admin
    .from("vector_api_keys")
    .select("id,user_id,revoked_at,scopes,daily_unit_limit,expires_at")
    .eq("secret_hash", hashSecret(key))
    .maybeSingle<{
      id: string
      user_id: string
      revoked_at: string | null
      scopes: string[]
      daily_unit_limit: number
      expires_at: string | null
    }>()
  if (error || !data || data.revoked_at || (data.expires_at && new Date(data.expires_at).getTime() <= Date.now())) {
    throw new ApiError(401, "API_KEY_INVALID", "That Vector API key is invalid or expired.")
  }
  await admin.from("vector_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id)
  const config = requiredAdminConfig()
  const userResponse = await fetch(`${config.url}/auth/v1/admin/users/${encodeURIComponent(data.user_id)}`, {
    headers: {
      apikey: config.serviceRoleKey,
      authorization: `Bearer ${config.serviceRoleKey}`,
    },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!userResponse?.ok) throw new ApiError(401, "API_KEY_INVALID", "That Vector API key is invalid.")
  const user = (await userResponse.json().catch(() => undefined)) as PlatformUser | undefined
  if (!user?.id) throw new ApiError(401, "API_KEY_INVALID", "That Vector API key is invalid.")
  return { user, key: data }
}

export async function requirePlatformCaller(request: ApiRequest, requiredScope?: string) {
  const apiPrincipal = await userFromApiKey(request)
  const user = apiPrincipal?.user || (await optionalUser(request))
  if (!user) throw new ApiError(401, "AUTH_REQUIRED", "Use a Vector API key or sign in to continue.")
  if (apiPrincipal && requiredScope && !apiPrincipal.key.scopes.includes(requiredScope)) {
    throw new ApiError(403, "API_KEY_SCOPE_REQUIRED", `This API key does not include the ${requiredScope} scope.`)
  }
  const subscription = await subscriptionForUser(user.id)
  const entitlement = entitlementFor(subscription)
  if (!entitlement.access) throw new ApiError(402, "SUBSCRIPTION_REQUIRED", "An active Vector plan is required.")
  if (apiPrincipal) {
    await consumePlatformQuota({
      userId: user.id,
      kind: `api_key_${apiPrincipal.key.id}`,
      limit: apiPrincipal.key.daily_unit_limit,
      windowSeconds: 86_400,
      message: "This Vector API key reached its daily request limit.",
      metadata: { keyId: apiPrincipal.key.id, scope: requiredScope || null },
    })
  }
  return { user, subscription: subscription!, entitlement, apiKey: apiPrincipal?.key }
}

export async function consumePlatformQuota(input: {
  userId: string
  kind: string
  units?: number
  limit: number
  windowSeconds: number
  message: string
  metadata?: Record<string, unknown>
}) {
  const { data, error } = await platformAdmin().rpc("vector_consume_quota", {
    p_user_id: input.userId,
    p_kind: input.kind,
    p_units: input.units || 1,
    p_limit: input.limit,
    p_window_seconds: input.windowSeconds,
    p_metadata: input.metadata || {},
  })
  if (error) throw new ApiError(500, "QUOTA_CHECK_FAILED", "Vector could not verify this account's usage limit.")
  if (!data) throw new ApiError(429, "RATE_LIMITED", input.message)
}
