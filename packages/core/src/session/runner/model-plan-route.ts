import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  AuthenticationReason,
  HttpContext,
  HttpOptions,
  InvalidRequestReason,
  LLMError,
  LLMRequest,
  QuotaExceededReason,
  RateLimitReason,
} from "@vectordevai/llm"
import { OpenAICompatibleChat } from "@vectordevai/llm/protocols/openai-compatible-chat"
import { Auth } from "@vectordevai/llm/route"
import { FreeModels } from "../../free-models"
import { ModelPlans } from "../../model-plans"
import { Egress } from "../../local-mode/egress"
import { ModelPlanStatus } from "../../model-plan-status"
import { ModelV2 } from "../../model"
import { SessionMessage } from "../message"

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
            // Vector Local keeps Vector Codium off. The runner refuses it before a route is built
            // (SessionRunnerModel.allowedInLocal); this holds for any other caller of the route.
            const decided = Egress.decide({ source: "vector-codium", url: ModelPlans.CHAT_URL })
            if (decided.decision !== "allow") return yield* Effect.fail(invalidRequest(new Error(decided.reason)))
            const route = yield* Effect.tryPromise({
              try: () =>
                ModelPlans.resolveRoute({
                  modelID: model.id,
                  credential: () => Effect.runPromise(credentials.get("vector")),
                  catalog: (token) => Effect.runPromise(client.catalog(token, { wait: true })),
                }),
              catch: (cause) => invalidRequest(cause),
            })
            // Nothing was sent; the turn fails with the message and action the gateway would have given.
            if (route.refused)
              return yield* failure(ModelPlans.gatewayFailure(route.refused.status, route.refused.body)!)
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

// The shared executor retries 5xx and 429 answers. Codium saying it is not available is final, so it arrives as a
// client error and fails the turn at once; short model capacity is temporary, so it arrives as a rate limit and the
// executor retries it.
function finalAnswers(fetch: typeof globalThis.fetch) {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init)
      if (response.status < 402 || (response.status > 402 && response.status < 500)) return response
      const body = await response.clone().text()
      const answer = ModelPlans.gatewayFailure(response.status, body)
      if (answer?.kind === "capacity") return new Response(body, { status: 429, headers: response.headers })
      if (!answer || response.status < 500) return response
      return new Response(body, { status: 400, headers: response.headers })
    },
    { preconnect: fetch.preconnect },
  )
}

// Billing and availability answers fail the turn with a clear message, and the action that fixes them, at once.
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
  const answer = ModelPlans.gatewayFailure(
    // A capacity answer reaches here as the 429 finalAnswers made of it, once the executor's retries ran out.
    http.response?.status === 429 ? 402 : http.response?.status,
    http.body,
  )
  if (!answer) return error
  return new LLMError({ module: "ModelPlans", method: "request", reason: reason(answer, http) })
}

function failure(answer: ModelPlans.Failure) {
  return Effect.fail(new LLMError({ module: "ModelPlans", method: "request", reason: reason(answer) }))
}

// The session records providerMetadata.codium.action, so a client can offer Buy credits or Sign in to Vector.
function reason(answer: ModelPlans.Failure, http?: HttpContext) {
  if (answer.kind === "capacity") return new RateLimitReason({ message: answer.message, http })
  const providerMetadata = { codium: { action: answer.kind, code: answer.code } }
  if (answer.kind === "credits") return new QuotaExceededReason({ message: answer.message, providerMetadata, http })
  if (answer.kind === "sign-in")
    return new AuthenticationReason({ message: answer.message, kind: "expired", providerMetadata, http })
  return new InvalidRequestReason({ message: answer.message, providerMetadata, http })
}

/** The assistant error a failed Codium turn records, carrying the action that fixes it. */
export function codiumError(error: LLMError): SessionMessage.CodiumError | undefined {
  const metadata = "providerMetadata" in error.reason ? error.reason.providerMetadata?.codium : undefined
  const action = ModelPlanStatus.failureAction({ type: "codium", action: metadata?.action })
  return action && { type: "codium", action, message: error.reason.message }
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
