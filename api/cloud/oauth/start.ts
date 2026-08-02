import {
  createOAuthAuthorizeUrl,
  isCloudOAuthProvider,
  jsonResponse,
} from "./_oauth.js"

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." })
  }
  const body = (await request.json().catch(() => undefined)) as
    | { provider?: unknown; state?: unknown; codeChallenge?: unknown }
    | undefined
  if (!isCloudOAuthProvider(body?.provider)) {
    return jsonResponse(400, { ok: false, error: "Choose vercel, netlify, or supabase." })
  }
  if (typeof body?.state !== "string") {
    return jsonResponse(400, { ok: false, error: "A secure OAuth state value is required." })
  }
  try {
    const result = createOAuthAuthorizeUrl(
      {
        provider: body.provider,
        state: body.state,
        codeChallenge: typeof body.codeChallenge === "string" ? body.codeChallenge : undefined,
      },
      request.url,
      process.env,
    )
    return jsonResponse(200, { ok: true, ...result })
  } catch (error) {
    return jsonResponse(503, {
      ok: false,
      error: error instanceof Error ? error.message : "OAuth is not configured.",
    })
  }
}
