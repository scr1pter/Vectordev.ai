export * as ModelPlanStatus from "./model-plan-status"

import { Option, Schema } from "effect"

export const SITE = "https://vectordev.ai"
export const API_URL = `${SITE}/api/model-plans`
export const STATUS_URL = `${API_URL}/status`
export const CONFIG_URL = `${API_URL}/config`
export const PURCHASE_URL = `${SITE}/codium`
export const MANAGE_URL = `${SITE}/account`
// The stable internal ID stays "vector-plan"; people see the provider as Vector Codium.
export const PROVIDER_ID = "vector-plan"

const Share = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
// What /api/model-plans/status answers: shares of what was bought and flags the server works out. No credit amount
// leaves vectordev.ai, since an amount beside a purchase price would reveal what the purchase buys.
const Remote = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  access: Schema.Boolean,
  plan: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      left: Schema.optional(Share),
      renewsAt: Schema.Number,
      cancelAtPeriodEnd: Schema.Boolean,
    }),
  ),
  purchased: Schema.Struct({ bought: Schema.Boolean, left: Schema.optional(Share) }),
  empty: Schema.Boolean,
  low: Schema.Boolean,
})

/**
 * The signed-in account's Codium plan and balances, as the account page shows them: each balance is the share of the
 * credits bought that is left, in whole percent, never an amount, since an amount next to the purchase price would
 * reveal what a purchase buys.
 */
export type Status = {
  signedIn: boolean
  /** Whether vectordev.ai currently sells Codium and serves its models. */
  enabled: boolean
  /** Whether the account can start a Codium model request right now. */
  access: boolean
  plan?: {
    id: string
    name: string
    /** The share of this period's monthly credits left, from 0 to 1, when the gateway could verify it. */
    left?: number
    renewsAt: number
    cancelAtPeriodEnd: boolean
  }
  /** Top-up credits: whether any were bought, and the share of everything bought that is left. */
  purchased: { bought: boolean; left?: number }
  /**
   * Too few credits are left for a full reply on any Codium model, including a subscriber's monthly credits before they
   * renew. A turn asks the model for its longest reply, which the gateway refuses when the credits cannot pay for it.
   */
  empty: boolean
  /** Less than a tenth of this month's credits, or of the smallest top-up, is left. */
  low: boolean
  error?: string
}

const EMPTY: Status = {
  signedIn: false,
  enabled: false,
  access: false,
  purchased: { bought: false },
  empty: false,
  low: false,
}
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 })

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

/**
 * Whether vectordev.ai sells Codium now, from its public configuration, for someone who is not signed in; undefined
 * when it cannot tell. Nothing should point at the purchase page while it only says Codium is coming soon.
 */
export async function salesOpen(request: (url: string, init: RequestInit) => Promise<Response> = fetch) {
  const response = await request(CONFIG_URL, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const decoded = response?.ok
    ? Schema.decodeUnknownOption(Schema.Struct({ enabled: Schema.Boolean }))(
        await response.json().catch(() => undefined),
      )
    : Option.none()
  return Option.isSome(decoded) ? decoded.value.enabled : undefined
}

/** The shares and flags the server worked out, as Vector's screens read them. */
export function fromRemote(remote: typeof Remote.Type): Status {
  return {
    signedIn: true,
    enabled: remote.enabled !== false,
    access: remote.access,
    plan: remote.plan && {
      id: remote.plan.id,
      name: remote.plan.name,
      ...(remote.plan.left === undefined ? {} : { left: remote.plan.left }),
      renewsAt: remote.plan.renewsAt,
      cancelAtPeriodEnd: remote.plan.cancelAtPeriodEnd,
    },
    purchased: {
      bought: remote.purchased.bought,
      ...(remote.purchased.bought && remote.purchased.left !== undefined ? { left: remote.purchased.left } : {}),
    },
    empty: remote.empty,
    low: remote.low,
  }
}

/** "42%": the same rounding as the account page, so both show the same figure. */
export function formatShare(value: number) {
  return percent.format(value)
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
      ? `Plan: ${plan.name}, ${plan.left === undefined ? "balance unavailable" : `${formatShare(plan.left)} of this month's credits left`}, ${plan.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDate(plan.renewsAt)}`
      : "Plan: none",
    status.purchased.bought
      ? `Purchased credits: ${status.purchased.left === undefined ? "balance unavailable" : `${formatShare(status.purchased.left)} left`}`
      : "Purchased credits: none",
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
      text: `Too few of your monthly Codium credits are left for a reply. They renew on ${formatDate(plan.renewsAt)}; buy credits to keep using Codium models before then.`,
    }
  if (status.empty && plan)
    return {
      kind: "empty",
      text: `Too few Codium credits are left for a reply, and your plan ends on ${formatDate(plan.renewsAt)}. Buy credits to keep using Codium models.`,
    }
  if (!status.access)
    return { kind: "empty", text: "You have no Codium credits available. Buy credits to use Codium models." }
  if (status.empty)
    return {
      kind: "empty",
      text: "Too few Codium credits are left for a reply. Buy credits to keep using Codium models.",
    }
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
