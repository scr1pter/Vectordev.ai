import { billingConfiguration } from "../_lib/billing.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { platformConfiguration, platformUsageLimits } from "../_lib/platform.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const platform = platformConfiguration()
    json(response, 200, {
      auth: {
        available: platform.authAvailable,
        url: platform.url,
        publishableKey: platform.publishableKey,
        providers: platform.authProviders,
      },
      services: {
        apiPlatform: platform.apiPlatformAvailable,
        cloudAgents: platform.cloudAgentsAvailable,
        billing: billingConfiguration().available,
      },
      cloudModel: platform.model || null,
      limits: platformUsageLimits(),
      plans: billingConfiguration().plans,
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
