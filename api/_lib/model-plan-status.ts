import { requireAccountUser } from "./account.js"
import { modelPlanStatus } from "./model-plan-account.js"
import { requireModelPlanUser } from "./model-plan-chat.js"
import { configuredPlanModels, modelPlans, modelPlansEnabled, modelTopups } from "./model-plan-config.js"
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
 * The account's own Codium balances as every Vector screen shows them: whole-percent shares of what was bought, and
 * whether the credits are running low or too low for a reply. The gateway accounts in provider-cost USD; an amount
 * beside a purchase price would reveal what the purchase buys, so no amount, and no fixed-amount threshold whose
 * share would give one away, leaves the server.
 */
export function modelPlanBalance(status: Awaited<ReturnType<typeof modelPlanStatus>>) {
  const monthly = status.active ? status.remaining : 0
  const remaining =
    monthly === undefined || status.wallet.remaining === undefined ? undefined : monthly + status.wallet.remaining
  // A Vector turn asks the model for its longest reply, and the gateway refuses a request the credits left cannot pay
  // for in full, so below the cheapest such reply in the catalog every turn is refused.
  const replies = configuredPlanModels().map((model) => (model.maxOutputTokens * model.outputPrice) / 1_000_000)
  const reply = replies.length ? Math.min(...replies) : 0
  // Running low scales with what was bought: a tenth of this month's credits, or of the smallest top-up.
  const smallest =
    modelTopups()
      .map((pack) => pack.credits)
      .filter((credits) => credits > 0)
      .sort((a, b) => a - b)[0] ?? 0
  const empty = remaining !== undefined && (remaining <= 0 || remaining < reply)
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
        ? { left: share(status.wallet.remaining, status.wallet.credits) }
        : {}),
    },
    empty,
    low: !empty && remaining !== undefined && remaining < Math.max(status.active ? status.credits : 0, smallest) / 10,
  }
}

function share(left: number, total: number) {
  return total > 0 ? Math.round(Math.min(1, Math.max(0, left / total)) * 100) / 100 : 0
}
