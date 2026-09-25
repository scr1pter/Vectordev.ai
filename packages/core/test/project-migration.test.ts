import { expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProjectV2 } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([ProjectV2.node, Database.node])))

for (const scenario of ["one", "two", "duplicate", "unrelated", "unknown", "symlink", "large", "current"] as const) {
  it.live(`project cache recovery: ${scenario}`, () =>
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const directory = AbsolutePath.make(temp.path)
      yield* Effect.promise(() => $`git init`.cwd(directory).quiet())
      const database = yield* Database.Service
      const project = yield* ProjectV2.Service
      const first = ProjectV2.ID.make(crypto.randomUUID())
      const second = ProjectV2.ID.make(crypto.randomUUID())
      yield* database.db
        .insert(ProjectTable)
        .values(
          [first, second].map((id) => ({
            id,
            worktree: scenario === "unrelated" ? AbsolutePath.make(path.join(directory, "elsewhere")) : directory,
            vcs: "git",
            sandboxes: [],
            time_created: Date.now(),
            time_updated: Date.now(),
          })),
        )
        .run()
        .pipe(Effect.orDie)
      const file = path.join(directory, ".git", "prior-project-cache")
      const value =
        scenario === "unknown" ? "missing-project" : scenario === "large" ? " ".repeat(256) + first : first + "\n"
      if (scenario === "symlink") {
        yield* Effect.promise(() => Bun.write(path.join(directory, "external-id"), value))
        yield* Effect.promise(() => fs.symlink(path.join(directory, "external-id"), file))
      }
      if (scenario !== "symlink") yield* Effect.promise(() => Bun.write(file, value))
      if (scenario === "two" || scenario === "duplicate")
        yield* Effect.promise(() =>
          Bun.write(path.join(directory, ".git", "another-cache"), scenario === "two" ? second : first),
        )
      if (scenario === "current")
        yield* Effect.promise(() => Bun.write(path.join(directory, ".git", "vector", "project-id"), second))

      const result = yield* project.resolve(directory)
      const expected = scenario === "current" ? second : scenario === "one" ? first : undefined
      expect(result.previous).toBe(expected)
      expect(result.id).toBe(expected ?? ProjectV2.ID.global)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(value)
      if (scenario !== "current")
        expect(
          yield* Effect.promise(() => Bun.file(path.join(directory, ".git", "vector", "project-id")).exists()),
        ).toBe(false)
    }),
  )
}
