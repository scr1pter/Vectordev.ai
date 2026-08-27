import { listVectorLicences, requireOperator, searchLicences, summarise } from "../_lib/admin.js"
import { stripeClient } from "../_lib/billing.js"
import { handleApiError, json, queryValue, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

// GET /api/admin/licenses            every Vector licence plus the counts
// GET /api/admin/licenses?q=<text>   filtered by email, customer id or device
// GET /api/admin/licenses?customer=<id>  one licence in full
//
// The summary is computed over the WHOLE set, never over the filtered view, so
// a search box cannot silently change what "how many customers do I have"
// answers.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    requireOperator(request)
    const stripe = stripeClient()
    const licences = await listVectorLicences(stripe)
    const summary = summarise(licences)

    const customerId = queryValue(request, "customer")
    if (customerId) {
      const licence = licences.find((entry) => entry.customerId === customerId)
      if (!licence) {
        json(response, 404, { error: { code: "LICENSE_NOT_FOUND", message: "No Vector licence for that customer." } })
        return
      }
      json(response, 200, { licence })
      return
    }

    const query = queryValue(request, "q") ?? ""
    json(response, 200, { summary, licences: searchLicences(licences, query) })
  } catch (error) {
    handleApiError(response, error)
  }
}
