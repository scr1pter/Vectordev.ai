import { describe, expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionTable } from "@vectordevai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const root = SessionV2.ID.make("ses_guest_root")
const child = SessionV2.ID.make("ses_guest_child")
const grandchild = SessionV2.ID.make("ses_guest_grandchild")
const other = SessionV2.ID.make("ses_guest_other")

const sessions = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  for (const [id, parent] of [
    [root, undefined],
    [child, root],
    [grandchild, child],
    [other, undefined],
  ] as const)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        parent_id: parent,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
})

const registry = (file: string | undefined) =>
  Effect.gen(function* () {
    return yield* FreeModelGuests.Service
  }).pipe(Effect.provide(FreeModelGuests.layerFor(file).pipe(Layer.fresh)))

describe("FreeModelGuests", () => {
  it.effect("a guest's input anywhere in a session tree marks the whole tree and nothing else", () =>
    Effect.gen(function* () {
      yield* sessions
      const guests = yield* registry(undefined)
      expect(yield* guests.marked(grandchild)).toBe(false)
      // A guest's message to a subagent: its result flows into the parent, and the parent's history into the rest.
      yield* guests.mark(grandchild)
      for (const id of [root, child, grandchild]) expect(yield* guests.marked(id)).toBe(true)
      expect(yield* guests.marked(other)).toBe(false)
      // A request outside any session, such as generating an agent from the terminal, is the owner's.
      expect(yield* guests.marked(undefined)).toBe(false)
    }),
  )

  it.effect("a mark outlives a restart, and an unreadable file marks nothing", () =>
    Effect.gen(function* () {
      yield* sessions
      const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "free-model-guests-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
      const file = path.join(directory, "free-model-guest-sessions.json")
      const first = yield* registry(file)
      yield* first.mark(child)
      // A new engine on the same database, as after a restart, reads the mark back for any session of the tree.
      const restarted = yield* registry(file)
      expect(yield* restarted.marked(grandchild)).toBe(true)
      expect(yield* restarted.marked(other)).toBe(false)
      yield* Effect.promise(() => writeFile(file, "not json"))
      const unreadable = yield* registry(file)
      expect(yield* unreadable.marked(root)).toBe(false)
    }),
  )
})
