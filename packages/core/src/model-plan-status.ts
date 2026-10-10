export * as ModelPlanStatus from "./model-plan-status"

import { Option, Schema } from "effect"

export const SITE = "https://vectordev.ai"
export const API_URL = `${SITE}/api/model-plans`
export const STATUS_URL = `${API_URL}/status`
export const PURCHASE_URL = `${SITE}/codium`
export const MANAGE_URL = `${SITE}/account`
/** Customer-facing Codium credits per USD of model credit. A display conversion only; the gateway accounts in USD. */
export const CREDITS_PER_USD = 100

const Remote = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  active: Schema.Boolean,
  access: Schema.Boolean,
  plan: Schema.optional(Schema.String),
  credits: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  periodEnd: Schema.optional(Schema.Number),
  cancelAtPeriodEnd: Schema.optional(Schema.Boolean),
  wallet: Schema.optional(Schema.Struct({ credits: Schema.Number, remaining: Schema.optional(Schema.Number) })),
})

export type Status = {
  signedIn: boolean
  /** Whether vectordev.ai currently sells Codium and serves its models. */
  enabled: boolean
  /** Whether the account can start a Codium model request right now. */
  access: boolean
  plan?: {
    id: string
    name: string
    credits: number
    remaining?: number
    renewsAt: number
    cancelAtPeriodEnd: boolean
  }
  purchased: { credits: number; remaining?: number }
  /** Monthly plus purchased credits left, when the gateway could verify both. */
  remaining?: number
  low: boolean
  error?: string
}

const EMPTY: Status = { signedIn: false, enabled: false, access: false, purchased: { credits: 0 }, low: false }

/** Reads the signed-in account's Codium plan and balances. The token is only ever sent to vectordev.ai. */
export async function fetchStatus(
  token: string | undefined,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Status> {
  if (!token) return EMPTY
  const response = await request(STATUS_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (response?.status === 401) return { ...EMPTY, error: "Your Vector sign-in expired. Sign in again." }
  const decoded = response?.ok
    ? Schema.decodeUnknownOption(Remote)(await response.json().catch(() => undefined))
    : Option.none()
  if (Option.isNone(decoded))
    return { ...EMPTY, signedIn: true, error: "Vector could not load your Codium balance. Try again shortly." }
  return fromRemote(decoded.value)
}

export function fromRemote(remote: typeof Remote.Type): Status {
  const plan =
    remote.active && remote.plan && remote.credits !== undefined && remote.periodEnd !== undefined
      ? {
          id: remote.plan,
          name: planName(remote.plan),
          credits: credits(remote.credits),
          remaining: remote.remaining === undefined ? undefined : credits(remote.remaining),
          renewsAt: remote.periodEnd,
          cancelAtPeriodEnd: remote.cancelAtPeriodEnd === true,
        }
      : undefined
  const purchased = {
    credits: credits(remote.wallet?.credits ?? 0),
    remaining: remote.wallet?.remaining === undefined ? undefined : credits(remote.wallet.remaining),
  }
  const known =
    (!plan || plan.remaining !== undefined) && (purchased.credits === 0 || purchased.remaining !== undefined)
  const remaining = known
    ? (plan?.remaining ?? 0) + (purchased.credits === 0 ? 0 : (purchased.remaining ?? 0))
    : undefined
  const granted = (plan?.credits ?? 0) + purchased.credits
  return {
    signedIn: true,
    enabled: remote.enabled !== false,
    access: remote.access,
    plan,
    purchased,
    remaining,
    // Low means under a tenth of what the account was granted, or under 50 credits, while some remain.
    low: remaining !== undefined && remaining > 0 && remaining < Math.max(50, granted / 10),
  }
}

/** "vector-20" is the Codium 20 subscription. */
export function planName(id: string) {
  const price = /^vector-(\d+)$/.exec(id)?.[1]
  return price ? `Codium ${price}` : id
}

// Round down so a balance is never overstated.
function credits(usd: number) {
  if (!Number.isFinite(usd) || usd <= 0) return 0
  return Math.floor(usd * CREDITS_PER_USD + 1e-6)
}

export function formatCredits(value: number) {
  return value.toLocaleString("en-US")
}

export function formatDate(time: number) {
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** Plain-language lines for the CLI and other text surfaces. */
export function describe(status: Status) {
  if (!status.signedIn) return [status.error ?? 'Not signed in. Run "vector login" to use Vector Codium.']
  if (status.error) return [status.error]
  const plan = status.plan
  const lines = [
    plan
      ? `Plan: ${plan.name}, ${plan.remaining === undefined ? "balance unavailable" : `${formatCredits(plan.remaining)} of ${formatCredits(plan.credits)} monthly credits left`}, ${plan.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDate(plan.renewsAt)}`
      : "Plan: none",
    status.purchased.credits
      ? `Purchased credits: ${status.purchased.remaining === undefined ? "balance unavailable" : `${formatCredits(status.purchased.remaining)} of ${formatCredits(status.purchased.credits)} left`}`
      : "Purchased credits: none",
  ]
  if (!status.enabled) return [...lines, "Vector Codium is not available yet."]
  if (!status.access) return [...lines, "You have no Codium credits available. Buy credits to use Codium models."]
  if (status.low) return [...lines, "You are running low on Codium credits."]
  return lines
}

/** The action a failed Vector Codium turn offers, read from the session error the engine recorded. */
export function failureAction(error: unknown): "credits" | "sign-in" | "unavailable" | undefined {
  if (!error || typeof error !== "object" || !("name" in error) || error.name !== "APIError" || !("data" in error))
    return
  const metadata =
    error.data && typeof error.data === "object" && "metadata" in error.data ? error.data.metadata : undefined
  const kind = metadata && typeof metadata === "object" && "codium" in metadata ? metadata.codium : undefined
  return kind === "credits" || kind === "sign-in" || kind === "unavailable" ? kind : undefined
}
