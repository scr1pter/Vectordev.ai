export * as ModelPlanStatus from "./model-plan-status"

import { Option, Schema } from "effect"

export const SITE = "https://vectordev.ai"
export const API_URL = `${SITE}/api/model-plans`
export const STATUS_URL = `${API_URL}/status`
export const PURCHASE_URL = `${SITE}/codium`
export const MANAGE_URL = `${SITE}/account`
// The stable internal ID stays "vector-plan"; people see the provider as Vector Codium.
export const PROVIDER_ID = "vector-plan"
/**
 * Codium credits per USD of model credit, the unit balances are kept in here. Screens show the share of the monthly
 * grant left and a state for purchased credits, never an amount. That keeps amounts off screens; it is not a secret
 * from the subscriber, whose own status response carries the USD balances.
 */
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
  /** Every credit is spent, including a subscriber's monthly credits before they renew. */
  empty: boolean
  low: boolean
  error?: string
}

const EMPTY: Status = {
  signedIn: false,
  enabled: false,
  access: false,
  purchased: { credits: 0 },
  empty: false,
  low: false,
}
// Running low warns below a tenth of the monthly grant, and never later than a dollar of usage.
const LOW_FLOOR = CREDITS_PER_USD

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
  return {
    signedIn: true,
    enabled: remote.enabled !== false,
    access: remote.access,
    plan,
    purchased,
    remaining,
    // The server still grants access to an active plan whose monthly credits are spent; this says so plainly.
    empty: remaining === 0,
    // Purchased credits count every top-up ever bought, so only the monthly grant scales the threshold.
    low: remaining !== undefined && remaining > 0 && remaining < Math.max(LOW_FLOOR, (plan?.credits ?? 0) / 10),
  }
}

/** "vector-50" is the Codium 50 subscription. */
export function planName(id: string) {
  const price = /^vector-(\d+)$/.exec(id)?.[1]
  return price ? `Codium ${price}` : id
}

// Round down so a balance is never overstated.
function credits(usd: number) {
  if (!Number.isFinite(usd) || usd <= 0) return 0
  return Math.floor(usd * CREDITS_PER_USD + 1e-6)
}

/** A balance as the share of its grant left, rounded down so it is never overstated. */
export function formatShare(remaining: number, total: number) {
  const share = total > 0 ? Math.floor((remaining / total) * 100) : 0
  return remaining > 0 && share === 0 ? "under 1%" : `${share}%`
}

/**
 * Purchased credits as a state, not a share: they pool every top-up ever bought, so a share of that pool would read
 * "8% left" for a repeat buyer right after a fresh purchase.
 */
export function formatPurchased(purchased: Status["purchased"]) {
  if (!purchased.credits) return "None"
  if (purchased.remaining === undefined) return "Balance unavailable"
  if (purchased.remaining === 0) return "Used up"
  if (purchased.remaining < LOW_FLOOR) return "Running low"
  return "Available"
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
      ? `Plan: ${plan.name}, ${plan.remaining === undefined ? "balance unavailable" : `${formatShare(plan.remaining, plan.credits)} of monthly credits left`}, ${plan.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDate(plan.renewsAt)}`
      : "Plan: none",
    `Purchased credits: ${formatPurchased(status.purchased).toLowerCase()}`,
  ]
  const current = notice(status)
  return current ? [...lines, current.text] : lines
}

/** The one balance message to show next to a signed-in account's Codium balances, if any. */
export function notice(status: Status): { kind: "unavailable" | "empty" | "low"; text: string } | undefined {
  if (!status.enabled) return { kind: "unavailable", text: "Vector Codium is not available yet." }
  const plan = status.plan
  if (status.empty && plan && !plan.cancelAtPeriodEnd)
    return {
      kind: "empty",
      text: `Your monthly Codium credits are used up. They renew on ${formatDate(plan.renewsAt)}; buy credits to keep using Codium models before then.`,
    }
  if (status.empty && plan)
    return {
      kind: "empty",
      text: `Your Codium credits are used up, and your plan ends on ${formatDate(plan.renewsAt)}. Buy credits to keep using Codium models.`,
    }
  if (status.empty || !status.access)
    return { kind: "empty", text: "You have no Codium credits available. Buy credits to use Codium models." }
  if (status.low) return { kind: "low", text: "You are running low on Codium credits." }
}

export type Action = "credits" | "sign-in" | "unavailable"

/**
 * The action a failed Vector Codium turn offers: from the engine's recorded APIError (metadata.codium) or from a
 * Core V2 assistant error ({ type: "codium", action }).
 */
export function failureAction(error: unknown): Action | undefined {
  if (!error || typeof error !== "object") return
  const kind =
    "type" in error && error.type === "codium" && "action" in error
      ? error.action
      : "name" in error && error.name === "APIError" && "data" in error
        ? codiumMetadata(error.data)
        : undefined
  return kind === "credits" || kind === "sign-in" || kind === "unavailable" ? kind : undefined
}

function codiumMetadata(data: unknown) {
  const metadata = data && typeof data === "object" && "metadata" in data ? data.metadata : undefined
  return metadata && typeof metadata === "object" && "codium" in metadata ? metadata.codium : undefined
}

/**
 * The providers an automatic model choice may use, best group first: providers the person connected, then Vector's
 * shared free models. Vector Codium spends the account's credits, so it is never chosen automatically.
 */
export function automaticProviders<
  T extends { id: string; models: Record<string, { freeModel?: { source: string } }> },
>(providers: readonly T[]) {
  const others = providers.filter((provider) => provider.id !== PROVIDER_ID)
  const own = others.filter((provider) =>
    Object.values(provider.models).some((model) => model.freeModel?.source !== "shared"),
  )
  return own.length ? own : others
}
