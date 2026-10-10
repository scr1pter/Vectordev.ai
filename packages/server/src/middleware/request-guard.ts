import { Effect } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { isIP } from "node:net"
import { ServerAuth } from "../auth"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "../cors"

type Options = CorsOptions & { readonly guardedHostname?: string }

export const requestGuardLayer = (options?: Options) =>
  HttpRouter.middleware()(
    Effect.gen(function* () {
      const auth = yield* ServerAuth.Config
      const cors = yield* CorsConfig
      return requestGuard({ ...cors, ...options, cors: options?.cors ?? cors?.cors }, ServerAuth.required(auth))
    }),
    { global: true },
  )

export const requestGuard = (options?: Options, authenticationRequired = false) =>
  HttpMiddleware.make((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (new URL(request.url, "http://localhost").searchParams.has("auth_token"))
        return HttpServerResponse.empty({ status: 401 })
      if (
        !authenticationRequired &&
        options?.guardedHostname &&
        !allowedHost(request.headers.host, options.guardedHostname)
      )
        return HttpServerResponse.empty({ status: 403 })
      const websocket = request.headers.upgrade?.toLowerCase() === "websocket"
      if (
        (websocket || !authenticationRequired) &&
        !isAllowedRequestOrigin(
          request.headers.origin,
          request.headers.host,
          authenticationRequired ? options : { ...options, loopbackOrigins: options?.loopbackOrigins === true },
        )
      )
        return HttpServerResponse.empty({ status: 403 })
      return yield* effect
    }),
  )

function allowedHost(host: string | undefined, configured: string) {
  if (host === undefined) return true
  if (/[@/?#\\]/.test(host) || !URL.canParse(`http://${host}`)) return false
  const hostname = normalize(new URL(`http://${host}`).hostname)
  return hostname === normalize(configured) || isLoopback(hostname)
}

function normalize(hostname: string) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
}

function isLoopback(hostname: string) {
  const address = normalize(hostname)
  if (address === "localhost") return true
  if (isIP(address) === 4) return address.startsWith("127.")
  if (isIP(address) !== 6) return false
  const normalized = new URL(`http://[${address}]`).hostname
  return normalized === "[::1]" || /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(normalized)
}
