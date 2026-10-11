import { requireAccountUser } from "./account.js"
import { modelPlanStatus } from "./model-plan-account.js"
import { requireModelPlanUser } from "./model-plan-chat.js"
import { modelPlansEnabled } from "./model-plan-config.js"
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
      json(response, 200, { enabled, active: false, access: false, wallet: { credits: 0, used: 0, remaining: 0 } })
      return
    }
    json(response, 200, { enabled, ...(await modelPlanStatus(account.id, fetcher)) })
  } catch (error) {
    handleApiError(response, error)
  }
}
