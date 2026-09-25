import { expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { FreeModels } from "../src/free-models"
import { Location } from "../src/location"
import { location } from "./fixture/location"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { FreeModelsResume } from "../src/session/free-model-resume"
import { SessionEvent } from "../src/session/event"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { Prompt } from "../src/session/prompt"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { testEffect } from "./lib/effect"

const model = FREE_MODEL_FALLBACKS[0]
const sessionID = SessionSchema.ID.make("ses_free_resume")
const messageID = SessionMessage.ID.make("msg_failed")
const request = { sessionID, messageID, modelID: ModelV2.ID.make(model.id) }
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      FreeModelsResume.node,
      Catalog.node,
      SessionStore.node,
      SessionProjector.node,
      EventV2.node,
      Database.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ],
      [
        FreeModels.node,
        Layer.succeed(
          FreeModels.Service,
          FreeModels.Service.of({
            catalog: () => Effect.succeed({ enabled: true, updatedAt: 1, models: [model] }),
            forKey: () => Effect.succeed([model]),
          }),
        ),
      ],
      [
        FreeModels.credentialsNode,
        Layer.succeed(
          FreeModels.CredentialsService,
          FreeModels.CredentialsService.of({ get: () => Effect.succeed("synthetic-key") }),
        ),
      ],
    ],
  ),
)
const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const catalog = yield* Catalog.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "free",
      directory: "/project",
      title: "keep this title",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* catalog.transform((draft) => {
    draft.provider.update(ProviderV2.ID.openrouter, () => {})
    draft.model.update(ProviderV2.ID.openrouter, ModelV2.ID.make(model.id), (entry) => {
      entry.freeModel = { source: "openrouter" }
    })
  })
  yield* events.publish(SessionEvent.Prompted, {
    sessionID,
    messageID: SessionMessage.ID.make("msg_user"),
    timestamp: DateTime.makeUnsafe(1),
    prompt: Prompt.make({ text: "keep this request" }),
    delivery: "steer",
  })
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID: messageID,
    timestamp: DateTime.makeUnsafe(2),
    agent: "build",
    model: { providerID: ProviderV2.ID.vector, id: ModelV2.ID.make(model.id) },
  })
  yield* events.publish(SessionEvent.Step.Failed, {
    sessionID,
    assistantMessageID: messageID,
    timestamp: DateTime.makeUnsafe(3),
    error: {
      type: "free_models_limit",
      code: "VECTOR_FREE_MODELS_LIMIT",
      reason: "user_daily",
      resetAt: 123456,
      message: "Shared allowance used",
    },
  })
})

it.effect("admits own-key continuation without a second prompt and clears only the exact failed assistant error", () =>
  Effect.gen(function* () {
    yield* setup
    const service = yield* FreeModelsResume.Service
    const store = yield* SessionStore.Service
    yield* service.prepare(request)
    const history = yield* store.context(sessionID)
    expect(history.filter((message) => message.type === "user")).toHaveLength(1)
    expect(history.find((message) => message.id === messageID)).toMatchObject({ type: "assistant", finish: "error" })
    expect(history.find((message) => message.id === messageID)).not.toHaveProperty("error")
    expect(yield* store.get(sessionID)).toMatchObject({
      title: "keep this title",
      model: { providerID: "openrouter", id: model.id },
    })
    expect(yield* service.prepare(request).pipe(Effect.flip)).toBeInstanceOf(FreeModelsResume.Rejected)
  }),
)

it.effect("rejects stale message IDs, changed models and pending durable prompts before changing history", () =>
  Effect.gen(function* () {
    yield* setup
    const service = yield* FreeModelsResume.Service
    const store = yield* SessionStore.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const before = yield* store.context(sessionID)
    expect(
      yield* service.prepare({ ...request, messageID: SessionMessage.ID.make("msg_stale") }).pipe(Effect.flip),
    ).toBeInstanceOf(FreeModelsResume.Rejected)
    expect(
      yield* service.prepare({ ...request, modelID: ModelV2.ID.make("paid/model") }).pipe(Effect.flip),
    ).toBeInstanceOf(FreeModelsResume.Rejected)
    yield* SessionInput.admit(database.db, events, {
      id: SessionMessage.ID.make("msg_new"),
      sessionID,
      prompt: Prompt.make({ text: "new request" }),
      delivery: "queue",
    })
    expect(yield* service.prepare(request).pipe(Effect.flip)).toBeInstanceOf(FreeModelsResume.Rejected)
    expect(yield* store.context(sessionID)).toEqual(before)
  }),
)
