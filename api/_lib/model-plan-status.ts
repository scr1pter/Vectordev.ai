import { requireAccountUser } from "./account.js"
import { modelPlanStatus } from "./model-plan-account.js"
import { requireModelPlanUser } from "./model-plan-chat.js"
import {
  configuredPlanModels,
  modelPlanRequestCredits,
  modelPlans,
  modelPlansEnabled,
  modelTopups,
} from "./model-plan-config.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"

export async function handleModelPlanStatus(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    // The website signs in with a browser session; the desktop app and CLI hold a signed Vector account token,
    // verified and checked against revocation exactly as model requests are.
    const account = /^Bearer vct_/.test(String(request.headers.authorization ?? ""))
      ? await requireModelPlanUser(request, fetcher)
      : await requireAccountUser(request, fetcher)
    const enabled = modelPlansEnabled()
    if (!process.env.STRIPE_SECRET_KEY) {
      json(response, 200, {
        enabled,
        active: false,
        access: false,
        purchased: { bought: false },
        empty: true,
        low: false,
      })
      return
    }
    json(response, 200, { enabled, ...modelPlanBalance(await modelPlanStatus(account.id, fetcher)) })
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * The account's own Codium balances as every Vector screen shows them: the whole-percent share of this month's credits
 * left, the purchased credits' state, and whether the credits are running low or too low for any request. The gateway
 * accounts in provider-cost USD; an amount beside a purchase price would reveal what the purchase buys, so no amount,
 * and no fixed-amount threshold whose share would give one away, leaves the server.
 */
export function modelPlanBalance(status: Awaited<ReturnType<typeof modelPlanStatus>>) {
  const monthly = status.active ? status.remaining : 0
  const remaining =
    monthly === undefined || status.wallet.remaining === undefined ? undefined : monthly + status.wallet.remaining
  // The gateway refuses a request unless the credits available cover the model's largest request, so below the
  // cheapest such amount in the catalog every request is refused.
  const requests = configuredPlanModels().map(modelPlanRequestCredits)
  const cheapest = requests.length ? Math.min(...requests) : 0
  // Running low scales with what was bought: a tenth of this month's credits, or of the smallest top-up.
  const smallest =
    modelTopups()
      .map((pack) => pack.credits)
      .filter((credits) => credits > 0)
      .sort((a, b) => a - b)[0] ?? 0
  const empty = remaining !== undefined && (remaining <= 0 || remaining < cheapest)
  return {
    active: status.active,
    ...(status.customer ? { customer: true } : {}),
    access: status.access,
    ...(status.active
      ? {
          plan: {
            id: status.plan,
            name: modelPlans().find((plan) => plan.id === status.plan)?.name ?? status.plan,
            ...(status.remaining === undefined ? {} : { left: share(status.remaining, status.credits) }),
            renewsAt: status.periodEnd,
            cancelAtPeriodEnd: status.cancelAtPeriodEnd,
          },
        }
      : {}),
    purchased: {
      bought: status.wallet.credits > 0,
      ...(status.wallet.credits > 0 && status.wallet.remaining !== undefined
        ? { state: purchasedState(status.wallet.remaining, cheapest, smallest) }
        : {}),
    },
    empty,
    low: !empty && remaining !== undefined && remaining < Math.max(status.active ? status.credits : 0, smallest) / 10,
  }
}

// Purchased credits pool every top-up ever bought, so they answer a state, not a share of that pool, which would read
// "8% left" for a repeat buyer right after a fresh purchase. They are used up once they cannot cover the cheapest
// model's largest request, and running low starts under a tenth of the smallest top-up, as the account's own flag
// does, so the state reveals no allowance however much was bought.
function purchasedState(remaining: number, cheapest: number, smallest: number) {
  if (remaining <= 0 || remaining < cheapest) return "used" as const
  if (remaining < smallest / 10) return "low" as const
  return "available" as const
}

function share(left: number, total: number) {
  return total > 0 ? Math.round(Math.min(1, Math.max(0, left / total)) * 100) / 100 : 0
}
