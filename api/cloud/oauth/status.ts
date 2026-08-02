import {
  jsonResponse,
  oauthProviderConfig,
  type CloudOAuthProvider,
} from "./_oauth.js"

export function GET(request: Request): Response {
  if (request.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use GET." })
  }
  const providers: CloudOAuthProvider[] = ["vercel", "netlify", "supabase"]
  return jsonResponse(200, {
    ok: true,
    providers: providers.map((provider) => {
      const config = oauthProviderConfig(provider, request.url, process.env)
      return {
        provider,
        configured: config.configured,
        callbackUrl: config.callbackUrl,
        missing: config.missing,
      }
    }),
  })
}
