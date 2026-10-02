import { Effect } from "effect"
import { array, check, object, stable } from "./assertions"
import { call } from "./backend"
import { http, route } from "./dsl"
import type { Scenario, ScenarioContext } from "./types"

const archive = {
  version: 1,
  engine: "v1",
  title: "Portable HTTP transcript",
  messages: [
    {
      id: "original-user",
      role: "user",
      createdAt: 1,
      parts: [{ type: "text", text: "Keep this imported conversation passive." }],
    },
    {
      id: "original-assistant",
      role: "assistant",
      createdAt: 2,
      parts: [
        { type: "text", text: "Recorded answer" },
        {
          type: "tool",
          name: "bash",
          callID: "original-call",
          status: "interrupted",
          input: '{"command":"touch imported-tool-ran"}',
          output: "Never executed",
        },
      ],
    },
  ],
} as const

export const sessionScenarios: Scenario[] = [
  http.protected
    .delete("/api/session/{sessionID}/share", "v2.session.unshare.unshared")
    .inProject({ git: true, config: { share: "disabled" } })
    .mutating()
    .seeded(importV2)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/share", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .status(204, (ctx, result) =>
      Effect.gen(function* () {
        check(result.text === "", "unsharing an unshared session should return no content")
        yield* unchangedV2(ctx, ctx.state)
      }),
    ),
  http.protected
    .get("/api/session/{sessionID}/share/preview", "v2.session.sharePreview.passive")
    .inProject({ git: true, config: { share: "disabled" } })
    .seeded(importV2)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/share/preview", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(stable(body.data) === stable(ctx.state.preview), "preview should retain the imported transcript")
        yield* unchangedV2(ctx, ctx.state)
      }),
    ),
  http.protected
    .get("/session/{sessionID}/share/preview", "session.sharePreview.passive")
    .inProject({ git: true, config: { share: "disabled" } })
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Local preview only" })
        const message = yield* ctx.message(session.id, { text: "A visible local message" })
        return { session, message, before: yield* ctx.messages(session.id) }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/share/preview", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.version === 1 && body.engine === "v1", "legacy preview should be a portable v1 archive")
        check(body.title === ctx.state.session.title, "preview should preserve the local title")
        array(body.messages)
        check(body.messages.length === 1, "preview should contain the stored message")
        object(body.messages[0])
        check(body.messages[0].id === ctx.state.message.info.id, "preview should identify the stored message")
        check(
          stable(body.messages[0].parts) === stable([{ type: "text", text: ctx.state.message.part.text }]),
          "preview should expose visible text only",
        )
        check(
          stable(yield* ctx.messages(ctx.state.session.id)) === stable(ctx.state.before),
          "preview must not mutate history",
        )
        const session = yield* jsonRequest(
          ctx,
          "get",
          route("/session/{sessionID}", { sessionID: ctx.state.session.id }),
        )
        object(session)
        check(session.share === undefined, "preview must not create a public share")
      }),
    ),
  http.protected
    .post("/api/session/import", "v2.session.importArchive.passive")
    .inProject({ git: true, config: { share: "disabled" } })
    .mutating()
    .at((ctx) => ({
      path: "/api/session/import",
      headers: ctx.headers(),
      body: { archive, location: { directory: ctx.directory } },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        object(body.data)
        check(typeof body.data.id === "string" && body.data.id.startsWith("ses"), "import should persist a new session")
        check(body.data.title === archive.title, "import should preserve the transcript title")
        object(body.data.location)
        check(body.data.location.directory === ctx.directory, "import should use the explicit isolated location")
        const preview = yield* previewV2(ctx, body.data.id)
        check(preview.engine === "v2" && preview.version === 1, "v1 public import should target the v2 engine")
        array(preview.messages)
        check(preview.messages.length === 2, "import should persist both transcript messages")
        preview.messages.forEach((message, index) => {
          object(message)
          check(message.id !== archive.messages[index]!.id, "import must assign fresh message identities")
          check(message.role === archive.messages[index]!.role, "import should preserve message roles")
          array(message.parts)
          message.parts.forEach((part) => {
            object(part)
            check(part.type === "text", "imported public tool records must become passive text")
          })
        })
        check(stable(preview.messages).includes("Never executed"), "import should preserve the visible tool record")
        check(
          !(yield* Effect.promise(() => Bun.file(`${ctx.directory}/imported-tool-ran`).exists())),
          "import must not execute transcript tools",
        )
        const active = yield* jsonRequest(ctx, "get", "/api/session/active")
        object(active)
        object(active.data)
        check(!(body.data.id in active.data), "import must not schedule model execution")
        yield* unchangedV2(ctx, { id: body.data.id, preview })
      }),
    ),
  http.protected
    .post("/api/session/{sessionID}/free-models/resume", "v2.session.resumeFreeModels.stale")
    .inProject({ git: true, config: { share: "disabled" } })
    .mutating()
    .seeded(importV2)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/free-models/resume", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { messageID: "msg_httpapi_stale", modelID: "test/model:free" },
    }))
    .jsonEffect(400, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body._tag === "InvalidRequestError", "stale continuation should be a typed request rejection")
        check(
          typeof body.message === "string" && body.message.includes("no longer the current turn"),
          "stale turn must be rejected before credentials or inference",
        )
        yield* unchangedV2(ctx, ctx.state)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/free-models/resume", "session.resumeFreeModels.missing")
    .inProject({ git: true, config: { share: "disabled" } })
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Unrelated conversation" })
        yield* ctx.message(session.id, { text: "Do not replay me" })
        return { session, before: yield* ctx.messages(session.id) }
      }),
    )
    // The legacy handler checks credentials before turn eligibility. A missing session fails earlier,
    // guaranteeing that even an inherited OpenRouter key cannot trigger a catalog request here.
    .at((ctx) => ({
      path: route("/session/{sessionID}/free-models/resume", { sessionID: "ses_httpapi_missing_resume" }),
      headers: ctx.headers(),
      body: { messageID: "msg_httpapi_stale", modelID: "test/model:free" },
    }))
    .jsonEffect(404, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.name === "NotFoundError", "missing legacy session should fail before continuation")
        check(
          stable(yield* ctx.messages(ctx.state.session.id)) === stable(ctx.state.before),
          "failed continuation must not modify another conversation",
        )
      }),
    ),
  http.protected
    .post("/api/session/{sessionID}/share", "v2.session.share.disabledConsent")
    .inProject({ git: true, config: { share: "disabled" } })
    .mutating()
    .seeded(importV2)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/share", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { consent: { version: 1, public: true, updates: false }, expiresAt: Date.now() + 60_000 },
    }))
    .jsonEffect(400, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(
          body._tag === "PublicSessionError" && body.code === "CONSENT_REQUIRED",
          "disabled sharing must reject even a valid publish payload",
        )
        check(
          body.message === "Session sharing is disabled for this location.",
          "location consent must be enforced before hosted publication",
        )
        yield* unchangedV2(ctx, ctx.state)
      }),
    ),
  http.protected
    .post("/api/session/{sessionID}/share/flush", "v2.session.shareFlush.unshared")
    .inProject({ git: true, config: { share: "disabled" } })
    .mutating()
    .seeded(importV2)
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/share/flush", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .jsonEffect(400, (body, ctx) =>
      Effect.gen(function* () {
        unsharedError(body)
        yield* unchangedV2(ctx, ctx.state)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/share/flush", "session.shareFlush.legacyUnshared")
    .inProject({ git: true, config: { share: "disabled" } })
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Unshared local conversation" })
        yield* ctx.message(session.id, { text: "Keep local" })
        return { session, before: yield* ctx.messages(session.id) }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/share/flush", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .jsonEffect(400, (body, ctx) =>
      Effect.gen(function* () {
        unsharedError(body)
        check(
          stable(yield* ctx.messages(ctx.state.session.id)) === stable(ctx.state.before),
          "flush without a share must preserve local history",
        )
        const session = yield* jsonRequest(
          ctx,
          "get",
          route("/session/{sessionID}", { sessionID: ctx.state.session.id }),
        )
        object(session)
        check(session.share === undefined, "flush must not create a new share")
      }),
    ),
]

function jsonRequest(ctx: ScenarioContext, method: "get" | "post", path: string, body?: unknown) {
  return Effect.gen(function* () {
    // Setup and read-back use the same isolated real HttpApi and database as the route under test.
    const scenario = http.protected[method](path, "session.fixture")
      .at(() => ({ path, headers: ctx.headers(), body }))
      .json(200)
    const result = yield* call(scenario, { ...ctx, state: undefined })
    yield* scenario.expect(ctx, undefined, result)
    return result.body
  })
}

function importV2(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    const body = yield* jsonRequest(ctx, "post", "/api/session/import", {
      archive,
      location: { directory: ctx.directory },
    })
    object(body)
    object(body.data)
    check(typeof body.data.id === "string", "fixture import should return a persisted session")
    return { id: body.data.id, preview: yield* previewV2(ctx, body.data.id) }
  })
}

function previewV2(ctx: ScenarioContext, sessionID: string) {
  return Effect.gen(function* () {
    const body = yield* jsonRequest(ctx, "get", route("/api/session/{sessionID}/share/preview", { sessionID }))
    object(body)
    object(body.data)
    return body.data
  })
}

function unchangedV2(ctx: ScenarioContext, state: { id: string; preview: unknown }) {
  return Effect.gen(function* () {
    check(
      stable(yield* previewV2(ctx, state.id)) === stable(state.preview),
      "request must preserve stored transcript and identities",
    )
    const body = yield* jsonRequest(ctx, "get", route("/api/session/{sessionID}", { sessionID: state.id }))
    object(body)
    object(body.data)
    check(body.data.id === state.id, "request must preserve the local session")
    check(body.data.share === undefined, "request must not create a public share")
  })
}

function unsharedError(body: unknown) {
  object(body)
  check(
    body._tag === "PublicSessionError" && body.code === "NOT_FOUND",
    "flush must reject a session without a stored public share",
  )
  check(body.message === "This session has not been shared.", "flush should explain the missing consented share")
}
