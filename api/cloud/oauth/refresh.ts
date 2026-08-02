import { jsonResponse, refreshSupabaseOAuthToken } from "./_oauth.js"

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." })
  }
  const body = (await request.json().catch(() => undefined)) as
    | { provider?: unknown; refreshToken?: unknown }
    | undefined
  if (body?.provider !== "supabase" || typeof body.refreshToken !== "string") {
    return jsonResponse(400, { ok: false, error: "A Supabase refresh token is required." })
  }
  try {
    const token = await refreshSupabaseOAuthToken(body.refreshToken, request.url, process.env)
    return jsonResponse(200, { ok: true, ...token })
  } catch (error) {
    return jsonResponse(502, {
      ok: false,
      error: error instanceof Error ? error.message : "The provider token refresh failed.",
    })
  }
}
