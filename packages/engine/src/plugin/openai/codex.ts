import { CHATGPT_SIGN_IN } from "@vectordevai/core/provider-policy"
import type { Hooks, PluginInput } from "@vectordevai/plugin"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { OAUTH_DUMMY_KEY } from "../../auth"
import os from "os"
import { setTimeout as sleep } from "node:timers/promises"
import { createServer } from "http"
import { OpenAIWebSocketPool } from "./ws-pool"
import { OauthCallbackPage } from "@vectordevai/core/oauth/page"

// The Codex CLI client, as Vector used it for ChatGPT sign-in up to 1.99.10.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "vector",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface CodexAuthPluginOptions {
  issuer?: string
  codexApiEndpoint?: string
  experimentalWebSockets?: boolean
  /** How long a browser sign-in waits for its callback before failing and closing the server. */
  callbackTimeout?: number
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

async function refreshAccessToken(refreshToken: string, issuer = ISSUER): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

// Kept as a named export for plugin.codex tests; delegates to the shared branded page.
export const renderOAuthError = (error: string) => OauthCallbackPage.error(error, { provider: "ChatGPT" })

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)
    const current = pendingOAuth

    if (url.pathname !== "/auth/callback" && url.pathname !== "/cancel") {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    // Only the browser that started this sign-in knows its state, so a request from another
    // page or process cannot cancel or fail the sign-in in progress.
    if (!current || url.searchParams.get("state") !== current.state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderOAuthError("Invalid state - potential CSRF attack"))
      return
    }

    // Each branch answers before settling the sign-in, since settling closes the server and its connections.
    if (url.pathname === "/cancel") {
      res.writeHead(200)
      res.end("Login cancelled")
      current.reject(new Error("Login cancelled"))
      return
    }

    const error = url.searchParams.get("error_description") || url.searchParams.get("error")
    if (error) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderOAuthError(error))
      current.reject(new Error(error))
      return
    }

    const code = url.searchParams.get("code")
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderOAuthError("Missing authorization code"))
      current.reject(new Error("Missing authorization code"))
      return
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.success({ provider: "ChatGPT" }))
    releaseOAuth(current)
    exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
      .then((tokens) => current.resolve(tokens))
      .catch((err) => current.reject(err))
  })
  oauthServer = server

  // Loopback only: the callback carries an authorization code and must not be reachable from the network.
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      if (oauthServer === server) oauthServer = undefined
      reject(error)
    })
    server.listen(OAUTH_PORT, "127.0.0.1", () => resolve())
  })

  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close(() => {})
    // A browser keep-alive connection would otherwise keep reaching the handler after close.
    oauthServer.closeAllConnections()
    oauthServer = undefined
  }
}

// Every sign-in ends here, whether it succeeds, fails, is cancelled or times out, so the
// callback server closes as soon as no sign-in is waiting on it.
function releaseOAuth(entry: PendingOAuth) {
  if (pendingOAuth === entry) pendingOAuth = undefined
  if (!pendingOAuth) stopOAuthServer()
}

function waitForOAuthCallback(pkce: PkceCodes, state: string, wait: number): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const entry: PendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        releaseOAuth(entry)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        releaseOAuth(entry)
        reject(error)
      },
    }
    const timeout = setTimeout(
      () => entry.reject(new Error("OAuth callback timeout - authorization took too long")),
      wait,
    )
    // A newer sign-in replaces an unfinished one; the server stays up for the newer one.
    const previous = pendingOAuth
    pendingOAuth = entry
    previous?.reject(new Error("Login cancelled"))
  })
}

export async function CodexAuthPlugin(input: PluginInput, options: CodexAuthPluginOptions = {}): Promise<Hooks> {
  const issuer = options.issuer ?? ISSUER
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT
  let websocketFetchInstalled = false
  const websocketFetches: Array<ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>> = []

  return {
    async dispose() {
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
    },
    async event(input) {
      if (input.event.type !== "session.deleted") return
      for (const websocketFetch of websocketFetches) websocketFetch.remove(input.event.properties.info.id)
    },
    provider: {
      id: "openai",
      async models(provider, ctx) {
        if (!CHATGPT_SIGN_IN || ctx.auth?.type !== "oauth") return provider.models

        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              // A ChatGPT sign-in reaches OpenAI through the Codex backend, which serves the
              // GPT-5 generation onward: every point release and every tier (mini, fast, pro).
              // "gpt-6-astra" has no minor number, so only the major version is read.
              // Older models (gpt-4o, o3) are not served there.
              if (model.api.id.startsWith("codex-")) return true
              const match = model.api.id.match(/^gpt-(\d+)/)
              return match !== null && Number(match[1]) >= 5
            })
            .map(([modelID, model]) => [
              modelID,
              {
                ...model,
                cost: {
                  input: 0,
                  output: 0,
                  cache: { read: 0, write: 0 },
                },
                limit:
                  model.id.includes("gpt-5.5") || model.id.includes("gpt-5.6")
                    ? {
                        context: 400_000,
                        input: 272_000,
                        output: 128_000,
                      }
                    : model.limit,
              },
            ]),
        )
      },
    },
    auth: {
      provider: "openai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type === "oauth" && !CHATGPT_SIGN_IN) return {}
        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({ httpFetch: fetch })
          : undefined
        if (websocketFetch) {
          websocketFetches.push(websocketFetch)
          websocketFetchInstalled = true
        }
        if (auth.type !== "oauth") return websocketFetch ? { fetch: websocketFetch } : {}

        let refreshPromise:
          | Promise<{
              access: string
              accountId: string | undefined
            }>
          | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth")
              return websocketFetch ? websocketFetch(requestInput, init) : fetch(requestInput, init)

            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }

            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshAccessToken(currentAuth.refresh, issuer)
                  .then(async (tokens) => {
                    const accountId = extractAccountId(tokens) || authWithAccount.accountId
                    await input.client.auth.set({
                      path: { id: "openai" },
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                        ...(accountId && { accountId }),
                      },
                    })
                    return {
                      access: tokens.access_token,
                      accountId,
                    }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }

              const refreshed = await refreshPromise
              currentAuth.access = refreshed.access
              authWithAccount.accountId = refreshed.accountId
            }

            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }

            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const url =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
                ? new URL(codexApiEndpoint)
                : parsed

            const requestInit = {
              ...init,
              headers,
            }
            if (websocketFetch && parsed.pathname.endsWith("/responses")) return websocketFetch(url, requestInit)
            return fetch(url, OpenAIWebSocketPool.withoutInternalHeaders(requestInit))
          },
        }
      },
      methods: (
        [
          {
            label: "ChatGPT Pro/Plus (browser)",
            type: "oauth",
            authorize: async () => {
              const { redirectUri } = await startOAuthServer()
              const pkce = await generatePKCE()
              const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
              const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

              const callbackPromise = waitForOAuthCallback(pkce, state, options.callbackTimeout ?? 5 * 60 * 1000)
              // The client may never ask for the result (it closed the dialog), so a timeout or a
              // newer sign-in rejecting this one must not surface as an unhandled rejection.
              callbackPromise.catch(() => undefined)

              return {
                url: authUrl,
                instructions: "Complete authorization in your browser. This window will close automatically.",
                method: "auto" as const,
                callback: async () => {
                  const tokens = await callbackPromise
                  const accountId = extractAccountId(tokens)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    accountId,
                  }
                },
              }
            },
          },
          {
            label: "ChatGPT Pro/Plus (headless)",
            type: "oauth",
            authorize: async () => {
              const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "User-Agent": `vector/${InstallationVersion}`,
                },
                body: JSON.stringify({ client_id: CLIENT_ID }),
              })

              if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

              const deviceData = (await deviceResponse.json()) as {
                device_auth_id: string
                user_code: string
                interval: string
              }
              const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

              return {
                url: `${ISSUER}/codex/device`,
                instructions: `Enter code: ${deviceData.user_code}`,
                method: "auto" as const,
                async callback() {
                  while (true) {
                    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "User-Agent": `vector/${InstallationVersion}`,
                      },
                      body: JSON.stringify({
                        device_auth_id: deviceData.device_auth_id,
                        user_code: deviceData.user_code,
                      }),
                    })

                    if (response.ok) {
                      const data = (await response.json()) as {
                        authorization_code: string
                        code_verifier: string
                      }

                      const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                        method: "POST",
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                        body: new URLSearchParams({
                          grant_type: "authorization_code",
                          code: data.authorization_code,
                          redirect_uri: `${ISSUER}/deviceauth/callback`,
                          client_id: CLIENT_ID,
                          code_verifier: data.code_verifier,
                        }).toString(),
                      })

                      if (!tokenResponse.ok) {
                        throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                      }

                      const tokens: TokenResponse = await tokenResponse.json()

                      return {
                        type: "success" as const,
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                        accountId: extractAccountId(tokens),
                      }
                    }

                    if (response.status !== 403 && response.status !== 404) {
                      return { type: "failed" as const }
                    }

                    await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                  }
                },
              }
            },
          },
          {
            label: "Manually enter API Key",
            type: "api",
          },
        ] satisfies NonNullable<Hooks["auth"]>["methods"]
      ).filter((method) => CHATGPT_SIGN_IN || method.type !== "oauth"),
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "vector"
      output.headers["User-Agent"] = `vector/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers["session-id"] = input.sessionID
      // Temporary fetch-layer hack: title generation currently shares the conversation
      // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
      // context can be passed directly instead of smuggled through headers.
      if (websocketFetchInstalled && input.agent === "title") output.headers[OpenAIWebSocketPool.TITLE_HEADER] = "true"
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}
