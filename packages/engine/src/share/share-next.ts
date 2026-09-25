import { Database } from "@vectordevai/core/database/database"
import { publicShareWarning, PublicShareRemovalError } from "@vectordevai/schema/public-share"
import { sql } from "drizzle-orm"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { Effect, Layer, Context } from "effect"
import type { SessionID } from "@/session/schema"

// Re-enabling requires a Vector-owned service and explicit user consent.
export const VECTOR_SESSION_SHARING = false

export function disabledReason(_share?: string) {
  return "Session sharing is unavailable in Vector. Export a local JSON file instead."
}

export function enabled(_share?: string) {
  return VECTOR_SESSION_SHARING
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly create: (sessionID: SessionID) => Effect.Effect<{ id: string; url: string; secret: string }, Error>
  readonly publicLinks: (sessionID: SessionID) => Effect.Effect<string[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, PublicShareRemovalError>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ShareNext") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const publicLinks = Effect.fn("ShareNext.publicLinks")(function* (sessionID: SessionID) {
      // Include descendants and links whose old Unshare cleared only session.share_url.
      const rows = yield* database.db
        .all<{ url: string }>(
          sql`
      WITH RECURSIVE descendants(id) AS (
        SELECT ${sessionID}
        UNION
        SELECT session.id FROM session JOIN descendants ON session.parent_id = descendants.id
      )
      SELECT share_url AS url FROM session WHERE id IN (SELECT id FROM descendants) AND share_url IS NOT NULL
      UNION
      SELECT url FROM session_share WHERE session_id IN (SELECT id FROM descendants)
    `,
        )
        .pipe(Effect.orDie)
      return rows.map((row) => row.url).filter(Boolean)
    })
    return Service.of({
      init: () => Effect.void,
      create: () => Effect.fail(new Error(disabledReason())),
      publicLinks,
      remove: Effect.fn("ShareNext.remove")(function* (sessionID) {
        const links = yield* publicLinks(sessionID)
        if (links.length) return yield* publicShareWarning(links)
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as ShareNext from "./share-next"
