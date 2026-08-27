import type { CloudProviderConnection, CloudProviderId } from "./cloud-api"

export type CloudProviderConnectionMode = "checking" | "connected" | "oauth" | "token" | "unavailable"

export function cloudProviderConnectionMode(connection?: CloudProviderConnection): CloudProviderConnectionMode {
  if (!connection) return "checking"
  if (connection?.connected) return "connected"
  if (connection?.configured) return "oauth"
  if (connection?.manualTokenSupported) return "token"
  return "unavailable"
}

export function cloudProviderTokenGuide(provider: CloudProviderId) {
  if (provider === "vercel") {
    return {
      url: "https://vercel.com/account/settings/tokens",
      location: "Vercel → Personal Account → Settings → Tokens",
      instruction: "Create a token that can access the team and projects you want Vector to manage.",
      placeholder: "Paste your Vercel access token",
    }
  }
  if (provider === "netlify") {
    return {
      url: "https://app.netlify.com/user/applications#personal-access-tokens",
      location: "Netlify → User settings → Applications → Personal access tokens",
      instruction: "Create a personal access token for the account and sites you want Vector to manage.",
      placeholder: "Paste your Netlify personal access token",
    }
  }
  return {
    url: "https://supabase.com/dashboard/account/tokens",
    location: "Supabase → Account → Access Tokens",
    instruction: "Create a personal access token for the organizations and projects you want Vector to manage.",
    placeholder: "Paste your Supabase personal access token",
  }
}
