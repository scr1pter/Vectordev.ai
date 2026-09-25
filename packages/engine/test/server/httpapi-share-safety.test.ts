import { WorkspaceTable } from "@vectordevai/core/control-plane/workspace.sql"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { afterEach, describe, expect } from "bun:test"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { SessionShareTable } from "@vectordevai/core/share/sql"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { ShareNext } from "../../src/share/share-next"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([FSUtil.node, Session.node, ShareNext.node, Database.node])),
    httpApiLayer,
  ),
)
const options = { config: { formatter: false, lsp: false } }
const url = "https://example.com/public/synthetic-session"
const secret = "synthetic-private-removal-secret"

const seedShare = Effect.fn(function* (sessionID: SessionID) {
  const database = yield* Database.Service
  yield* database.db
    .insert(SessionShareTable)
    .values({ session_id: sessionID, id: "synthetic-share", secret, url })
    .run()
    .pipe(Effect.orDie)
})
const retainedShare = Effect.fn(function* (sessionID: SessionID) {
  const database = yield* Database.Service
  return yield* database.db
    .select()
    .from(SessionShareTable)
    .where(eq(SessionShareTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("public share deletion safety", () => {
  it.instance(
    "unshare preserves both URL fields and the removal secret",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const session = yield* Session.Service
      const info = yield* session.create()
      yield* seedShare(info.id)
      yield* session.setShare({ sessionID: info.id, share: { url } })
      const response = yield* requestInDirectory(`/session/${info.id}/share`, directory, { method: "DELETE" })
      expect(response.status).toBe(409)
      const body = yield* response.text
      expect(JSON.parse(body)).toMatchObject({ _tag: "PublicShareRemovalError", links: [url] })
      expect(body).not.toContain(secret)
      expect((yield* session.get(info.id)).share?.url).toBe(url)
      expect(yield* retainedShare(info.id)).toMatchObject({ url, secret })
    }),
    options,
  )

  it.instance(
    "blocks parent deletion before cascading, including a child with only a retained table URL",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const session = yield* Session.Service
      const parent = yield* session.create()
      const child = yield* session.create({ parentID: parent.id })
      yield* seedShare(child.id)
      const response = yield* requestInDirectory(`/session/${parent.id}`, directory, { method: "DELETE" })
      expect(response.status).toBe(409)
      expect(yield* response.json).toMatchObject({ _tag: "PublicShareRemovalError", links: [url] })
      expect((yield* session.get(parent.id)).id).toBe(parent.id)
      expect((yield* session.get(child.id)).id).toBe(child.id)
      expect(yield* retainedShare(child.id)).toMatchObject({ url, secret })
      const blocked = yield* Effect.flip(session.remove(parent.id))
      expect(blocked._tag).toBe("PublicShareRemovalError")

      const deleted = yield* requestInDirectory(`/session/${parent.id}?acknowledgePublicShares=true`, directory, {
        method: "DELETE",
      })
      expect(deleted.status).toBe(200)
      expect(yield* deleted.json).toMatchObject({
        deleted: true,
        links: [url],
        warnings: [expect.stringContaining("public copy")],
      })
      expect((yield* Effect.flip(session.get(parent.id))).message).toContain("not found")
      expect((yield* Effect.flip(session.get(child.id))).message).toContain("not found")
      expect(yield* retainedShare(child.id)).toBeUndefined()
    }),
    options,
  )

  it.instance(
    "workspace deletion preflights every session before removing any",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const session = yield* Session.Service
      const database = yield* Database.Service
      const local = yield* session.create()
      const shared = yield* session.create()
      const workspaceID = WorkspaceV2.ID.make("wrk_synthetic_shared")
      yield* database.db
        .insert(WorkspaceTable)
        .values({ id: workspaceID, type: "synthetic", project_id: local.projectID })
        .run()
        .pipe(Effect.orDie)
      yield* session.setWorkspace({ sessionID: local.id, workspaceID })
      yield* session.setWorkspace({ sessionID: shared.id, workspaceID })
      yield* seedShare(shared.id)
      const response = yield* requestInDirectory(`/experimental/workspace/${workspaceID}`, directory, {
        method: "DELETE",
      })
      expect(response.status).toBe(409)
      expect(yield* response.json).toMatchObject({ links: [url] })
      expect((yield* session.get(local.id)).id).toBe(local.id)
      expect((yield* session.get(shared.id)).id).toBe(shared.id)
      expect(
        yield* database.db
          .select()
          .from(WorkspaceTable)
          .where(eq(WorkspaceTable.id, workspaceID))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()
    }),
    options,
  )

  it.instance(
    "ordinary local-only sessions still delete with the existing boolean response",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const session = yield* Session.Service
      const info = yield* session.create()
      const response = yield* requestInDirectory(`/session/${info.id}`, directory, { method: "DELETE" })
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
    }),
    options,
  )
})
