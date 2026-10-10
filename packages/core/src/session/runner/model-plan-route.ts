import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  AuthenticationReason,
  HttpOptions,
  InvalidRequestReason,
  LLMError,
  LLMRequest,
  QuotaExceededReason,
} from "@vectordevai/llm"
import { OpenAICompatibleChat } from "@vectordevai/llm/protocols/openai-compatible-chat"
import { Auth } from "@vectordevai/llm/route"
import { FreeModels } from "../../free-models"
import { ModelPlans } from "../../model-plans"
import { ModelV2 } from "../../model"

export function modelPlanRoute(
  model: ModelV2.Info,
  client: ModelPlans.Service["Service"],
  credentials: FreeModels.CredentialsService["Service"],
) {
  const transport = OpenAICompatibleChat.route.transport
  return OpenAICompatibleChat.route
    .with({
      provider: ModelPlans.PROVIDER_ID,
      endpoint: { baseURL: ModelPlans.CHAT_URL, path: "" },
      limits: { context: model.limit.context, output: model.limit.output },
      transport: {
        ...transport,
        prepare: (input) =>
          Effect.gen(function* () {
            const route = yield* Effect.tryPromise({
              try: () =>
                ModelPlans.resolveRoute({
                  modelID: model.id,
                  credential: () => Effect.runPromise(credentials.get("vector")),
                  catalog: (token) => Effect.runPromise(client.catalog(token)),
                }),
              catch: (cause) => invalidRequest(cause),
            })
            const body = yield* Effect.try({
              try: () => ModelPlans.serializeRequest(input.body, route.model),
              catch: (cause) => invalidRequest(cause),
            })
            // Endpoint, headers, auth, query and body are fixed at the final transport boundary.
            return yield* transport.prepare({
              ...input,
              request: LLMRequest.update(input.request, { http: new HttpOptions({}) }),
              endpoint: { ...input.endpoint, baseURL: ModelPlans.CHAT_URL, path: "" },
              auth: Auth.bearer(Auth.value(route.token)),
              headers: () => ({}),
              encodeBody: () => body,
            })
          }),
        frames: (prepared, request, runtime) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const fetch = yield* FetchHttpClient.Fetch
              return transport
                .frames(prepared, request, runtime)
                .pipe(
                  Stream.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
                  Stream.provideService(FetchHttpClient.Fetch, finalAnswers(fetch)),
                  Stream.mapError(gatewayError),
                )
            }),
          ),
      },
    })
    .model({ id: model.id })
}

// The shared executor retries 5xx answers. Codium saying it is not available is final, so it arrives as a client
// error and fails the turn at once instead of being retried.
function finalAnswers(fetch: typeof globalThis.fetch) {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init)
      if (response.status < 500) return response
      const body = await response.clone().text()
      if (!ModelPlans.gatewayFailure(response.status, body)) return response
      return new Response(body, { status: 400, headers: response.headers })
    },
    { preconnect: fetch.preconnect },
  )
}

// Billing and availability answers fail the turn at once with a clear message and are never retried.
function gatewayError<E>(error: E) {
  if (!(error instanceof LLMError) || !("http" in error.reason) || !error.reason.http) return error
  const http = error.reason.http
  if (ModelPlans.contextFailure(http.body))
    return new LLMError({
      module: "ModelPlans",
      method: "request",
      reason: new InvalidRequestReason({
        message: "This conversation is too long for the Codium model. Compact it before continuing.",
        classification: "context-overflow",
        http,
      }),
    })
  const failure = ModelPlans.gatewayFailure(http.response?.status, http.body)
  if (!failure) return error
  return new LLMError({
    module: "ModelPlans",
    method: "request",
    reason:
      failure.kind === "credits"
        ? new QuotaExceededReason({ message: failure.message, http })
        : failure.kind === "sign-in"
          ? new AuthenticationReason({ message: failure.message, kind: "expired", http })
          : new InvalidRequestReason({ message: failure.message, http }),
  })
}

function invalidRequest(cause: unknown) {
  return new LLMError({
    module: "ModelPlans",
    method: "request",
    reason: new InvalidRequestReason({
      message: cause instanceof Error ? cause.message : "Vector Codium is unavailable.",
    }),
  })
}
