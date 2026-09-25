import { providerAllowed } from "@vectordevai/schema/provider-policy"
export { providerAllowed, providerUsable } from "@vectordevai/schema/provider-policy"

// Re-enabling these requires Vector-owned registrations and provider approval.
export const COPILOT_SIGN_IN = false
export const CHATGPT_SIGN_IN = false
export const XAI_SIGN_IN = false
export const POE_SIGN_IN = false
export const DIGITALOCEAN_SIGN_IN = false
export const GITLAB_SIGN_IN = false

export function gitlabSignInEnabled() {
  return GITLAB_SIGN_IN && Boolean(process.env.GITLAB_OAUTH_CLIENT_ID?.trim())
}

export function providerOAuthAllowed(id: string, userDefined = false) {
  if (!providerAllowed(id) && !userDefined) return false
  if (id.startsWith("github-copilot")) return COPILOT_SIGN_IN
  if (id === "openai") return CHATGPT_SIGN_IN
  if (id === "xai") return XAI_SIGN_IN
  if (id === "poe") return POE_SIGN_IN
  if (id === "digitalocean") return DIGITALOCEAN_SIGN_IN
  if (id === "gitlab") return gitlabSignInEnabled()
  return providerAllowed(id) || userDefined
}

export function providerCredentialAllowed(
  id: string,
  credential: { type: string; clientId?: string; metadata?: Readonly<Record<string, unknown>> },
  userDefined = false,
) {
  if (!providerAllowed(id) && !userDefined) return false
  // The retired DigitalOcean flow persisted its OAuth access token as an API key.
  if (id === "digitalocean" && !DIGITALOCEAN_SIGN_IN && credential.metadata?.oauth_access) return false
  if (id === "gitlab" && credential.type === "oauth") {
    return (
      gitlabSignInEnabled() &&
      (credential.clientId ?? credential.metadata?.oauth_client_id) === process.env.GITLAB_OAUTH_CLIENT_ID?.trim()
    )
  }
  return credential.type !== "oauth" || providerOAuthAllowed(id, userDefined)
}
