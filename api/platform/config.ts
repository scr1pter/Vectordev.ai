import { billingConfiguration } from "../_lib/billing.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { enabledPlatformAuthProviders, platformConfiguration, platformUsageLimits } from "../_lib/platform.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const platform = platformConfiguration()
    const authProviders = await enabledPlatformAuthProviders()
    json(response, 200, {
      auth: {
        available: platform.authAvailable,
        url: platform.url,
        publishableKey: platform.publishableKey,
        providers: authProviders,
      },
      services: {
        builder: platform.builderAvailable,
        billing: billingConfiguration().available,
      },
      builderModel: platform.model || null,
      limits: platformUsageLimits(),
      plans: billingConfiguration().plans,
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
