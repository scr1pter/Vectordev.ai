import { createOAuthCallbackResponse } from "./_oauth.js"

export function GET(request: Request): Response {
  return createOAuthCallbackResponse("netlify", request.url)
}
