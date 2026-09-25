import { Location } from "@vectordevai/core/location"
import { LocationServiceMap } from "@vectordevai/core/location-services"
import { AbsolutePath } from "@vectordevai/core/schema"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@vectordevai/protocol/errors"
import { outdatedDirectoryHeader, OUTDATED_CLIENT_MESSAGE } from "./location-headers"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@vector/HttpApiLocation",
  { error: InvalidRequestError },
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
        return yield* effect.pipe(Effect.provide(locations.get(ref(request))))
      }),
    )
  }),
)
