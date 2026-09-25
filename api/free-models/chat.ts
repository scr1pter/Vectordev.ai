import type { ApiRequest, ApiResponse } from "../_lib/http.js"
import { handleFreeModelsChat } from "../_lib/free-models-chat.js"
export const maxDuration = 800
export const config = { api: { bodyParser: false } }
export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleFreeModelsChat(request, response)
}
