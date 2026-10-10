import { Database } from "@vectordevai/core/database/database"
import { LocationServiceMap } from "@vectordevai/core/location-services"
import { Location } from "@vectordevai/core/location"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionTable } from "@vectordevai/core/session/sql"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError, SessionNotFoundError } from "@vectordevai/protocol/errors"
import {
  allowsSession,
  allowsWorkspace,
  RequestPrincipal,
} from "@vectordevai/protocol/middleware/authorization"
import type { LocationServices } from "../location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@vector/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError, ForbiddenError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(SessionV2.ID)

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const row = yield* db
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row)
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })
        const principal = yield* RequestPrincipal
        if (!allowsSession(principal, sessionID) && !allowsWorkspace(principal, row.workspaceID ?? undefined))
          return yield* new ForbiddenError({ message: "Guest credential is not scoped to this session" })

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(row.directory),
                workspaceID: row.workspaceID ? WorkspaceV2.ID.make(row.workspaceID) : undefined,
              }),
            ),
          ),
        )
      }),
    )
  }),
)
