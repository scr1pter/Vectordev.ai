export * as WebFetchRequest from "./webfetch-request"

import { Effect, Exit, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { InstallationVersion } from "../installation/version"

export const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Vector/${InstallationVersion}`

/** Retry only a declared challenge, once. Both attempts retain Vector's identity. */
export const execute = (http: HttpClient.HttpClient, request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const first = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(first, exit))
    const client = HttpClient.withScope(http)
    const response = yield* client
      .execute(HttpClientRequest.setHeader(request, "User-Agent", userAgent))
      .pipe(Effect.provideService(Scope.Scope, first))
    if (response.status !== 403 || response.headers["cf-mitigated"]?.toLowerCase() !== "challenge")
      return yield* HttpClientResponse.filterStatusOk(response)
    // Abort the challenge body before retrying, including bodies that never finish.
    yield* Scope.close(first, Exit.void)
    return yield* client
      .execute(HttpClientRequest.setHeader(request, "User-Agent", `Vector/${InstallationVersion}`))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
  })
