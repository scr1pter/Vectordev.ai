import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpOptions, LLMRequest, LLMError, InvalidRequestReason } from "@vectordevai/llm"
import { OpenAICompatibleChat } from "@vectordevai/llm/protocols/openai-compatible-chat"
import { Auth } from "@vectordevai/llm/route"
import { freeModelRequest, serializeFreeModelRequest } from "../../free-model-request"
import { FreeModels } from "../../free-models"
import { Egress } from "../../local-mode/egress"
import { ModelV2 } from "../../model"

/** `guest` says whether an invited guest has worked in the session this route serves (FreeModelGuests.marked). */
export function freeModelRoute(
  model: ModelV2.Info,
  client: FreeModels.Service["Service"],
  credentials: FreeModels.CredentialsService["Service"],
  guest: Effect.Effect<boolean>,
) {
  const transport = OpenAICompatibleChat.route.transport
  return OpenAICompatibleChat.route
    .with({
      provider: model.providerID,
      endpoint: { baseURL: "https://vectordev.ai", path: "/api/free-models/chat" },
      limits: { context: model.limit.context, output: model.limit.output },
      transport: {
        ...transport,
        prepare: (input) =>
          Effect.gen(function* () {
            // Vector Local keeps free models off. The runner refuses them before a route is built
            // (SessionRunnerModel.allowedInLocal); this holds for any other caller of the route.
            const decided = Egress.decide({ source: "vector-free-models", url: FreeModels.SHARED_CHAT_URL })
            if (decided.decision !== "allow") return yield* Effect.fail(invalidRequest(decided.reason))
            const route = yield* Effect.tryPromise({
              try: () =>
                FreeModels.resolveRoute({
                  provider: model.providerID === "vector" ? "vector" : "openrouter",
                  modelID: model.id,
                  catalog: () => Effect.runPromise(client.catalog()),
                  forKey: (key) => Effect.runPromise(client.forKey(key)),
                  credential: (provider) => Effect.runPromise(credentials.get(provider)),
                  trainingConsent: () => Effect.runPromise(client.trainingConsent()),
                  guest: () => Effect.runPromise(guest),
                }),
              catch: (cause) => invalidRequest(cause instanceof Error ? cause.message : "Free model unavailable."),
            })
            const body = yield* Effect.try({
              try: () =>
                serializeFreeModelRequest(
                  freeModelRequest({ ...input.request.http?.body, ...input.body, model: model.id }, route.models, {
                    trainingConsent: route.trainingConsent,
                    guest: route.guest,
                  }),
                  route.url === FreeModels.SHARED_CHAT_URL,
                ),
              catch: (cause) =>
                invalidRequest(cause instanceof Error ? cause.message : "Free model request is invalid."),
            })
            // Endpoint, headers, auth, query and body are fixed at the final transport boundary.
            // Project configuration and plugin overlays cannot redirect a credential or add paid services.
            return yield* transport.prepare({
              ...input,
              request: LLMRequest.update(input.request, { http: new HttpOptions({}) }),
              endpoint: { ...input.endpoint, baseURL: route.url, path: "" },
              auth: Auth.bearer(Auth.value(route.key)),
              headers: () => ({
                "HTTP-Referer": "https://vectordev.ai/",
                "X-OpenRouter-Title": "Vector",
                ...route.headers,
              }),
              encodeBody: () => body,
            })
          }),
        frames: (prepared, request, runtime) =>
          transport
            .frames(prepared, request, runtime)
            .pipe(Stream.provideService(FetchHttpClient.RequestInit, { redirect: "error" })),
      },
    })
    .model({ id: model.id })
}

function invalidRequest(message: string) {
  return new LLMError({ module: "FreeModels", method: "request", reason: new InvalidRequestReason({ message }) })
}
