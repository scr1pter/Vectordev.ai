export * as ProjectV2 from "./project"
export * as Project from "./project"

import { Context, Effect, Layer, Schema } from "effect"
import { and, eq, ne } from "drizzle-orm"
import { lstatSync, readdirSync, readFileSync } from "fs"
import path from "path"
import { AbsolutePath } from "./schema"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { makeGlobalNode } from "./effect/app-node"
import { Hash } from "./util/hash"
import { ProjectDirectories } from "./project/directories"
import { ProjectSchema } from "./project/schema"
import { ProjectTable } from "./project/sql"
import { Database } from "./database/database"

export const ID = ProjectSchema.ID
export type ID = ProjectSchema.ID

export const Vcs = ProjectSchema.Vcs
export type Vcs = ProjectSchema.Vcs

export class Info extends Schema.Class<Info>("Project.Info")({
  id: ID,
}) {}

export const DirectoriesInput = ProjectDirectories.ListInput
export type DirectoriesInput = typeof DirectoriesInput.Type

export const Directories = ProjectDirectories.ListOutput
export type Directories = typeof Directories.Type

export interface Resolved {
  readonly previous?: ID
  readonly id: ID
  readonly directory: AbsolutePath
  readonly vcs?: Vcs
}

export interface Interface {
  readonly directories: (input: DirectoriesInput) => Effect.Effect<Directories>
  readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>
  /**
   * Temporary bridge method for writing the resolved project ID to the repo-local cache.
   *
   * This exists while the old vector project service and this core project
   * service work together: core resolves the ID, while the old service still owns
   * database migration and persistence. The old service should call this after it
   * finishes migrating from `resolve().previous` to `resolve().id`; once project
   * persistence moves into core, this separate bridge method can go away.
   */
  readonly commit: (input: { store: AbsolutePath; worktree: AbsolutePath; id: ID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ProjectV2") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const projectDirectories = yield* ProjectDirectories.Service
    const database = yield* Database.Service

    const directories = Effect.fn("Project.directories")(function* (input: DirectoriesInput) {
      return yield* projectDirectories.list(input.projectID)
    })

    const cached = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(path.join(dir, "vector", "project-id")).pipe(
        Effect.map((value) => value.trim()),
        Effect.map((value) => (value ? ID.make(value) : undefined)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    })

    const recoverCached = Effect.fnUntraced(function* (repo: Git.Repository) {
      const projects = yield* database.db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(and(eq(ProjectTable.worktree, repo.worktree), ne(ProjectTable.id, ID.global)))
        .all()
        .pipe(Effect.orDie)
      if (projects.length === 0) return undefined
      const known = new Set(projects.map((project) => project.id))
      const entries = yield* fs.readDirectoryEntries(repo.commonDirectory).pipe(Effect.orElseSucceed(() => []))
      const candidates = yield* Effect.forEach(
        entries.filter((entry) => entry.type === "file"),
        (entry) =>
          Effect.gen(function* () {
            const file = path.join(repo.commonDirectory, entry.name)
            const stat = yield* fs.stat(file)
            if (stat.size > 128) return undefined
            const value = (yield* fs.readFileString(file)).trim()
            return known.has(ID.make(value)) ? ID.make(value) : undefined
          }).pipe(Effect.orElseSucceed(() => undefined)),
      )
      const matches = candidates.filter((candidate) => candidate !== undefined)
      // File content plus the persisted worktree proves one prior identity. Never
      // merge every project at this path, or choose between ambiguous cache files.
      return matches.length === 1 ? matches[0] : undefined
    })

    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      const origin = yield* git.remote.get(repo)
      if (!origin) return undefined
      const normalized = url(origin)
      if (!normalized) return undefined
      return ID.make(Hash.fast(`git-remote:${normalized}`))
    })

    function url(input: string) {
      const value = input.trim()
      if (!value) return undefined

      try {
        const parsed = new URL(value)
        if (parsed.protocol === "file:") return undefined
        return parts(parsed.hostname, parsed.pathname)
      } catch {
        const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
        if (scp) return parts(scp[2], scp[3])
        return undefined
      }
    }

    function parts(host: string, name: string) {
      const pathname = name
        .replace(/^\/+/, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "")
      if (!host || !pathname) return undefined
      return `${host.toLowerCase()}/${pathname}`
    }

    const root = Effect.fnUntraced(function* (repo: Git.Repository) {
      const root = (yield* git.history.rootCommits(repo))[0]
      return root ? ID.make(root) : undefined
    })

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const repo = yield* git.repo.discover(input)
      if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }

      const previous = (yield* cached(repo.commonDirectory)) ?? (yield* recoverCached(repo))
      const id = (yield* remote(repo)) ?? previous ?? (yield* root(repo))
      return {
        previous,
        id: id ?? ID.global,
        directory: repo.worktree,
        vcs: { type: "git" as const, store: repo.commonDirectory },
      }
    })

    const commit = Effect.fn("Project.commit")(function* (input: {
      store: AbsolutePath
      worktree: AbsolutePath
      id: ID
    }) {
      const file = path.join(input.store, "vector", "project-id")
      // This runs when a repository is opened, before trust, and writing follows links: a downloaded repository can carry
      // its .git/vector as a link to any folder of the user's, or its .git as a link or a gitdir file naming another
      // repository's store.
      if (!ownStore(input.store, input.worktree)) return
      if (!FSUtil.writableInside(input.store, file)) return
      yield* fs.writeWithDirs(file, input.id).pipe(Effect.ignore)
    })

    return Service.of({ directories, resolve, commit })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, ProjectDirectories.node, Database.node],
})

// Whether a store is the work tree's own: inside it, or the shared store of a linked worktree whose registration there
// points back at this work tree's .git file. A repository cannot write that registration into a store it does not own.
function ownStore(store: string, worktree: string) {
  try {
    if (FSUtil.contains(FSUtil.realpath(worktree), FSUtil.realpath(store))) return true
    const dotgit = path.join(worktree, ".git")
    if (!lstatSync(dotgit, { throwIfNoEntry: false })?.isFile()) return false
    const registered = path.join(store, "worktrees")
    return readdirSync(registered).some((name) => {
      const file = path.join(registered, name, "gitdir")
      if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return false
      const back = path.resolve(registered, name, readFileSync(file, "utf8").trim())
      return path.relative(FSUtil.realpath(back), FSUtil.realpath(dotgit)) === ""
    })
  } catch {
    return false
  }
}
