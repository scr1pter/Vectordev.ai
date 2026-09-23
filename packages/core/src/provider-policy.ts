// Hosted OpenCode providers are deliberately unavailable, including user-supplied keys.
// This also closes the former ZEN_PUBLIC_GATEWAY path in both engines.
export function providerAllowed(id: string) {
  return !id.toLowerCase().startsWith("opencode")
}

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

export function providerOAuthAllowed(id: string) {
  if (id.startsWith("github-copilot")) return COPILOT_SIGN_IN
  if (id === "openai") return CHATGPT_SIGN_IN
  if (id === "xai") return XAI_SIGN_IN
  if (id === "poe") return POE_SIGN_IN
  if (id === "digitalocean") return DIGITALOCEAN_SIGN_IN
  if (id === "gitlab") return gitlabSignInEnabled()
  return providerAllowed(id)
}

export function providerEndpointAllowed(value: unknown) {
  if (typeof value !== "string" || !value) return true
  const hostname = URL.parse(value)?.hostname.toLowerCase()
  // These literals are a denylist, never request destinations.
  return (
    !hostname ||
    !["opencode.ai", "opncd.ai", "models.dev"].some((host) => hostname === host || hostname.endsWith(`.${host}`))
  )
}

export function providerCredentialAllowed(
  id: string,
  credential: { type: string; clientId?: string; metadata?: Readonly<Record<string, unknown>> },
) {
  // The retired DigitalOcean flow persisted its OAuth access token as an API key.
  if (id === "digitalocean" && !DIGITALOCEAN_SIGN_IN && credential.metadata?.oauth_access) return false
  if (id === "gitlab" && credential.type === "oauth") {
    return (
      gitlabSignInEnabled() &&
      (credential.clientId ?? credential.metadata?.oauth_client_id) === process.env.GITLAB_OAUTH_CLIENT_ID?.trim()
    )
  }
  return credential.type !== "oauth" || providerOAuthAllowed(id)
}
