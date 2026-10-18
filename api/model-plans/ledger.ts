import { handleCodiumLedger } from "../_lib/codium-ledger.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

// Owner only: needs CODIUM_OWNER_SECRET, and answers 404 to everyone else.
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleCodiumLedger(request, response)
}
