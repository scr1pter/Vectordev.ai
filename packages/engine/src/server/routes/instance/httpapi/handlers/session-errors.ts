import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { Snapshot } from "@/snapshot"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

// The two failures a revert can produce. Kept as one mapper because the
// endpoints raise both and nesting two generic mappers fights catchTag's
// narrowing for no benefit.
//
// A collected snapshot is a 409, not a 500: the request was valid, the server
// state simply no longer allows it, and the client needs to tell the user their
// files were left untouched.
export function mapRevert<A, R>(
  self: Effect.Effect<A, Session.BusyError | Snapshot.SnapshotUnavailableError, R>,
) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
    Effect.catchTag("SnapshotUnavailableError", (error) =>
      Effect.fail(
        new ApiError.ConflictError({
          resource: error.hash,
          message: error.file
            ? `The snapshot for this change is no longer available, so ${error.file} was left as it is. Nothing was deleted.`
            : "The snapshot for this change is no longer available, so your files were left as they are.",
        }),
      ),
    ),
  )
}
