import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { allowedHost } from "@/server/listen-policy"

// See guardedHostname in listen-policy.ts: a passwordless loopback listener
// refuses requests addressed to any other name, which stops DNS rebinding.
export const hostGuardLayer = (hostname: string) =>
  HttpRouter.middleware(
    (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (allowedHost(request.headers.host, hostname)) return yield* effect
        return HttpServerResponse.text(
          "This Vector server only answers requests addressed to localhost. Set VECTOR_SERVER_PASSWORD to reach it under another name.",
          { status: 403 },
        )
      }),
    { global: true },
  )
