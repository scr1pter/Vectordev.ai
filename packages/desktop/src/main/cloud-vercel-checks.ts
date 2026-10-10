import { VECTOR_USER_AGENT } from "./user-agent"
import type { VercelFetch } from "./cloud-vercel-api"

// Vercel Deployment Protection puts previews (and, with Standard Protection,
// every generated deployment URL) behind Vercel Authentication or a password.
// A check that cannot get past it has not found a broken release, so it is
// told apart from a real failure. With a Protection Bypass for Automation
// secret the check sends `x-vercel-protection-bypass` and sees the real app
// (https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).

export type VercelProbe = {
  kind: "ok" | "failed" | "protected"
  statusCode?: number
  error?: string
  latencyMs: number
}

const MAX_REDIRECTS = 5

export function protectionBypassHeaders(secret?: string): Record<string, string> {
  return secret ? { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" } : {}
}

export async function probeVercelUrl(
  url: string,
  options: { bypass?: string; projectProtected?: boolean; request?: VercelFetch; timeoutMs?: number } = {},
): Promise<VercelProbe> {
  const startedAt = Date.now()
  let current = url
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await (options.request ?? fetch)(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": VECTOR_USER_AGENT, ...protectionBypassHeaders(options.bypass) },
        signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
      })
      const location = response.headers.get("location")
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined)
        const next = new URL(location, current)
        if (isVercelLogin(next))
          return { kind: "protected", statusCode: response.status, latencyMs: Date.now() - startedAt }
        current = next.toString()
        continue
      }
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return { kind: "ok", statusCode: response.status, latencyMs: Date.now() - startedAt }
      }
      const body = response.status === 401 || response.status === 403 ? await response.text().catch(() => "") : ""
      if (body === "") await response.body?.cancel().catch(() => undefined)
      if (protectedResponse(response, body, options.projectProtected)) {
        return { kind: "protected", statusCode: response.status, latencyMs: Date.now() - startedAt }
      }
      return {
        kind: "failed",
        statusCode: response.status,
        error: `HTTP ${response.status} ${response.statusText}`.trim(),
        latencyMs: Date.now() - startedAt,
      }
    }
    return { kind: "failed", error: "Too many redirects.", latencyMs: Date.now() - startedAt }
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    }
  }
}

function isVercelLogin(url: URL) {
  return url.hostname === "vercel.com" && (url.pathname.startsWith("/sso-api") || url.pathname.startsWith("/login"))
}

// Vercel Authentication answers 401 with an `_vercel_sso_nonce` cookie and a
// page that forwards to vercel.com/sso-api. Password Protection answers 401 on
// a project whose settings say it is protected.
function protectedResponse(response: Response, body: string, projectProtected?: boolean) {
  if (response.status !== 401 && response.status !== 403) return false
  if ((response.headers.get("set-cookie") ?? "").includes("_vercel_sso_nonce")) return true
  if (body.includes("vercel.com/sso-api") || body.includes("_vercel_sso")) return true
  return response.status === 401 && projectProtected === true
}
