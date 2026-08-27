import { describe, expect, test } from "bun:test"
import type { CloudProviderConnection } from "./cloud-api"
import { cloudProviderConnectionMode, cloudProviderTokenGuide } from "./cloud-provider-token"

const connection = (input: Partial<CloudProviderConnection>): CloudProviderConnection => ({
  provider: "vercel",
  configured: false,
  connected: false,
  detail: "",
  ...input,
})

describe("cloudProviderConnectionMode", () => {
  test("does not claim a provider is unavailable while status is loading", () => {
    expect(cloudProviderConnectionMode()).toBe("checking")
  })

  test("keeps OAuth when the hosted provider is configured", () => {
    expect(cloudProviderConnectionMode(connection({ configured: true, manualTokenSupported: true }))).toBe("oauth")
  })

  test("offers a token when hosted OAuth is unavailable", () => {
    expect(cloudProviderConnectionMode(connection({ manualTokenSupported: true }))).toBe("token")
  })

  test("does not claim an older desktop can connect manually", () => {
    expect(cloudProviderConnectionMode(connection({}))).toBe("unavailable")
  })

  test("connected takes precedence without exposing the credential type", () => {
    expect(
      cloudProviderConnectionMode(connection({ connected: true, configured: false, manualTokenSupported: true })),
    ).toBe("connected")
  })
})

describe("cloudProviderTokenGuide", () => {
  test("points to the exact Vercel token settings", () => {
    expect(cloudProviderTokenGuide("vercel")).toEqual({
      url: "https://vercel.com/account/settings/tokens",
      location: "Vercel → Personal Account → Settings → Tokens",
      instruction: "Create a token that can access the team and projects you want Vector to manage.",
      placeholder: "Paste your Vercel access token",
    })
  })

  test("points to the exact Netlify token settings", () => {
    expect(cloudProviderTokenGuide("netlify")).toEqual({
      url: "https://app.netlify.com/user/applications#personal-access-tokens",
      location: "Netlify → User settings → Applications → Personal access tokens",
      instruction: "Create a personal access token for the account and sites you want Vector to manage.",
      placeholder: "Paste your Netlify personal access token",
    })
  })

  test("points to the exact Supabase token settings", () => {
    expect(cloudProviderTokenGuide("supabase")).toEqual({
      url: "https://supabase.com/dashboard/account/tokens",
      location: "Supabase → Account → Access Tokens",
      instruction: "Create a personal access token for the organizations and projects you want Vector to manage.",
      placeholder: "Paste your Supabase personal access token",
    })
  })
})
