import {
  exchangeOAuthCode,
  isCloudOAuthProvider,
  jsonResponse,
} from "./_oauth.js"

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." })
  }
  const body = (await request.json().catch(() => undefined)) as
    | { provider?: unknown; code?: unknown; state?: unknown; codeVerifier?: unknown }
    | undefined
  if (!isCloudOAuthProvider(body?.provider) || body.provider === "netlify") {
    return jsonResponse(400, { ok: false, error: "This exchange supports Vercel and Supabase." })
  }
  if (typeof body?.code !== "string") {
    return jsonResponse(400, { ok: false, error: "An authorization code is required." })
  }
  if (typeof body?.state !== "string") {
    return jsonResponse(400, { ok: false, error: "A signed OAuth state is required." })
  }
  try {
    const token = await exchangeOAuthCode(
      {
        provider: body.provider,
        code: body.code,
        state: body.state,
        codeVerifier: typeof body.codeVerifier === "string" ? body.codeVerifier : undefined,
      },
      request.url,
      process.env,
    )
    return jsonResponse(200, { ok: true, ...token })
  } catch (error) {
    return jsonResponse(502, {
      ok: false,
      error: error instanceof Error ? error.message : "The provider token exchange failed.",
    })
  }
}
