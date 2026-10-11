import { Location } from "@vectordevai/core/location"
import { LocationServiceMap } from "@vectordevai/core/location-services"
import { PtyTicket } from "@vectordevai/core/pty/ticket"
import { AbsolutePath } from "@vectordevai/core/schema"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError } from "@vectordevai/protocol/errors"
import { guestWorkspaceDirectory, RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { outdatedDirectoryHeader, OUTDATED_CLIENT_MESSAGE } from "./location-headers"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@vector/HttpApiLocation",
  { error: [InvalidRequestError, ForbiddenError] },
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

function ref(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-vector-workspace"]
  const header = request.headers["x-vector-directory"]
  const directory = query.get("location[directory]") || (header ? decode(header) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const tickets = yield* PtyTicket.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const header = outdatedDirectoryHeader(request.headers)
        if (header)
          return yield* new InvalidRequestError({
            message: OUTDATED_CLIENT_MESSAGE,
            kind: "client_outdated",
            field: header,
          })
        const requested = ref(request)
        const principal = yield* RequestPrincipal
        if (principal.kind === "pty-ticket") {
          const valid = yield* tickets.consume({
            ptyID: principal.ptyID,
            ticket: principal.ticket,
            directory: requested.directory,
            workspaceID: requested.workspaceID,
          })
          if (!valid) return yield* new ForbiddenError({ message: "Invalid PTY connect ticket" })
          return yield* effect.pipe(Effect.provide(locations.get(requested)))
        }
        const guestDirectory = guestWorkspaceDirectory(principal, requested.workspaceID)
        if (principal.kind === "guest" && guestDirectory === undefined)
          return yield* new ForbiddenError({ message: "Guest credential is not scoped to this workspace" })
        const location =
          principal.kind === "guest"
            ? Location.Ref.make({ directory: AbsolutePath.make(guestDirectory!), workspaceID: requested.workspaceID })
            : requested
        return yield* effect.pipe(Effect.provide(locations.get(location)))
      }),
    )
  }),
)
