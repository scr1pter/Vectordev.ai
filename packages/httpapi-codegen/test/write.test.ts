import { describe, expect } from "bun:test"
import { Effect, FileSystem, Option } from "effect"
import { write, type Output } from "../src"
import { it } from "./effect"

const fileInfo = (type: "Directory" | "File" | "SymbolicLink") => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
})

describe("HttpApiCodegen.write", () => {
  it.effect("writes compiled files beneath the output directory", () => {
    const writes: Array<{ readonly path: string; readonly content: string; readonly flag?: string }> = []
    const renames: Array<readonly [string, string]> = []
    const output: Output = {
      operations: [],
      files: [{ path: "session.ts", content: "export const session = {}" }],
    }

    return Effect.gen(function* () {
      yield* write(output, "/generated")

      expect(writes[0]).toEqual({
        path: "/generated/session.ts",
        content: "export const session = {}\n",
        flag: undefined,
      })
      expect(writes[1]?.path).toStartWith("/generated/.httpapi-codegen.json.")
      expect(writes[1]).toMatchObject({ content: '[\n  "session.ts"\n]\n', flag: "wx" })
      expect(renames).toEqual([[writes[1]?.path, "/generated/.httpapi-codegen.json"]])
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () => Effect.succeed(false),
          makeDirectory: () => Effect.void,
          rename: (from, to) => {
            renames.push([from, to])
            return Effect.void
          },
          writeFileString: (path, content, options) => {
            writes.push({ path, content, flag: options?.flag })
            return Effect.void
          },
        }),
      ),
    )
  })

  it.effect("removes only stale files owned by the previous manifest", () => {
    const removed: Array<string> = []
    return write(
      {
        operations: [],
        files: [{ path: "session.ts", content: "" }],
      },
      "/generated",
    ).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (path) => Effect.succeed(path.endsWith(".httpapi-codegen.json")),
          makeDirectory: () => Effect.void,
          readFileString: () => Effect.succeed('["old.ts", "session.ts"]'),
          remove: (path) => {
            removed.push(path)
            return Effect.void
          },
          rename: () => Effect.void,
          writeFileString: () => Effect.void,
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(removed[0]).toBe("/generated/old.ts")
          expect(removed[1]).toStartWith("/generated/.httpapi-codegen.json.")
        }),
      ),
    )
  })

  it.effect("rejects unsafe and duplicate output paths before writing", () => {
    const writes: Array<string> = []
    return Effect.gen(function* () {
      const error = yield* write(
        {
          operations: [],
          files: [
            { path: "../outside.ts", content: "" },
            { path: "client.ts", content: "" },
            { path: "CLIENT.ts", content: "" },
          ],
        },
        "/generated",
      ).pipe(Effect.flip)

      expect(error._tag).toBe("GenerationError")
      expect(writes).toEqual([])
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          writeFileString: (path) => {
            writes.push(path)
            return Effect.void
          },
        }),
      ),
    )
  })

  it.effect("rejects case-insensitive duplicate output paths", () => {
    const writes: Array<string> = []
    return Effect.gen(function* () {
      const error = yield* write(
        {
          operations: [],
          files: [
            { path: "client.ts", content: "" },
            { path: "CLIENT.ts", content: "" },
          ],
        },
        "/generated",
      ).pipe(Effect.flip)

      expect(error._tag).toBe("GenerationError")
      expect(error.reason).toBe("Duplicate output path: CLIENT.ts")
      expect(writes).toEqual([])
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          writeFileString: (path) => {
            writes.push(path)
            return Effect.void
          },
        }),
      ),
    )
  })

  it.effect("reserves the private manifest path", () =>
    write({ operations: [], files: [{ path: ".httpapi-codegen.json", content: "" }] }, "/generated").pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.reason).toContain("Unsafe output path"))),
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
    ),
  )

  it.effect("rejects existing symbolic-link output targets", () =>
    write({ operations: [], files: [{ path: "session.ts", content: "" }] }, "/generated").pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe("Unsafe output path: session.ts"))),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (path) => Effect.succeed(path.endsWith("session.ts")),
          makeDirectory: () => Effect.void,
          stat: (path) => Effect.succeed(fileInfo(path.endsWith("session.ts") ? "SymbolicLink" : "Directory")),
        }),
      ),
    ),
  )

  it.effect("rejects a symbolic-link manifest before reading or writing it", () => {
    const reads: Array<string> = []
    const writes: Array<string> = []
    return write({ operations: [], files: [] }, "/generated").pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason).toBe("Invalid generated file manifest: /generated/.httpapi-codegen.json")
          expect(reads).toEqual([])
          expect(writes).toEqual([])
        }),
      ),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          makeDirectory: () => Effect.void,
          stat: (path) =>
            Effect.succeed(fileInfo(path.endsWith(".httpapi-codegen.json") ? "SymbolicLink" : "Directory")),
          readFileString: (path) => {
            reads.push(path)
            return Effect.succeed("[]")
          },
          writeFileString: (path) => {
            writes.push(path)
            return Effect.void
          },
        }),
      ),
    )
  })
})
