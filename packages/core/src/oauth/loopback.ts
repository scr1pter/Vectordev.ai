import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { oauthJSON } from "./device"
import { OauthCallbackPage } from "./page"

export type LoopbackRegistration = {
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  redirectUri: string
  scope: string
  authorization?: Readonly<Record<string, string>>
}

/** An isolated listener/verifier per sign-in. All callback secrets remain in memory. */
export async function authorizeLoopback(
  registration: LoopbackRegistration,
  signal: AbortSignal,
  dependencies?: { fetch?: typeof fetch; timeoutMs?: number },
) {
  const redirect = new URL(registration.redirectUri)
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(redirect.hostname) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    !redirect.port
  )
    throw new Error("Register a loopback callback URI for Vector before signing in.")
  for (const value of [registration.authorizeUrl, registration.tokenUrl]) {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("OAuth requires a secure provider endpoint.")
  }
  if (!/^[A-Za-z0-9._-]{8,256}$/.test(registration.clientId))
    throw new Error("Configure Vector's owned client registration before signing in.")
  signal.throwIfAborted()
  const verifier = randomBytes(32).toString("base64url")
  const state = randomBytes(32).toString("base64url")
  const code = Promise.withResolvers<string>()
  let claimed = false
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store")
    response.setHeader("referrer-policy", "no-referrer")
    response.setHeader("x-content-type-options", "nosniff")
    if (request.method !== "GET" || request.headers.host !== redirect.host || (request.url?.length ?? 0) > 8192)
      return response.writeHead(400).end("Invalid callback")
    const url = URL.parse(request.url ?? "/", redirect.origin)
    if (!url || url.origin !== redirect.origin || url.pathname !== redirect.pathname)
      return response.writeHead(404).end()
    if (claimed) return response.writeHead(409).end("Authorization already received")
    const received = Buffer.from(url.searchParams.get("state") ?? "")
    const expected = Buffer.from(state)
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return response.writeHead(400).end("Invalid authorization state")
    if (url.searchParams.has("error")) {
      claimed = true
      code.reject(new Error("Provider sign-in was declined. Start sign-in again."))
      return response
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(OauthCallbackPage.error("The account was not connected."))
    }
    const value = url.searchParams.get("code")
    if (
      !value ||
      value.length > 4096 ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.getAll("state").length !== 1
    )
      return response.writeHead(400).end("Invalid authorization code")
    claimed = true
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(OauthCallbackPage.received())
    code.resolve(value)
  })
  // Attach rejection handling before a callback/abort can arrive.
  void code.promise.catch(() => undefined)
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error("Vector could not bind its registered loopback callback. Close other sign-in attempts and retry."),
      ),
    )
    server.listen(Number(redirect.port), "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Vector could not start its loopback callback.")
  }
  redirect.port = String(address.port)
  const controller = new AbortController()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    controller.abort()
    clearTimeout(timeout)
    signal.removeEventListener("abort", abort)
    server.closeAllConnections()
    server.close()
  }
  const abort = () => {
    code.reject(new Error("Provider sign-in was cancelled."))
    close()
  }
  const timeout = setTimeout(
    () => {
      code.reject(new Error("Provider sign-in timed out. Start sign-in again."))
      close()
    },
    dependencies?.timeoutMs ?? 10 * 60_000,
  )
  timeout.unref()
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const completion = code.promise
    .then(async (value) => {
      controller.signal.throwIfAborted()
      const result = await oauthJSON(
        registration.tokenUrl,
        {
          grant_type: "authorization_code",
          client_id: registration.clientId,
          code: value,
          redirect_uri: redirect.href,
          code_verifier: verifier,
        },
        controller.signal,
        dependencies?.fetch,
      )
      if (!result.ok || result.value.error) throw new Error("Provider sign-in could not complete. Start sign-in again.")
      controller.signal.throwIfAborted()
      return result.value
    })
    .finally(close)
  void completion.catch(() => undefined)
  const url = new URL(registration.authorizeUrl)
  url.search = new URLSearchParams({
    ...registration.authorization,
    client_id: registration.clientId,
    response_type: "code",
    redirect_uri: redirect.href,
    scope: registration.scope,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  }).toString()
  return {
    url: url.href,
    instructions:
      "Complete authorization in a browser on this computer, then return to Vector. For a remote engine, use device sign-in or forward the callback port.",
    complete: () => completion,
    close: abort,
  }
}
