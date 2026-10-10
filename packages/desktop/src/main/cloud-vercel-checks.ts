import { VECTOR_USER_AGENT } from "./user-agent"
import type { VercelFetch } from "./cloud-vercel-api"
import type { VercelProtection } from "./cloud-vercel-projects"

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

// The bypass secret opens every protected deployment of the project, so it
// only goes to the origin the check was pointed at. A redirect to a sign-in
// provider, or to any other host, never receives it.
export function bypassHeadersFor(requestUrl: string, checkedUrl: string, headers: Record<string, string>) {
  return URL.canParse(requestUrl) &&
    URL.canParse(checkedUrl) &&
    new URL(requestUrl).origin === new URL(checkedUrl).origin
    ? headers
    : {}
}

// Vercel Authentication set to "preview" leaves production deployment URLs
// open; the stricter modes and Password Protection cover every generated URL.
export function protectsDeployment(protection: VercelProtection | undefined, target: "production" | "preview") {
  if (!protection) return false
  if (protection.passwordProtection) return true
  if (!protection.vercelAuthentication) return false
  return target === "preview" || protection.vercelAuthentication !== "preview"
}

export async function probeVercelUrl(
  url: string,
  options: { bypass?: string; projectProtected?: boolean; request?: VercelFetch; timeoutMs?: number } = {},
): Promise<VercelProbe> {
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  // Redirects are followed by hand, so a hop to Vercel's sign-in page reads as
  // protection and the bypass header stays with the checked origin.
  const hop = async (current: string, redirects: number): Promise<VercelProbe> => {
    if (redirects > MAX_REDIRECTS) return { kind: "failed", error: "Too many redirects.", latencyMs: elapsed() }
    const response = await (options.request ?? fetch)(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": VECTOR_USER_AGENT,
        ...bypassHeadersFor(current, url, protectionBypassHeaders(options.bypass)),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
    })
    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined)
      const next = new URL(location, current)
      if (isVercelLogin(next)) return { kind: "protected", statusCode: response.status, latencyMs: elapsed() }
      return hop(next.toString(), redirects + 1)
    }
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { kind: "ok", statusCode: response.status, latencyMs: elapsed() }
    }
    const body = response.status === 401 || response.status === 403 ? await response.text().catch(() => "") : ""
    if (body === "") await response.body?.cancel().catch(() => undefined)
    if (protectedResponse(response, body, options.projectProtected)) {
      return { kind: "protected", statusCode: response.status, latencyMs: elapsed() }
    }
    return {
      kind: "failed",
      statusCode: response.status,
      error: `HTTP ${response.status} ${response.statusText}`.trim(),
      latencyMs: elapsed(),
    }
  }
  return hop(url, 0).catch((error: unknown) => ({
    kind: "failed" as const,
    error: error instanceof Error ? error.message : String(error),
    latencyMs: elapsed(),
  }))
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
