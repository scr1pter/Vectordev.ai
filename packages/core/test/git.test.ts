import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Git } from "@vectordevai/core/git"
import { AbsolutePath, RelativePath } from "@vectordevai/core/schema"
import { branch, commit, gitRemote } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

test("HTTP transport pins validated addresses and disables redirects", () => {
  const args = Git.httpTransportArgs(
    {
      hostname: "git.example.test",
      port: 443,
      addresses: ["203.0.113.8", "2001:db8::8"],
    },
    "http://127.0.0.1:49152",
  )
  expect(args).toContain("http.followRedirects=false")
  expect(args).toContain("http.proxy=http://127.0.0.1:49152")
  expect(args).toContain("protocol.allow=never")
  expect(args).toContain("protocol.https.allow=always")
  expect(args).toContain("protocol.file.allow=never")
  expect(args).toContain("filter.lfs.process=")
  expect(args).toContain("http.curloptResolve=git.example.test:443:203.0.113.8")
  expect(args).toContain("http.curloptResolve=git.example.test:443:[2001:db8::8]")

  const env = Git.httpTransportEnvironment("http://127.0.0.1:49152")
  expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
  expect(env.GIT_CONFIG_COUNT).toBe("0")
  expect(env.GIT_ALLOW_PROTOCOL).toBe("https")
  expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1")
  expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:49152")
  expect(env.NO_PROXY).toBe("")
  expect(env).not.toHaveProperty("GIT_DIR")
  expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")

  const transport = { hostname: "git.example.test", port: 443, addresses: ["8.8.8.8"] }
  expect(Git.allowsHttpTransportTarget(transport, "git.example.test:443")).toBe(true)
  expect(Git.allowsHttpTransportTarget(transport, "git.example.test:8443")).toBe(false)
  expect(Git.allowsHttpTransportTarget(transport, "169.254.169.254:80")).toBe(false)
  expect(Git.allowsHttpTransportTarget(transport, "localhost:443")).toBe(false)
})

describe("Git", () => {
  it.live("ignores ambient URL rewrites for protected network clones", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const config = path.join(fixture.root, "ambient.gitconfig")
        yield* Effect.promise(() =>
          fs.writeFile(config, `[url "${fixture.remote}"]\n\tinsteadOf = https://git.example.test/repo.git\n`),
        )
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const value = process.env.GIT_CONFIG_GLOBAL
            process.env.GIT_CONFIG_GLOBAL = config
            return value
          }),
          (value) =>
            Effect.sync(() => {
              if (value === undefined) delete process.env.GIT_CONFIG_GLOBAL
              else process.env.GIT_CONFIG_GLOBAL = value
            }),
        )
        const target = AbsolutePath.make(path.join(fixture.root, "protected-checkout"))
        const git = yield* Git.Service
        const error = yield* Effect.flip(
          git.repo.clone({
            remote: "https://git.example.test/repo.git",
            directory: target,
            transport: { hostname: "git.example.test", port: 1, addresses: ["127.0.0.1"] },
          }),
        )

        expect(error).toBeInstanceOf(Git.OperationError)
        expect(error.message).not.toContain("GIT_CONFIG")
        expect(error.message).toMatch(/CONNECT|connect/i)
        expect(
          yield* Effect.promise(() =>
            fs.stat(path.join(target, "README.md")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
    ),
  )

  it.live("clones a remote and reads checkout metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        expect(yield* git.remote.get(repository)).toBe(fixture.remote)
        expect(yield* git.history.head(repository)).toBeString()
        expect(yield* git.history.branch(repository)).toBe("main")
        expect(yield* git.history.defaultRemoteBranch(repository)).toBe("main")
        expect(repository.worktree).toBe(target)
        expect(repository.gitDirectory).toBe(AbsolutePath.make(path.join(target, ".git")))
        expect(repository.commonDirectory).toBe(repository.gitDirectory)
        expect(yield* read(path.join(target, "README.md"))).toBe("one\n")
      }),
    ),
  )

  it.live("fetches, checks out, and resets remote changes", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        yield* Effect.promise(() => commit(fixture.source, "two\n", "second"))
        yield* git.sync.fetchRemotes(repository)
        yield* git.sync.resetHard(repository, "origin/main")
        expect(yield* read(path.join(target, "README.md"))).toBe("two\n")

        yield* Effect.promise(() => branch(fixture.source, "feature/docs", "feature\n"))
        yield* git.sync.fetchBranch(repository, { branch: "feature/docs" })
        yield* git.sync.checkoutRemoteBranch(repository, { branch: "feature/docs" })
        yield* git.sync.resetHard(repository, "origin/feature/docs")
        expect(yield* git.history.branch(repository)).toBe("feature/docs")
        expect(yield* read(path.join(target, "README.md"))).toBe("feature\n")
      }),
    ),
  )
})

function withRemote<A, E, R>(body: (fixture: Awaited<ReturnType<typeof gitRemote>>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      return { root, fixture: await gitRemote(root.path) }
    }),
    (input) => body(input.fixture),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replace(/\r\n/g, "\n")))
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@vector.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repo = yield* git.repo.discover(directory)
      if (!repo) throw new Error("Repository not found")

      yield* git.worktree.create({ repository: repo, directory: worktree })

      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(true)
      const linked = yield* git.repo.discover(worktree)
      expect(linked?.worktree).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(worktree))))
      expect(linked?.commonDirectory).toBe(repo.commonDirectory)
      expect(linked?.gitDirectory).not.toBe(repo.gitDirectory)
      if (!linked) throw new Error("Linked worktree not found")
      yield* git.worktree.remove({ repository: linked, directory: worktree, force: false })
      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(false)
    }),
  )
})

describe("Git trees", () => {
  it.live("captures, compares, previews, and restores scoped trees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await fs.mkdir(path.join(root.path, "scope"))
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "one\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "outside\n")
        await $`git add .`.cwd(root.path).quiet()
        await $`git commit -m initial`.cwd(root.path).quiet()
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!source) throw new Error("Repository not found")
      const storage = AbsolutePath.make(path.join(root.path, ".snapshot"))
      const repository = yield* git.repo.create({ worktree: source.worktree, gitDirectory: storage, seed: source })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const before = yield* git.tree.write(repository)

      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "two\n")
        await fs.writeFile(path.join(root.path, "scope", "added.txt"), "added\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "changed outside\n")
      })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const after = yield* git.tree.write(repository)

      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("scope/added.txt"),
        RelativePath.make("scope/tracked.txt"),
      ])
      const diffs = yield* git.tree.diff({ repository, from: before, to: after, context: 1 })
      expect(diffs.map((item) => [item.path, item.status])).toEqual([
        [RelativePath.make("scope/added.txt"), "added"],
        [RelativePath.make("scope/tracked.txt"), "modified"],
      ])

      const files = new Map([[RelativePath.make("scope/tracked.txt"), before]])
      const preview = yield* git.tree.preview({ repository, current: after, files, context: 1 })
      expect(preview).toHaveLength(1)
      expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
      yield* git.tree.restore({ repository, files })
      expect(yield* read(path.join(root.path, "scope", "tracked.txt"))).toBe("one\n")
      expect(yield* read(path.join(root.path, "scope", "added.txt"))).toBe("added\n")
      expect(yield* read(path.join(root.path, "outside.txt"))).toBe("changed outside\n")
    }),
  )
})
