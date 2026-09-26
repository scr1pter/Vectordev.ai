import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { OauthCallbackPage } from "./page"
import { oauthToken, readOAuthJSON } from "./device"
import { digitalOceanOAuthConfiguration } from "../provider-policy"
import { InstallationVersion } from "../installation/version"

export function createDigitalOceanOAuth(dependencies?: {
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
}) {
  return {
    async authorize(registration: NonNullable<ReturnType<typeof digitalOceanOAuthConfiguration>>, signal: AbortSignal) {
      if (
        registration.origin !== "https://cloud.digitalocean.com" ||
        !/^[A-Za-z0-9._-]{8,256}$/.test(registration.clientId)
      )
        throw new Error("Configure Vector's DigitalOcean application before signing in.")
      const redirect = new URL(registration.redirectUri)
      if (
        redirect.protocol !== "http:" ||
        redirect.hostname !== "localhost" ||
        !redirect.port ||
        redirect.username ||
        redirect.password ||
        redirect.search ||
        redirect.hash
      )
        throw new Error("DigitalOcean requires Vector's registered localhost callback.")
      signal.throwIfAborted()
      const state = randomBytes(32).toString("base64url")
      const completion = Promise.withResolvers<ReturnType<typeof oauthToken>>()
      void completion.promise.catch(() => undefined)
      const tokenPath = "/auth/token"
      let claimed = false
      const server = createServer(async (request, response) => {
        response.setHeader("cache-control", "no-store")
        response.setHeader("referrer-policy", "no-referrer")
        response.setHeader("x-content-type-options", "nosniff")
        if (request.headers.host !== redirect.host || (request.url?.length ?? 0) > 8192)
          return response.writeHead(400).end("Invalid callback")
        const url = URL.parse(request.url ?? "/", redirect.origin)
        if (!url || url.origin !== redirect.origin) return response.writeHead(400).end("Invalid callback")
        if (request.method === "GET" && url.pathname === redirect.pathname)
          return response
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(OauthCallbackPage.bootstrap({ tokenPath, provider: "DigitalOcean" }))
        if (request.method !== "POST" || url.pathname !== tokenPath) return response.writeHead(404).end()
        if (
          request.headers.origin !== redirect.origin ||
          request.headers["content-type"]?.split(";")[0] !== "application/json"
        )
          return response.writeHead(403).end("Invalid callback origin")
        if (claimed) return response.writeHead(409).end("Authorization already received")
        const chunks: Buffer[] = []
        let size = 0
        try {
          for await (const chunk of request) {
            size += chunk.length
            if (size > 32_768) {
              response.writeHead(413).end("Callback too large")
              request.destroy()
              return
            }
            chunks.push(chunk)
          }
        } catch {
          return
        }
        const value: unknown = await new Response(Buffer.concat(chunks)).json().catch(() => undefined)
        if (!value || typeof value !== "object" || Array.isArray(value))
          return response.writeHead(400).end("Invalid callback")
        const body = value as Record<string, unknown>
        const received = Buffer.from(typeof body.state === "string" ? body.state : "")
        const expected = Buffer.from(state)
        if (received.length !== expected.length || !timingSafeEqual(received, expected))
          return response.writeHead(400).end("Invalid authorization state")
        if (body.error) {
          claimed = true
          response.writeHead(400).end("Authorization declined")
          completion.reject(new Error("DigitalOcean authorization was declined. Start sign-in again."))
          return
        }
        const seconds =
          typeof body.expires_in === "string" && /^\d+$/.test(body.expires_in)
            ? Number(body.expires_in)
            : body.expires_in
        const token = (() => {
          try {
            return oauthToken(registration, { ...body, expires_in: seconds }, dependencies?.now?.() ?? Date.now())
          } catch {
            return
          }
        })()
        if (!token) return response.writeHead(400).end("Invalid token or expiry")
        claimed = true
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}')
        completion.resolve(token)
      })
      await new Promise<void>((resolve, reject) => {
        server.once("error", () =>
          reject(new Error("Vector could not bind its DigitalOcean callback. Close other sign-in attempts and retry.")),
        )
        server.listen(Number(redirect.port), "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        throw new Error("Could not start callback")
      }
      redirect.port = String(address.port)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        server.closeAllConnections()
        server.close()
      }
      const abort = () => {
        completion.reject(new Error("DigitalOcean sign-in was cancelled."))
        close()
      }
      const timeout = setTimeout(
        () => {
          completion.reject(new Error("DigitalOcean sign-in timed out."))
          close()
        },
        dependencies?.timeoutMs ?? 10 * 60_000,
      )
      timeout.unref()
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      const completed = completion.promise.finally(close)
      void completed.catch(() => undefined)
      const url = new URL(`${registration.origin}/v1/oauth/authorize`)
      url.search = new URLSearchParams({
        response_type: "token",
        client_id: registration.clientId,
        redirect_uri: redirect.href,
        scope: registration.scope,
        state,
      }).toString()
      return {
        url: url.href,
        instructions:
          "Sign in to DigitalOcean in a browser on this computer. This authorizes inference and router discovery. Reconnect when the token expires.",
        complete: () => completed,
      }
    },
    async routers(access: string, signal: AbortSignal) {
      const response = await (dependencies?.fetch ?? fetch)("https://api.digitalocean.com/v2/gen-ai/models/routers", {
        headers: {
          authorization: `Bearer ${access}`,
          accept: "application/json",
          "user-agent": `vector/${InstallationVersion}`,
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }).catch(() => undefined)
      if (!response?.ok) return []
      const value = await readOAuthJSON(response).catch(() => undefined)
      if (!Array.isArray(value?.model_routers)) return []
      return value.model_routers.flatMap((router: unknown) =>
        typeof router === "object" &&
        router !== null &&
        "name" in router &&
        typeof router.name === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(router.name)
          ? [{ name: router.name }]
          : [],
      )
    },
  }
}
