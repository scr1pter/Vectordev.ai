import { expect, test } from "bun:test"
import { cloudOAuthAuthorizeUrl } from "./cloud-oauth-relay"

test.each([
  ["vercel", "https://vercel.com/integrations/vector/new?state=fixture"],
  ["netlify", "https://app.netlify.com/authorize?state=fixture"],
  ["supabase", "https://api.supabase.com/v1/oauth/authorize?state=fixture"],
] as const)("allows the expected HTTPS authorization origin for %s", (provider, url) => {
  expect(cloudOAuthAuthorizeUrl(provider, url)).toBe(url)
})

test.each([
  "http://vercel.com/integrations/vector/new",
  "https://vercel.com.attacker.invalid/integrations/vector/new",
  "https://vercel.com@attacker.invalid/integrations/vector/new",
  "https://attacker@vercel.com/integrations/vector/new",
  "https://app.netlify.com/authorize",
  "https://vercel.com:8443/integrations/vector/new",
  "javascript:alert(1)",
  "file:///tmp/authorization.html",
  "vector://cloud/oauth",
  "invalid-url",
])("rejects unexpected authorization URL %s before opening it", (url) => {
  expect(() => cloudOAuthAuthorizeUrl("vercel", url)).toThrow()
})
