import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProjectV2 } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { SessionTable } from "@vectordevai/core/session/sql"
import { WorkspaceTable } from "@vectordevai/core/control-plane/workspace.sql"
import { WorkspaceV2 } from "@vectordevai/core/workspace"
import { Hash } from "@vectordevai/core/util/hash"
import { AbsolutePath } from "@vectordevai/core/schema"
import { Project } from "@/project/project"
import { SessionID } from "@/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, CrossSpawnSpawner.node])))

for (const change of ["added", "removed", "changed"] as const) {
  describe(`project upgrade with origin ${change}`, () => {
    it.live("recovers one content-proven cache and preserves unrelated project history", () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const projects = yield* Project.Service
        const directory = AbsolutePath.make(yield* tmpdirScoped({ git: true }))
        if (change !== "added")
          yield* Effect.promise(() =>
            $`git remote add origin https://github.com/vector-test/before.git`.cwd(directory).quiet(),
          )
        const previous = yield* projects.fromDirectory(directory)
        const other = ProjectV2.ID.make(crypto.randomUUID())
        const session = SessionID.create()
        const otherSession = SessionID.create()
        const workspace = WorkspaceV2.ID.ascending()
        yield* database.db
          .insert(ProjectTable)
          .values({
            id: other,
            worktree: directory,
            vcs: "git",
            sandboxes: [],
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values([
            {
              id: session,
              project_id: previous.project.id,
              slug: session,
              directory,
              title: "before upgrade",
              version: "test",
              time_created: Date.now(),
              time_updated: Date.now(),
            },
            {
              id: otherSession,
              project_id: other,
              slug: otherSession,
              directory,
              title: "separate project",
              version: "test",
              time_created: Date.now(),
              time_updated: Date.now(),
            },
          ])
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(WorkspaceTable)
          .values({
            id: workspace,
            type: "local",
            name: "before upgrade",
            project_id: previous.project.id,
          })
          .run()
          .pipe(Effect.orDie)
        const cache = path.join(directory, ".git", "vector", "project-id")
        const prior = path.join(directory, ".git", "prior-project-cache")
        yield* Effect.promise(() => fs.rename(cache, prior))
        if (change === "removed") yield* Effect.promise(() => $`git remote remove origin`.cwd(directory).quiet())
        if (change === "changed")
          yield* Effect.promise(() =>
            $`git remote set-url origin https://github.com/vector-test/after.git`.cwd(directory).quiet(),
          )
        if (change === "added")
          yield* Effect.promise(() =>
            $`git remote add origin https://github.com/vector-test/after.git`.cwd(directory).quiet(),
          )

        const result = yield* projects.fromDirectory(directory)
        const expected =
          change === "removed"
            ? previous.project.id
            : ProjectV2.ID.make(Hash.fast("git-remote:github.com/vector-test/after"))
        expect(result.project.id).toBe(expected)
        expect(
          (yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, session)).get().pipe(Effect.orDie))
            ?.project_id,
        ).toBe(expected)
        expect(
          (yield* database.db
            .select()
            .from(WorkspaceTable)
            .where(eq(WorkspaceTable.id, workspace))
            .get()
            .pipe(Effect.orDie))?.project_id,
        ).toBe(expected)
        expect(
          (yield* database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, otherSession))
            .get()
            .pipe(Effect.orDie))?.project_id,
        ).toBe(other)
        expect(yield* projects.get(other)).toBeDefined()
        if (change !== "removed") expect(yield* projects.get(previous.project.id)).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(cache).text())).toBe(expected)
        expect(yield* Effect.promise(() => Bun.file(prior).text())).toBe(previous.project.id)
        expect((yield* projects.fromDirectory(directory)).project.id).toBe(expected)
      }),
    )
  })
}
