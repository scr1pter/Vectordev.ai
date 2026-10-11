import { beforeAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { RelativePath } from "@vectordevai/core/schema"
import { prepareRipgrep } from "./fixture/ripgrep"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

describe("Ripgrep", () => {
  beforeAll(prepareRipgrep, 65_000)

  it.live("preserves multiline filenames without fabricating parent-directory search arguments", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          // Windows cannot create filenames containing these control characters.
          if (process.platform === "win32") return
          const cwd = path.join(tmp.path, "search")
          const names = ["\n../outside.txt", "\r../outside.txt"].map((name) => RelativePath.make(name))
          for (const name of names) {
            yield* Effect.promise(() => fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(cwd, name), "needle admitted multiline file\n"))
          }
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "outside.txt"), "needle FAKE_OUTSIDE_SENTINEL\n"),
          )
          const ripgrep = yield* Ripgrep.Service
          const found = yield* ripgrep.find({ cwd, pattern: "*", hidden: true, limit: 10 })
          expect(found.map((entry) => entry.path).sort()).toEqual([...names].sort())
          const globbed = yield* ripgrep.glob({ cwd, pattern: "**/*", hidden: true, limit: 10 })
          expect(globbed.map((entry) => entry.path).sort()).toEqual([...names].sort())
          const matches = yield* ripgrep.grep({
            cwd,
            pattern: "needle",
            files: found.map((entry) => `./${entry.path}`),
            limit: 10,
          })
          expect(matches).toHaveLength(2)
          expect(matches.every((match) => match.text.includes("admitted multiline file"))).toBe(true)
          expect(matches.some((match) => match.text.includes("FAKE_OUTSIDE_SENTINEL"))).toBe(false)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("searches only admitted files across argv batches with one overall result limit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const files = Array.from(
            { length: 200 },
            (_, index) => `./${String(index).padStart(3, "0")}-${"a".repeat(180)}.txt`,
          )
          yield* Effect.promise(() =>
            Promise.all(files.map((file) => fs.writeFile(path.join(tmp.path, file), "needle\n"))),
          )
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "unapproved.txt"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service
          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", files, limit: 180 })
          expect(matches).toHaveLength(180)
          expect(matches.every((match) => files.includes(`./${match.entry.path}`))).toBe(true)
          expect(yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", files: [], limit: 10 })).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".vector")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".vector", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".vector/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".vector/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
