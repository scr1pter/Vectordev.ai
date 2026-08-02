import { Buffer } from "node:buffer"
import { createHmac, timingSafeEqual } from "node:crypto"

export type CloudOAuthProvider = "vercel" | "netlify" | "supabase"

export type CloudOAuthEnvironment = Record<string, string | undefined>

export type CloudOAuthProviderConfig = {
  provider: CloudOAuthProvider
  configured: boolean
  callbackUrl: string
  missing: string[]
}

type StartOAuthInput = {
  provider: CloudOAuthProvider
  state: string
  codeChallenge?: string
}

type ExchangeOAuthInput = {
  provider: Exclude<CloudOAuthProvider, "netlify">
  code: string
  state: string
  codeVerifier?: string
}

type OAuthTokenPayload = {
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresIn?: number
  teamId?: string
}

const PROVIDERS = new Set<CloudOAuthProvider>(["vercel", "netlify", "supabase"])

export function isCloudOAuthProvider(value: unknown): value is CloudOAuthProvider {
  return typeof value === "string" && PROVIDERS.has(value as CloudOAuthProvider)
}

function envValue(env: CloudOAuthEnvironment, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return ""
}

export function publicOAuthOrigin(requestUrl: string, env: CloudOAuthEnvironment): string {
  const configured = envValue(env, "VECTOR_OAUTH_PUBLIC_URL")
  if (configured) {
    const parsed = new URL(configured)
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("VECTOR_OAUTH_PUBLIC_URL must use HTTPS.")
    }
    return parsed.origin
  }
  return new URL(requestUrl).origin
}

export function oauthCallbackUrl(
  provider: CloudOAuthProvider,
  requestUrl: string,
  env: CloudOAuthEnvironment,
): string {
  return `${publicOAuthOrigin(requestUrl, env)}/api/cloud/oauth/callback-${provider}`
}

export function oauthProviderConfig(
  provider: CloudOAuthProvider,
  requestUrl: string,
  env: CloudOAuthEnvironment,
): CloudOAuthProviderConfig {
  const callbackUrl = oauthCallbackUrl(provider, requestUrl, env)
  const missing: string[] = []
  if (!envValue(env, "VECTOR_OAUTH_STATE_SECRET")) {
    missing.push("VECTOR_OAUTH_STATE_SECRET")
  }
  if (provider === "vercel") {
    if (!envValue(env, "VECTOR_VERCEL_INTEGRATION_SLUG", "VERCEL_INTEGRATION_SLUG")) {
      missing.push("VECTOR_VERCEL_INTEGRATION_SLUG")
    }
    if (!envValue(env, "VECTOR_VERCEL_CLIENT_ID", "VERCEL_INTEGRATION_CLIENT_ID")) {
      missing.push("VECTOR_VERCEL_CLIENT_ID")
    }
    if (!envValue(env, "VECTOR_VERCEL_CLIENT_SECRET", "VERCEL_INTEGRATION_CLIENT_SECRET")) {
      missing.push("VECTOR_VERCEL_CLIENT_SECRET")
    }
  }
  if (provider === "supabase") {
    if (!envValue(env, "VECTOR_SUPABASE_CLIENT_ID", "SUPABASE_OAUTH_CLIENT_ID")) {
      missing.push("VECTOR_SUPABASE_CLIENT_ID")
    }
    if (!envValue(env, "VECTOR_SUPABASE_CLIENT_SECRET", "SUPABASE_OAUTH_CLIENT_SECRET")) {
      missing.push("VECTOR_SUPABASE_CLIENT_SECRET")
    }
  }
  if (provider === "netlify") {
    if (!envValue(env, "VECTOR_NETLIFY_CLIENT_ID", "NETLIFY_OAUTH_CLIENT_ID")) {
      missing.push("VECTOR_NETLIFY_CLIENT_ID")
    }
  }
  return { provider, configured: missing.length === 0, callbackUrl, missing }
}

function oauthStateSecret(env: CloudOAuthEnvironment): string {
  const secret = envValue(env, "VECTOR_OAUTH_STATE_SECRET")
  if (secret.length < 32) {
    throw new Error("VECTOR_OAUTH_STATE_SECRET must contain at least 32 characters.")
  }
  return secret
}

export function signOAuthState(
  provider: CloudOAuthProvider,
  clientState: string,
  env: CloudOAuthEnvironment,
): string {
  const state = clientState.trim()
  if (!state || state.length > 3200) throw new Error("A valid OAuth state value is required.")
  const expiresAt = Date.now() + 10 * 60_000
  const signature = createHmac("sha256", oauthStateSecret(env))
    .update(`${provider}\n${state}\n${expiresAt}`)
    .digest("base64url")
  return `${state}~${expiresAt}~${signature}`
}

export function verifyOAuthState(
  provider: CloudOAuthProvider,
  signedState: string,
  env: CloudOAuthEnvironment,
): boolean {
  const signatureSplit = signedState.lastIndexOf("~")
  const expirySplit = signedState.lastIndexOf("~", signatureSplit - 1)
  if (expirySplit < 1 || signatureSplit <= expirySplit) return false
  const clientState = signedState.slice(0, expirySplit)
  const expiresAt = Number(signedState.slice(expirySplit + 1, signatureSplit))
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || expiresAt > Date.now() + 11 * 60_000) {
    return false
  }
  const supplied = Buffer.from(signedState.slice(signatureSplit + 1), "base64url")
  const expected = Buffer.from(
    createHmac("sha256", oauthStateSecret(env))
      .update(`${provider}\n${clientState}\n${expiresAt}`)
      .digest("base64url"),
    "base64url",
  )
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function createOAuthAuthorizeUrl(
  input: StartOAuthInput,
  requestUrl: string,
  env: CloudOAuthEnvironment,
): { authorizeUrl: string; callbackUrl: string; state: string } {
  const config = oauthProviderConfig(input.provider, requestUrl, env)
  if (!config.configured) {
    throw new Error(`${input.provider} OAuth is not configured. Missing ${config.missing.join(", ")}.`)
  }
  const state = signOAuthState(input.provider, input.state, env)

  if (input.provider === "vercel") {
    const slug = envValue(env, "VECTOR_VERCEL_INTEGRATION_SLUG", "VERCEL_INTEGRATION_SLUG")
    const authorizeUrl = new URL(`https://vercel.com/integrations/${encodeURIComponent(slug)}/new`)
    authorizeUrl.searchParams.set("state", state)
    return { authorizeUrl: authorizeUrl.toString(), callbackUrl: config.callbackUrl, state }
  }

  if (input.provider === "supabase") {
    const challenge = input.codeChallenge?.trim()
    if (!challenge) throw new Error("Supabase OAuth requires a PKCE code challenge.")
    const authorizeUrl = new URL("https://api.supabase.com/v1/oauth/authorize")
    authorizeUrl.searchParams.set(
      "client_id",
      envValue(env, "VECTOR_SUPABASE_CLIENT_ID", "SUPABASE_OAUTH_CLIENT_ID"),
    )
    authorizeUrl.searchParams.set("redirect_uri", config.callbackUrl)
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("state", state)
    authorizeUrl.searchParams.set("code_challenge", challenge)
    authorizeUrl.searchParams.set("code_challenge_method", "S256")
    return { authorizeUrl: authorizeUrl.toString(), callbackUrl: config.callbackUrl, state }
  }

  const authorizeUrl = new URL("https://app.netlify.com/authorize")
  authorizeUrl.searchParams.set(
    "client_id",
    envValue(env, "VECTOR_NETLIFY_CLIENT_ID", "NETLIFY_OAUTH_CLIENT_ID"),
  )
  authorizeUrl.searchParams.set("response_type", "token")
  authorizeUrl.searchParams.set("redirect_uri", config.callbackUrl)
  authorizeUrl.searchParams.set("state", state)
  return { authorizeUrl: authorizeUrl.toString(), callbackUrl: config.callbackUrl, state }
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return
  const field = Reflect.get(value, key)
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

async function providerError(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined)
  return (
    stringField(body, "error_description") ??
    stringField(body, "message") ??
    stringField(body, "error") ??
    `Provider returned HTTP ${response.status}.`
  )
}

export async function exchangeOAuthCode(
  input: ExchangeOAuthInput,
  requestUrl: string,
  env: CloudOAuthEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<OAuthTokenPayload> {
  const code = input.code.trim()
  if (!code) throw new Error("The provider did not return an authorization code.")
  if (!verifyOAuthState(input.provider, input.state, env)) {
    throw new Error("The OAuth transaction is invalid or expired. Start the connection again.")
  }
  const config = oauthProviderConfig(input.provider, requestUrl, env)
  if (!config.configured) {
    throw new Error(`${input.provider} OAuth is not configured. Missing ${config.missing.join(", ")}.`)
  }

  if (input.provider === "vercel") {
    const body = new URLSearchParams({
      client_id: envValue(env, "VECTOR_VERCEL_CLIENT_ID", "VERCEL_INTEGRATION_CLIENT_ID"),
      client_secret: envValue(env, "VECTOR_VERCEL_CLIENT_SECRET", "VERCEL_INTEGRATION_CLIENT_SECRET"),
      code,
      redirect_uri: config.callbackUrl,
    })
    const response = await fetcher("https://api.vercel.com/v2/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(await providerError(response))
    const payload: unknown = await response.json()
    const accessToken = stringField(payload, "access_token")
    if (!accessToken) throw new Error("Vercel did not return an access token.")
    return {
      accessToken,
      tokenType: stringField(payload, "token_type"),
      teamId: stringField(payload, "team_id"),
    }
  }

  const verifier = input.codeVerifier?.trim()
  if (!verifier) throw new Error("The Supabase PKCE verifier is missing. Start the connection again.")
  const clientId = envValue(env, "VECTOR_SUPABASE_CLIENT_ID", "SUPABASE_OAUTH_CLIENT_ID")
  const clientSecret = envValue(env, "VECTOR_SUPABASE_CLIENT_SECRET", "SUPABASE_OAUTH_CLIENT_SECRET")
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    code_verifier: verifier,
  })
  const response = await fetcher("https://api.supabase.com/v1/oauth/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(await providerError(response))
  const payload: unknown = await response.json()
  const accessToken = stringField(payload, "access_token")
  if (!accessToken) throw new Error("Supabase did not return an access token.")
  return {
    accessToken,
    refreshToken: stringField(payload, "refresh_token"),
    tokenType: stringField(payload, "token_type"),
    expiresIn: numberField(payload, "expires_in"),
  }
}

export async function refreshSupabaseOAuthToken(
  refreshToken: string,
  requestUrl: string,
  env: CloudOAuthEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<OAuthTokenPayload> {
  const config = oauthProviderConfig("supabase", requestUrl, env)
  if (!config.configured) {
    throw new Error(`Supabase OAuth is not configured. Missing ${config.missing.join(", ")}.`)
  }
  const clientId = envValue(env, "VECTOR_SUPABASE_CLIENT_ID", "SUPABASE_OAUTH_CLIENT_ID")
  const clientSecret = envValue(env, "VECTOR_SUPABASE_CLIENT_SECRET", "SUPABASE_OAUTH_CLIENT_SECRET")
  const response = await fetcher("https://api.supabase.com/v1/oauth/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(await providerError(response))
  const payload: unknown = await response.json()
  const accessToken = stringField(payload, "access_token")
  if (!accessToken) throw new Error("Supabase did not return a refreshed access token.")
  return {
    accessToken,
    refreshToken: stringField(payload, "refresh_token") ?? refreshToken,
    tokenType: stringField(payload, "token_type"),
    expiresIn: numberField(payload, "expires_in"),
  }
}

export async function revokeSupabaseOAuthToken(
  refreshToken: string,
  requestUrl: string,
  env: CloudOAuthEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const token = refreshToken.trim()
  if (!token) return
  const config = oauthProviderConfig("supabase", requestUrl, env)
  if (!config.configured) {
    throw new Error(`Supabase OAuth is not configured. Missing ${config.missing.join(", ")}.`)
  }
  const response = await fetcher("https://api.supabase.com/v1/oauth/revoke", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: envValue(env, "VECTOR_SUPABASE_CLIENT_ID", "SUPABASE_OAUTH_CLIENT_ID"),
      client_secret: envValue(env, "VECTOR_SUPABASE_CLIENT_SECRET", "SUPABASE_OAUTH_CLIENT_SECRET"),
      refresh_token: token,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(await providerError(response))
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;"
    if (character === "<") return "&lt;"
    if (character === ">") return "&gt;"
    if (character === '"') return "&quot;"
    return "&#39;"
  })
}

function callbackPage(body: string, script: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Return to Vector</title>
    <style>
      :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121116;color:#f5f2ff;font:15px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}.card{width:min(440px,calc(100vw - 32px));padding:28px;border:1px solid #34303f;border-radius:16px;background:#1b1921;box-shadow:0 20px 70px #0008}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#aaa4b7}.mark{width:38px;height:38px;display:grid;place-items:center;margin-bottom:18px;border-radius:10px;background:#8f70ec;color:white;font-weight:800}a{display:inline-flex;margin-top:18px;padding:9px 13px;border-radius:8px;background:#8f70ec;color:white;text-decoration:none;font-weight:650}
    </style>
  </head>
  <body>
    <main class="card"><div class="mark">V</div>${body}</main>
    <script>${script}</script>
  </body>
</html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; navigate-to vector:; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  )
}

function deepLinkPage(deepLink: string, provider: string, failed?: string): Response {
  const safeLink = JSON.stringify(deepLink)
  const title = failed ? "Connection was not completed" : `${provider} is connected`
  const copy = failed
    ? htmlEscape(failed)
    : "Vector is finishing the secure connection. You can close this tab after the desktop app opens."
  return callbackPage(
    `<h1>${htmlEscape(title)}</h1><p>${copy}</p><a id="return" href="${htmlEscape(deepLink)}">Return to Vector</a>`,
    `const link=${safeLink};setTimeout(()=>{window.location.href=link},80);`,
  )
}

export function createOAuthCallbackResponse(provider: CloudOAuthProvider, requestUrl: string): Response {
  const url = new URL(requestUrl)
  if (provider === "netlify") {
    return callbackPage(
      '<h1>Finishing Netlify connection</h1><p>Vector is securely transferring authorization back to the desktop app.</p><a id="return" href="#">Return to Vector</a>',
      `(async()=>{const out=new URL("vector://cloud/oauth");out.searchParams.set("provider","netlify");try{const values=new URLSearchParams(location.hash.replace(/^#/,""));const token=values.get("access_token");const state=values.get("state")||"";const error=values.get("error_description")||values.get("error");if(error)throw new Error(error);if(!token||!state)throw new Error("Netlify did not return authorization.");const signedAt=state.indexOf("~");const clientState=signedAt<0?state:state.slice(0,signedAt);const split=clientState.indexOf(".");if(split<1)throw new Error("The secure return state is invalid.");const encoded=clientState.slice(split+1).replace(/-/g,"+").replace(/_/g,"/");const padded=encoded+"=".repeat((4-encoded.length%4)%4);const jwk=JSON.parse(atob(padded));const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);const encrypted=await crypto.subtle.encrypt({name:"RSA-OAEP"},key,new TextEncoder().encode(token));const bytes=new Uint8Array(encrypted);let raw="";for(const byte of bytes)raw+=String.fromCharCode(byte);out.searchParams.set("state",state);out.searchParams.set("encrypted",btoa(raw).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""));location.hash="";}catch(error){out.searchParams.set("error",error instanceof Error?error.message:String(error));}const link=out.toString();document.getElementById("return").setAttribute("href",link);setTimeout(()=>{location.href=link},80)})()`,
    )
  }

  const state = url.searchParams.get("state") ?? ""
  const code = url.searchParams.get("code") ?? ""
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? ""
  const deepLink = new URL("vector://cloud/oauth")
  deepLink.searchParams.set("provider", provider)
  if (state) deepLink.searchParams.set("state", state)
  if (code) deepLink.searchParams.set("code", code)
  for (const key of ["teamId", "configurationId"]) {
    const value = url.searchParams.get(key)
    if (value) deepLink.searchParams.set(key, value)
  }
  if (error) deepLink.searchParams.set("error", error)
  if (!error && (!state || !code)) {
    deepLink.searchParams.set("error", `${provider} did not return a complete authorization response.`)
  }
  return deepLinkPage(deepLink.toString(), provider === "vercel" ? "Vercel" : "Supabase", error || undefined)
}

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  })
}
