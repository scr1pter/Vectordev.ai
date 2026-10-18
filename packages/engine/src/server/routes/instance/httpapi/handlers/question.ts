import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Session } from "@/session/session"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { QuestionNotFoundError } from "../errors"
import { allowsSessionID } from "./session-access"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    const session = yield* Session.Service
    const guests = yield* FreeModelGuests.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      const principal = yield* RequestPrincipal
      return yield* Effect.filter(yield* svc.list(), (item) => allowsSessionID(session, principal, item.sessionID))
    })

    // A guest answers only the questions its own sessions ask. Another session's question reads as
    // missing, so its existence is not confirmed either.
    const requireVisible = Effect.fn("QuestionHttpApi.requireVisible")(function* (requestID: QuestionID) {
      const principal = yield* RequestPrincipal
      if (principal.kind === "owner") return
      const request = (yield* svc.list()).find((item) => item.id === requestID)
      // A guest's answer goes to the session's model as a tool result, so it keeps that session's free-model
      // requests off models that may train (FreeModelGuests), as a guest's prompt does.
      if (request && (yield* allowsSessionID(session, principal, request.sessionID)))
        return yield* guests.mark(request.sessionID)
      return yield* new QuestionNotFoundError({
        requestID: String(requestID),
        message: `Question request not found: ${requestID}`,
      })
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      yield* requireVisible(ctx.params.requestID)
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* requireVisible(ctx.params.requestID)
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
