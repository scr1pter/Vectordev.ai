import { modelPlanStatus } from "./model-plan-account.js"
import { requireBillingUser } from "./model-plan-billing.js"
import { configuredPlanModels, modelPlanRequestCredits, modelPlans, modelPlansEnabled } from "./model-plan-config.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"

export async function handleModelPlanStatus(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    // The website signs in with a browser session; the desktop app and CLI hold a signed Vector account token.
    const account = await requireBillingUser(request, fetcher)
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
 * The account's own Codium balance as every Vector screen shows it: the whole-percent share of this month's credits
 * left, and whether the credits are running low or too low for any request. The gateway accounts in provider-cost USD;
 * an amount beside a plan's price would reveal what the plan buys, so no amount, and no fixed-amount threshold whose
 * share would give one away, leaves the server.
 */
export function modelPlanBalance(status: Awaited<ReturnType<typeof modelPlanStatus>>) {
  const remaining = status.active ? status.remaining : 0
  // The gateway refuses a request unless the credits available cover the model's largest request, so below the
  // cheapest such amount in the catalog every request is refused.
  const requests = configuredPlanModels().map(modelPlanRequestCredits)
  const cheapest = requests.length ? Math.min(...requests) : 0
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
    // Codium sells monthly plans only (no top-ups). Decoders up to 1.99.112 require this field, so it is always sent,
    // and always says nothing was bought (H7).
    purchased: { bought: false as const },
    empty,
    // Running low is a tenth of this month's credits.
    low: !empty && remaining !== undefined && remaining < (status.active ? status.credits : 0) / 10,
  }
}

function share(left: number, total: number) {
  return total > 0 ? Math.round(Math.min(1, Math.max(0, left / total)) * 100) / 100 : 0
}
