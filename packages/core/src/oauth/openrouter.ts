export * as OpenRouterOAuth from "./openrouter"

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { Option, Schema } from "effect"
import { OauthCallbackPage } from "./page"

export const AUTHORIZE_URL = "https://openrouter.ai/auth"
export const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys"

export function createPKCE() {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

export async function exchange(
  code: string,
  verifier: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  signal?: AbortSignal,
) {
  const response = await request(EXCHANGE_URL, {
    method: "POST",
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      "HTTP-Referer": "https://vectordev.ai/",
      "X-OpenRouter-Title": "Vector",
    },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  })
  if (!response.ok)
    throw new Error(
      `OpenRouter authorization could not complete (HTTP ${response.status}). Start Connect OpenRouter again.`,
    )
  const parsed = Schema.decodeUnknownOption(
    Schema.Struct({ key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)) }),
  )(await response.json().catch(() => undefined))
  if (Option.isNone(parsed))
    throw new Error("OpenRouter returned an invalid API key response. Start Connect OpenRouter again.")
  return parsed.value.key
}

/** One loopback listener and verifier per attempt; no account token or resulting API key enters a URL. */
export async function authorize(
  input: {
    request?: (url: string, init: RequestInit) => Promise<Response>
    timeoutMs?: number
  } = {},
) {
  const pkce = createPKCE()
  const nonce = randomBytes(32).toString("base64url")
  const code = Promise.withResolvers<string>()
  const state = { claimed: false, closed: false, cancelled: false }
  const controller = new AbortController()
  const server = createServer((request, response) => {
    const address = server.address()
    if (!address || typeof address === "string") return response.writeHead(503).end()
    const host = `127.0.0.1:${address.port}`
    if (request.method !== "GET" || request.headers.host !== host || (request.url?.length ?? 0) > 8192)
      return response.writeHead(400).end("Invalid authorization callback")
    if (!URL.canParse(request.url ?? "/", `http://${host}`)) return response.writeHead(400).end("Invalid callback URL")
    const url = new URL(request.url ?? "/", `http://${host}`)
    if (url.origin !== `http://${host}` || url.pathname !== "/callback") return response.writeHead(404).end()
    if (state.claimed) return response.writeHead(409).end("Authorization already received")
    const received = Buffer.from(url.searchParams.get("state") ?? "")
    const expected = Buffer.from(nonce)
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return response.writeHead(400).end("Invalid authorization state")
    if (url.searchParams.has("error")) {
      state.claimed = true
      code.reject(new Error("OpenRouter authorization was declined. Start Connect OpenRouter again."))
      return response
        .writeHead(400, { "Content-Type": "text/html", "Cache-Control": "no-store" })
        .end(OauthCallbackPage.error("The account was not connected.", { provider: "OpenRouter" }))
    }
    const value = url.searchParams.get("code")
    if (!value || value.length > 4096) return response.writeHead(400).end("Missing authorization code")
    state.claimed = true
    response
      .writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      })
      .end(OauthCallbackPage.received({ provider: "OpenRouter" }))
    code.resolve(value)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not start the OpenRouter loopback callback")
  const stop = (force = false) => {
    if (state.closed) return
    state.closed = true
    clearTimeout(timeout)
    if (force) server.closeAllConnections()
    server.close()
  }
  const timeout = setTimeout(
    () => {
      state.cancelled = true
      controller.abort()
      code.reject(new Error("OpenRouter authorization timed out. Start Connect OpenRouter again."))
      stop(true)
    },
    input.timeoutMs ?? 10 * 60_000,
  )
  timeout.unref()
  const key = code.promise
    .then((value) => exchange(value, pkce.verifier, input.request, controller.signal))
    .then((key) => {
      if (state.cancelled) throw new Error("OpenRouter authorization was cancelled.")
      return key
    })
    .finally(() => stop())
  // A desktop client may abandon its attempt before polling the result.
  void key.catch(() => undefined)
  const callback = new URL(`http://127.0.0.1:${address.port}/callback`)
  callback.searchParams.set("state", nonce)
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    callback_url: callback.href,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    key_label: "Vector",
  }).toString()
  return {
    url: url.href,
    key,
    close() {
      state.cancelled = true
      controller.abort()
      code.reject(new Error("OpenRouter authorization was cancelled."))
      stop(true)
    },
  }
}
