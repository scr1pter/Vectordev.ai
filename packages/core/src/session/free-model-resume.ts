export * as FreeModelsResume from "./free-model-resume"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Catalog } from "../catalog"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FreeModels } from "../free-models"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

export const Input = Schema.Struct({ sessionID: SessionSchema.ID, messageID: SessionMessage.ID, modelID: ModelV2.ID })
export type Input = typeof Input.Type
export class Rejected extends Schema.TaggedErrorClass<Rejected>()("FreeModelsResume.Rejected", {
  message: Schema.String,
}) {}

export class Service extends Context.Service<
  Service,
  {
    readonly prepare: (input: Input) => Effect.Effect<void, Rejected>
  }
>()("@vector/FreeModelsResume") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const credentials = yield* FreeModels.CredentialsService
      const freeModels = yield* FreeModels.Service
      const catalog = yield* Catalog.Service
      return Service.of({
        prepare: Effect.fn("FreeModelsResume.prepare")(function* (input) {
          const validate = Effect.gen(function* () {
            const session = yield* store.get(input.sessionID)
            const history = yield* store.context(input.sessionID).pipe(Effect.orDie)
            const latest = history.findLast((message) => message.type === "assistant" || message.type === "user")
            if (
              !session ||
              latest?.type !== "assistant" ||
              latest.id !== input.messageID ||
              latest.error?.type !== "free_models_limit" ||
              latest.model.id !== input.modelID ||
              !["vector", "openrouter"].includes(latest.model.providerID) ||
              !input.modelID.endsWith(":free") ||
              (session.model &&
                (session.model.id !== input.modelID || !["vector", "openrouter"].includes(session.model.providerID))) ||
              history.some(
                (message) =>
                  message.type === "assistant" &&
                  message.content.some(
                    (part) => part.type === "tool" && ["pending", "running"].includes(part.state.status),
                  ),
              ) ||
              (yield* SessionInput.hasPending(database.db, input.sessionID, "steer")) ||
              (yield* SessionInput.hasPending(database.db, input.sessionID, "queue"))
            )
              return yield* new Rejected({
                message:
                  "This free-model interruption is no longer the current turn. Continue the latest conversation.",
              })
          })
          yield* validate
          const key = yield* credentials.get("openrouter")
          if (!key)
            return yield* new Rejected({ message: "Connect OpenRouter to continue with your own free allowance." })
          const models = yield* freeModels.forKey(key, true)
          if (
            !models.some((model) => model.id === input.modelID) ||
            !(yield* catalog.model.available()).some(
              (model) =>
                model.providerID === "openrouter" &&
                model.id === input.modelID &&
                model.freeModel?.source === "openrouter",
            )
          )
            return yield* new Rejected({
              message: "That free model is unavailable for your OpenRouter account or privacy settings.",
            })
          // Serialize the final stale check and both durable projections against new prompt admission.
          yield* database.db
            .transaction(() =>
              Effect.gen(function* () {
                yield* validate
                yield* events.publish(SessionEvent.ModelSwitched, {
                  sessionID: input.sessionID,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  model: { providerID: ProviderV2.ID.openrouter, id: input.modelID },
                })
                yield* events.publish(SessionEvent.Step.Resumed, {
                  sessionID: input.sessionID,
                  assistantMessageID: input.messageID,
                  timestamp: yield* DateTime.now,
                })
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                error instanceof Rejected
                  ? error
                  : new Rejected({ message: "Vector could not record this continuation. Try again." }),
              ),
            )
        }),
      })
    }),
  ),
  deps: [SessionStore.node, Database.node, EventV2.node, FreeModels.node, FreeModels.credentialsNode, Catalog.node],
})
