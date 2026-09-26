import { providerUnavailable } from "@vectordevai/schema/provider-unavailable"
import { COPILOT_SIGN_IN, providerAllowed, providerEnabled } from "@vectordevai/schema/provider-policy"
export { COPILOT_SIGN_IN, providerAllowed, providerEnabled, providerUsable } from "@vectordevai/schema/provider-policy"

// Re-enabling these requires Vector-owned registrations and provider approval.
export const CHATGPT_SIGN_IN = false
export const XAI_SIGN_IN = false
export const POE_SIGN_IN = false
export const DIGITALOCEAN_SIGN_IN = false
export const GITLAB_SIGN_IN = false

// Register a separate, least-privilege Vector application after Copilot partner approval.
export const COPILOT_CLIENT_ID = ""
export function copilotOAuthConfiguration(environment: NodeJS.ProcessEnv = process.env, enabled = COPILOT_SIGN_IN) {
  if (!enabled) return
  const clientId = environment.VECTOR_COPILOT_OAUTH_CLIENT_ID?.trim() || COPILOT_CLIENT_ID
  if (!/^[A-Za-z0-9._-]{8,256}$/.test(clientId)) return
  return {
    clientId,
    origin: "https://github.com",
    devicePath: "/login/device/code",
    tokenPath: "/login/oauth/access_token",
    verificationPath: "/login/device",
    scope: "read:user",
  }
}
export function ownedOAuthMatches(
  credential: { clientId?: string; enterpriseUrl?: string; metadata?: Readonly<Record<string, unknown>> },
  configuration: { clientId: string; origin: string } | undefined,
) {
  return Boolean(
    configuration &&
      (credential.clientId ?? credential.metadata?.oauth_client_id) === configuration.clientId &&
      (credential.enterpriseUrl ?? credential.metadata?.oauth_instance_url) === configuration.origin,
  )
}

export const XAI_CLIENT_ID = ""
export const XAI_REDIRECT_URI = "http://127.0.0.1:1457/oauth/xai/callback"
export function xaiOAuthConfiguration(environment: NodeJS.ProcessEnv = process.env, enabled = XAI_SIGN_IN) {
  if (!enabled) return
  const clientId = environment.VECTOR_XAI_OAUTH_CLIENT_ID?.trim() || XAI_CLIENT_ID
  const redirectUri = environment.VECTOR_XAI_OAUTH_REDIRECT_URI?.trim() || XAI_REDIRECT_URI
  const redirect = URL.parse(redirectUri)
  if (
    !/^[A-Za-z0-9._-]{8,256}$/.test(clientId) ||
    !redirect ||
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port ||
    Number(redirect.port) < 1024 ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    return
  return {
    clientId,
    origin: "https://auth.x.ai",
    devicePath: "/oauth2/device/code",
    tokenPath: "/oauth2/token",
    scope: "openid profile email offline_access api:access",
    redirectUri: redirect.href,
  }
}

// Candidate from the desktop registration. Duo reuse remains disabled until
// ownership and device-grant configuration are confirmed; see owner-actions/gitlab.md.
export const GITLAB_DEFAULT_CLIENT_ID = "8ac2300994dbece9bfc889ee6705f4ab8a8243b9acd04fe6185172528abc8edd"

export function gitlabOAuthConfiguration(environment: NodeJS.ProcessEnv = process.env, enabled = GITLAB_SIGN_IN) {
  if (!enabled) return
  const origin = URL.parse(environment.GITLAB_INSTANCE_URL?.trim() || "https://gitlab.com")
  if (
    !origin ||
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    return
  const override = environment.GITLAB_OAUTH_CLIENT_ID?.trim()
  const clientId = override || (origin.origin === "https://gitlab.com" ? GITLAB_DEFAULT_CLIENT_ID : undefined)
  if (!clientId || !/^[a-f0-9]{64}$/.test(clientId)) return
  return { origin: origin.origin, clientId }
}

export function gitlabCredentialMatches(
  credential: { clientId?: string; enterpriseUrl?: string; metadata?: Readonly<Record<string, unknown>> },
  configuration: ReturnType<typeof gitlabOAuthConfiguration>,
) {
  return Boolean(
    configuration &&
      (credential.clientId ?? credential.metadata?.oauth_client_id) === configuration.clientId &&
      (credential.enterpriseUrl ?? credential.metadata?.oauth_instance_url) === configuration.origin,
  )
}

export function gitlabSignInEnabled() {
  return Boolean(gitlabOAuthConfiguration())
}

export function requireGitlabOAuthEndpoint(
  credential: Parameters<typeof gitlabCredentialMatches>[0],
  options: { instanceUrl?: unknown; baseURL?: unknown },
  configuration = gitlabOAuthConfiguration(),
) {
  if (!configuration || !gitlabCredentialMatches(credential, configuration))
    throw new Error("This GitLab token belongs to another application or instance. Sign in again.")
  for (const value of [options.instanceUrl, options.baseURL]) {
    if (value === undefined || value === "") continue
    const url = typeof value === "string" ? URL.parse(value) : null
    if (!url || url.origin !== configuration.origin || url.username || url.password)
      throw new Error(
        "GitLab OAuth cannot use a different instance URL. Restore the signed-in instance or sign in again.",
      )
  }
  return configuration.origin
}

export function providerOAuthAllowed(id: string, userDefined = false) {
  if (!providerEnabled(id) || (!providerAllowed(id) && !userDefined)) return false
  if (id.startsWith("github-copilot")) return Boolean(copilotOAuthConfiguration())
  if (id === "openai") return CHATGPT_SIGN_IN
  if (id === "xai") return Boolean(xaiOAuthConfiguration())
  if (id === "poe") return POE_SIGN_IN
  if (id === "digitalocean") return DIGITALOCEAN_SIGN_IN
  if (id === "gitlab") return gitlabSignInEnabled()
  return providerAllowed(id) || userDefined
}

export function providerCredentialAllowed(
  id: string,
  credential: { type: string; clientId?: string; enterpriseUrl?: string; metadata?: Readonly<Record<string, unknown>> },
  userDefined = false,
) {
  if (!providerEnabled(id) || (!providerAllowed(id) && !userDefined)) return false
  if (id.startsWith("github-copilot") && credential.type === "oauth")
    return ownedOAuthMatches(credential, copilotOAuthConfiguration())
  if (id === "xai" && credential.type === "oauth") return ownedOAuthMatches(credential, xaiOAuthConfiguration())
  // The retired DigitalOcean flow persisted its OAuth access token as an API key.
  if (id === "digitalocean" && !DIGITALOCEAN_SIGN_IN && credential.metadata?.oauth_access) return false
  if (id === "gitlab" && credential.type === "oauth") {
    return gitlabCredentialMatches(credential, gitlabOAuthConfiguration())
  }
  return credential.type !== "oauth" || providerOAuthAllowed(id, userDefined)
}

export function providerCredentialUnavailable(
  id: string,
  credential: { type: string; clientId?: string; enterpriseUrl?: string; metadata?: Readonly<Record<string, unknown>> },
  userDefined = false,
) {
  if (credential.type === "wellknown") return
  if (!providerEnabled(id)) return providerUnavailable(id, "sign-in-paused")
  if (!providerAllowed(id) && !userDefined) return providerUnavailable(id, "provider-not-configured")
  if (!providerCredentialAllowed(id, credential, userDefined)) return providerUnavailable(id, "sign-in-paused")
}
