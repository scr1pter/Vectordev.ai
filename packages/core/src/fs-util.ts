import { basename, dirname, isAbsolute, join, parse, relative, resolve as pathResolve, sep } from "path"
import { lstatSync, readlinkSync, realpathSync } from "fs"
import * as NFS from "fs/promises"
import { lookup } from "mime-types"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Glob } from "./util/glob"
import { serviceUse } from "./effect/service-use"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"

export namespace FSUtil {
  export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
    method: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      const detail = this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause)
      return `Filesystem operation failed: ${this.method}${detail ? `: ${detail}` : ""}`
    }
  }

  export type Error = PlatformError | FileSystemError

  export interface DirEntry {
    readonly name: string
    readonly type: "file" | "directory" | "symlink" | "other"
  }

  export interface Interface extends FileSystem.FileSystem {
    readonly isDir: (path: string) => Effect.Effect<boolean>
    readonly isFile: (path: string) => Effect.Effect<boolean>
    readonly existsSafe: (path: string) => Effect.Effect<boolean>
    readonly readFileStringSafe: (path: string) => Effect.Effect<string | undefined, Error>
    readonly readJson: (path: string) => Effect.Effect<unknown, Error>
    readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, Error>
    readonly ensureDir: (path: string) => Effect.Effect<void, Error>
    readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, Error>
    readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], Error>
    readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly up: (options: { targets: string[]; start: string; stop?: string }) => Effect.Effect<string[], Error>
    readonly globUp: (pattern: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly glob: (pattern: string, options?: Glob.Options) => Effect.Effect<string[], Error>
    readonly globMatch: (pattern: string, filepath: string) => boolean
  }

  export class Service extends Context.Service<Service, Interface>()("@vector/FileSystem") {}

  export const use = serviceUse(Service)

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const existsSafe = Effect.fn("FileSystem.existsSafe")(function* (path: string) {
        return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      })

      const readFileStringSafe = Effect.fn("FileSystem.readFileStringSafe")(function* (path: string) {
        return yield* fs
          .readFileString(path)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      })

      const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "Directory"
      })

      const isFile = Effect.fn("FileSystem.isFile")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "File"
      })

      const readDirectoryEntries = Effect.fn("FileSystem.readDirectoryEntries")(function* (dirPath: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const entries = await NFS.readdir(dirPath, { withFileTypes: true })
            return entries.map(
              (e): DirEntry => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
              }),
            )
          },
          catch: (cause) => new FileSystemError({ method: "readDirectoryEntries", cause }),
        })
      })

      const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
        const text = yield* fs.readFileString(path)
        return yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => new FileSystemError({ method: "readJson", cause }),
        })
      })

      const writeJson = Effect.fn("FileSystem.writeJson")(function* (path: string, data: unknown, mode?: number) {
        const content = JSON.stringify(data, null, 2)
        yield* fs.writeFileString(path, content)
        if (mode) yield* fs.chmod(path, mode)
      })

      const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
        yield* fs.makeDirectory(path, { recursive: true })
      })

      const writeWithDirs = Effect.fn("FileSystem.writeWithDirs")(function* (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) {
        const write = typeof content === "string" ? fs.writeFileString(path, content) : fs.writeFile(path, content)

        yield* write.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(dirname(path), { recursive: true })
                yield* write
              }),
          ),
        )
        if (mode) yield* fs.chmod(path, mode)
      })

      const glob = Effect.fn("FileSystem.glob")(function* (pattern: string, options?: Glob.Options) {
        return yield* Effect.tryPromise({
          try: () => Glob.scan(pattern, options),
          catch: (cause) => new FileSystemError({ method: "glob", cause }),
        })
      })

      const findUp = Effect.fn("FileSystem.findUp")(function* (target: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const search = join(current, target)
          if (yield* fs.exists(search)) result.push(search)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const up = Effect.fn("FileSystem.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
        const result: string[] = []
        let current = options.start
        while (true) {
          for (const target of options.targets) {
            const search = join(current, target)
            if (yield* fs.exists(search)) result.push(search)
          }
          if (options.stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const globUp = Effect.fn("FileSystem.globUp")(function* (pattern: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const matches = yield* glob(pattern, { cwd: current, absolute: true, include: "file", dot: true }).pipe(
            Effect.catch(() => Effect.succeed([] as string[])),
          )
          result.push(...matches)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      return Service.of({
        ...fs,
        existsSafe,
        readFileStringSafe,
        isDir,
        isFile,
        readDirectoryEntries,
        readJson,
        writeJson,
        ensureDir,
        writeWithDirs,
        findUp,
        up,
        globUp,
        glob,
        globMatch: Glob.match,
      })
    }),
  )

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [filesystem] })

  // Pure helpers that don't need Effect (path manipulation, sync operations)
  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    const resolved = pathResolve(windowsPath(p))
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }

  export function normalizePathPattern(p: string): string {
    if (process.platform !== "win32") return p
    if (p === "*") return p
    const match = p.match(/^(.*)[\\/]\*$/)
    if (!match) return normalizePath(p)
    const dir = /^[A-Za-z]:$/.test(match[1]) ? match[1] + "\\" : match[1]
    return join(normalizePath(dir), "*")
  }

  export function resolve(p: string): string {
    const resolved = pathResolve(windowsPath(p))
    try {
      return normalizePath(realpathSync(resolved))
    } catch (e: any) {
      if (e?.code === "ENOENT") return normalizePath(resolved)
      throw e
    }
  }

  /** Where a path really lands, following links in it and in its parents, even when the file does not exist yet. */
  export function realpath(target: string): string {
    const resolved = resolve(target)
    const link = lstatSync(resolved, { throwIfNoEntry: false })
    // A dangling symlink cannot be resolved by realpath, but writing through it
    // still lands wherever it points, so follow the link by hand.
    if (link?.isSymbolicLink()) return realpath(pathResolve(dirname(resolved), readlinkSync(resolved)))
    if (link) return resolved
    // resolve hands back the lexical path for something that does not exist
    // yet, which still looks project-local when a parent is a link pointing out of
    // the project. Resolve the deepest existing ancestor and re-attach the rest so
    // creating a file cannot escape either.
    const parent = dirname(resolved)
    if (parent === resolved) return resolved
    return join(realpath(parent), basename(resolved))
  }

  /**
   * The spelling of `file` under the first of `roots` it passes through, under any spelling of either, or undefined
   * when it passes through none. It passes through a root as written, once any directory on its way is resolved (a
   * link inside a root stays the root's wherever it points), at any link it passes through on the way (a link outside
   * to a link inside that points out again), or where it finally lands (a link from outside into a root). It comes
   * back rebased onto that root as given, so containment checks against the root agree with it. A path that cannot be
   * resolved, such as a link loop, throws.
   */
  export function within(roots: readonly string[], file: string): string | undefined {
    const requested = pathResolve(windowsPath(file))
    // As written first, which needs no file system access.
    const written = rebase(requested, roots, roots)
    if (written) return written
    const bases = roots.map((root) => realpath(root))
    return [
      ...ancestors(requested).map((parent) => join(realpath(parent), relative(parent, requested))),
      ...passes(requested),
      realpath(requested),
    ]
      .map((spelling) => rebase(spelling, roots, bases))
      .find((item) => item !== undefined)
  }

  // The spelling moved onto the first root whose form in `bases` contains it.
  function rebase(spelling: string, roots: readonly string[], bases: readonly string[]) {
    const index = bases.findIndex((base) => contains(base, spelling))
    if (index === -1) return
    return join(roots[index], relative(bases[index], spelling))
  }

  // Every link the path passes through while it resolves, one step at a time, spelled as the link's own location
  // followed by the rest of the path. Resolving whole parents at once skips the middle of a chain: a user's link to a
  // project's link that points out of the project would land outside without ever being seen inside it.
  function passes(file: string) {
    const split = (value: string) => value.split(process.platform === "win32" ? /[\\/]/ : "/")
    const start = parse(file).root
    const walk = (current: string, rest: string[], hops: number): string[] => {
      if (!rest.length) return []
      const [name, ...remaining] = rest
      if (name === "" || name === ".") return walk(current, remaining, hops)
      // `current` has no links in it, so its parent is the real one.
      if (name === "..") return walk(dirname(current), remaining, hops)
      const next = join(current, name)
      const info = lstatSync(next, { throwIfNoEntry: false })
      // Nothing below an entry that does not exist can be a link.
      if (!info) return []
      if (!info.isSymbolicLink()) return walk(next, remaining, hops)
      if (hops >= 40) throw new Error(`Too many links in ${file}`)
      // The target's own `..` is applied after its links, as the kernel does, so it is not collapsed up front.
      const target = readlinkSync(next)
      const root = isAbsolute(target) ? parse(target).root : ""
      return [
        join(normalizePath(current), name, ...remaining),
        ...walk(root || current, [...split(target.slice(root.length)), ...remaining], hops + 1),
      ]
    }
    return walk(start, split(file.slice(start.length)), 0)
  }

  // Deepest first, so the path that comes back is resolved as far as it stays inside a root.
  function ancestors(file: string): string[] {
    const parent = dirname(file)
    if (parent === file) return []
    return [parent, ...ancestors(parent)]
  }

  /**
   * Whether writing `target` changes nothing but a plain file inside `root`. Writing follows links, so a link at the
   * path is refused, as are a directory, a device, a FIFO and a file with other hard links; a path that does not
   * exist yet is fine. Where it really lands, links in its parents followed, must be inside where `root` really is.
   * Anything that cannot be resolved answers no.
   */
  export function writableInside(root: string, target: string) {
    const file = pathResolve(windowsPath(target))
    try {
      const info = lstatSync(file, { throwIfNoEntry: false })
      if (info && (!info.isFile() || info.nlink > 1)) return false
      return contains(realpath(root), realpath(file))
    } catch {
      return false
    }
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  }

  export function overlaps(a: string, b: string) {
    return contains(a, b) || contains(b, a)
  }

  export function contains(parent: string, child: string) {
    const result = relative(parent, child)
    return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`))
  }
}
